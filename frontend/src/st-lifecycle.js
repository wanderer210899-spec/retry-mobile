import {
    NATIVE_CONFIRM_POLL_MS,
    NATIVE_CONFIRM_TIMEOUT_MS,
    NATIVE_HIDDEN_DEBOUNCE_MS,
    NATIVE_VISIBLE_PROGRESS_POLL_MS,
    NATIVE_WAIT_PROGRESS_TIMEOUT_MS,
    NATIVE_WAIT_TIMEOUT_MS,
} from './constants.js';
import { getChatIdentity, getContext, getCurrentChatArray, getEventTypes, subscribeEvent } from './st-context.js';
import { confirmTargetTurn, isSameChat, wasInternalChatReloadRecentlyTriggered } from './st-chat.js';
import { createStructuredError } from './retry-error.js';

export function waitForNativeCompletion({
    fingerprint,
    timeoutMs = NATIVE_WAIT_TIMEOUT_MS,
    nativeGraceSeconds = 30,
    onEvent,
    signal,
}) {
    return new Promise((resolve, reject) => {
        const context = getContext();
        const eventTypes = getEventTypes(context);
        const stopListening = [];
        let settled = false;

        if (signal?.aborted) {
            resolve({ outcome: 'aborted' });
            return;
        }
        let confirming = false;
        let timeoutHandle = 0;
        let progressTimeoutHandle = 0;
        let hiddenTimeoutHandle = 0;
        let visibleProgressHandle = 0;
        let lastEndedMessageId = null;
        let lastRenderedMessageId = null;
        let lastRenderedType = '';
        let lastRenderedSummary = '';
        let lastVisibleProgressSignature = '';
        let lastVisibleProgressAt = 0;

        if (!eventTypes.GENERATION_ENDED) {
            reject(createStructuredError(
                'native_wait_timeout',
                'Retry Mobile could not subscribe to SillyTavern generation completion events.',
            ));
            return;
        }

        if (signal) {
            const onAbort = () => {
                if (settled) return;
                settled = true;
                cleanup();
                resolve({ outcome: 'aborted' });
            };
            signal.addEventListener('abort', onAbort, { once: true });
            stopListening.push(() => signal.removeEventListener('abort', onAbort));
        }

        document.addEventListener('visibilitychange', onVisibilityChange);

        stopListening.push(
            subscribeEvent(eventTypes.GENERATION_ENDED, (messageId) => {
                lastEndedMessageId = normalizeMessageId(messageId);
                clearProgressTimeout();
                clearVisibleProgressPoll();
                onEvent?.('GENERATION_ENDED', `SillyTavern reported native completion for message ${lastEndedMessageId}.`);
                void confirmFromObservedEvents();
            }, context),
        );

        if (eventTypes.CHARACTER_MESSAGE_RENDERED) {
            stopListening.push(
                subscribeEvent(eventTypes.CHARACTER_MESSAGE_RENDERED, (messageId, type) => {
                    lastRenderedMessageId = normalizeMessageId(messageId);
                    lastRenderedType = String(type || '');
                    lastRenderedSummary = `Rendered assistant message ${messageId} (${type || 'unknown'}).`;
                    lastVisibleProgressAt = Date.now();
                    lastVisibleProgressSignature = readMessageProgressSignature(lastRenderedMessageId);
                    clearProgressTimeout();
                    armVisibleProgressPoll();
                    onEvent?.('CHARACTER_MESSAGE_RENDERED', lastRenderedSummary);
                    if (lastEndedMessageId != null) {
                        void confirmFromObservedEvents();
                    }
                }, context),
            );
        }

        if (eventTypes.GENERATION_STOPPED) {
            stopListening.push(
                subscribeEvent(eventTypes.GENERATION_STOPPED, () => {
                    fail(createStructuredError(
                        'native_generation_stopped',
                        'Retry Mobile stopped because SillyTavern stopped the native generation before handoff.',
                    ));
                }, context),
            );
        }

        if (eventTypes.CHAT_CHANGED) {
            stopListening.push(
                subscribeEvent(eventTypes.CHAT_CHANGED, () => {
                    const liveIdentity = getChatIdentity(getContext());
                    if (isSameChat(fingerprint?.chatIdentity, liveIdentity) && wasInternalChatReloadRecentlyTriggered(liveIdentity)) {
                        onEvent?.('CHAT_CHANGED_IGNORED', 'Ignored CHAT_CHANGED triggered by Retry Mobile refreshing the current chat.');
                        return;
                    }

                    fail(createStructuredError(
                        'capture_chat_changed',
                        'Retry Mobile stopped because the active chat changed before native completion was confirmed.',
                    ));
                }, context),
            );
        }

        if (eventTypes.CHAT_DELETED) {
            stopListening.push(
                subscribeEvent(eventTypes.CHAT_DELETED, () => {
                    fail(createStructuredError(
                        'capture_chat_changed',
                        'Retry Mobile stopped because the active chat was deleted before native completion was confirmed.',
                    ));
                }, context),
            );
        }

        timeoutHandle = window.setTimeout(() => {
            settleFailed(
                'native_wait_timeout',
                'Retry Mobile timed out while waiting for SillyTavern to finish the captured reply.',
                lastEndedMessageId == null
                    ? ''
                    : `The last native completion event pointed at message ${lastEndedMessageId}. ${lastRenderedSummary}`.trim(),
            );
        }, timeoutMs);

        progressTimeoutHandle = window.setTimeout(() => {
            settleFailed(
                'native_wait_stalled',
                'Retry Mobile captured the request, but SillyTavern never reported native completion progress.',
                describeObservedEvents() || 'No native lifecycle events arrived after capture.',
            );
        }, Math.min(timeoutMs, NATIVE_WAIT_PROGRESS_TIMEOUT_MS));

        async function confirmFromObservedEvents() {
            if (settled || confirming || lastEndedMessageId == null) {
                return;
            }

            confirming = true;
            const startedAt = Date.now();
            try {
                while (!settled && Date.now() - startedAt < NATIVE_CONFIRM_TIMEOUT_MS) {
                    const attempt = confirmAgainstObservedCandidates();
                    if (attempt.kind === 'resolved') {
                        settleSucceeded({
                            assistantMessageIndex: attempt.confirmation.assistantMessageIndex,
                            assistantMessage: attempt.confirmation.assistantMessage,
                            acceptedSeedCount: attempt.confirmation.acceptedSeedCount,
                        });
                        return;
                    }

                    if (attempt.kind === 'wait') {
                        await delay(NATIVE_CONFIRM_POLL_MS);
                        continue;
                    }

                    fail(attempt.error || createStructuredError(
                        'native_turn_mismatch',
                        'Retry Mobile could not map the native completion event back to the captured turn.',
                        describeObservedEvents(),
                    ));
                    return;
                }

                fail(createStructuredError(
                    'native_turn_mismatch',
                    'Retry Mobile saw the native completion event, but the confirmed assistant turn never became readable in the live chat.',
                    describeObservedEvents(),
                ));
            } finally {
                confirming = false;
            }
        }

        function confirmAgainstObservedCandidates() {
            const candidates = getObservedCandidates();
            let shouldWait = false;
            let failure = null;

            for (const candidate of candidates) {
                const confirmation = confirmTargetTurn(fingerprint, candidate.messageId);
                if (confirmation.ok) {
                    return {
                        kind: 'resolved',
                        confirmation,
                        candidate,
                    };
                }

                if (confirmation.reason === 'assistant_missing') {
                    shouldWait = true;
                    continue;
                }

                failure = enrichConfirmationError(confirmation.error, candidate);
            }

            if (shouldWait || candidates.length === 0) {
                return { kind: 'wait' };
            }

            return {
                kind: 'fail',
                error: failure || createStructuredError(
                    'native_turn_mismatch',
                    'Retry Mobile could not map the native completion event back to the captured turn.',
                    describeObservedEvents(),
                ),
            };
        }

        function getObservedCandidates() {
            const candidates = [];
            if (lastRenderedMessageId != null) {
                candidates.push({
                    messageId: lastRenderedMessageId,
                    source: 'CHARACTER_MESSAGE_RENDERED',
                    detail: lastRenderedSummary,
                });
            }

            if (lastEndedMessageId != null && lastEndedMessageId !== lastRenderedMessageId) {
                candidates.push({
                    messageId: lastEndedMessageId,
                    source: 'GENERATION_ENDED',
                    detail: `SillyTavern reported native completion for message ${lastEndedMessageId}.`,
                });
            }

            return candidates;
        }

        function describeObservedEvents() {
            const details = [];
            if (lastEndedMessageId != null) {
                details.push(`GENERATION_ENDED=${lastEndedMessageId}`);
            }

            if (lastRenderedMessageId != null) {
                details.push(
                    lastRenderedType
                        ? `CHARACTER_MESSAGE_RENDERED=${lastRenderedMessageId} (${lastRenderedType})`
                        : `CHARACTER_MESSAGE_RENDERED=${lastRenderedMessageId}`,
                );
            }

            return details.join('; ');
        }

        function enrichConfirmationError(error, candidate) {
            if (!error) {
                return null;
            }

            const observed = describeObservedEvents();
            const detailParts = [
                `Candidate ${candidate.source}=${candidate.messageId}`,
                observed,
            ].filter(Boolean);

            return createStructuredError(
                error.code,
                error.message,
                detailParts.join('; '),
            );
        }

        function onVisibilityChange() {
            if (document.visibilityState === 'hidden') {
                armHiddenTimeout();
                return;
            }

            clearHiddenTimeout();
            if (lastRenderedMessageId != null && lastEndedMessageId == null) {
                armVisibleProgressPoll();
            }
        }

        function armHiddenTimeout() {
            if (hiddenTimeoutHandle) {
                return;
            }

            hiddenTimeoutHandle = window.setTimeout(() => {
                if (document.visibilityState !== 'hidden') {
                    return;
                }

                settleFailed(
                    'hidden_timeout',
                    'Retry Mobile stopped waiting for native completion because the browser remained hidden during native completion.',
                    describeObservedEvents() || 'The tab remained hidden for more than the debounce window while native completion was pending.',
                );
            }, Math.min(timeoutMs, NATIVE_HIDDEN_DEBOUNCE_MS));
        }

        function clearHiddenTimeout() {
            if (!hiddenTimeoutHandle) {
                return;
            }

            window.clearTimeout(hiddenTimeoutHandle);
            hiddenTimeoutHandle = 0;
        }

        function settleSucceeded(payload) {
            if (settled) {
                return;
            }

            settled = true;
            cleanup();
            resolve({
                outcome: 'succeeded',
                ...payload,
            });
        }

        function settleFailed(reason, message, detail = '') {
            if (settled) {
                return;
            }

            settled = true;
            cleanup();
            resolve({
                outcome: 'failed',
                reason,
                message,
                detail,
            });
        }

        function fail(error) {
            if (settled) {
                return;
            }

            settled = true;
            cleanup();
            reject(error);
        }

        function cleanup() {
            if (timeoutHandle) {
                window.clearTimeout(timeoutHandle);
                timeoutHandle = 0;
            }

            clearProgressTimeout();
            clearVisibleProgressPoll();
            clearHiddenTimeout();
            document.removeEventListener('visibilitychange', onVisibilityChange);

            stopListening.splice(0).forEach((stop) => {
                try {
                    stop();
                } catch {}
            });
        }

        function clearProgressTimeout() {
            if (!progressTimeoutHandle) {
                return;
            }

            window.clearTimeout(progressTimeoutHandle);
            progressTimeoutHandle = 0;
        }

        function armVisibleProgressPoll() {
            if (document.visibilityState === 'hidden' || lastRenderedMessageId == null || lastEndedMessageId != null) {
                clearVisibleProgressPoll();
                return;
            }

            if (!lastVisibleProgressAt) {
                lastVisibleProgressAt = Date.now();
                lastVisibleProgressSignature = readMessageProgressSignature(lastRenderedMessageId);
            }

            if (visibleProgressHandle) {
                return;
            }

            visibleProgressHandle = window.setInterval(() => {
                if (lastEndedMessageId != null || lastRenderedMessageId == null) {
                    clearVisibleProgressPoll();
                    return;
                }

                const nextSignature = readMessageProgressSignature(lastRenderedMessageId);
                if (nextSignature && nextSignature !== lastVisibleProgressSignature) {
                    lastVisibleProgressSignature = nextSignature;
                    lastVisibleProgressAt = Date.now();
                    return;
                }

                if (!lastVisibleProgressAt) {
                    lastVisibleProgressAt = Date.now();
                    return;
                }

                if ((Date.now() - lastVisibleProgressAt) >= (Math.max(10, Number(nativeGraceSeconds) || 30) * 1000)) {
                    settleFailed(
                        'rendered_without_end',
                        'Retry Mobile saw the native assistant render, but SillyTavern stopped making visible progress before the completion event arrived.',
                        describeObservedEvents() || lastRenderedSummary,
                    );
                }
            }, NATIVE_VISIBLE_PROGRESS_POLL_MS);
        }

        function clearVisibleProgressPoll() {
            if (!visibleProgressHandle) {
                return;
            }

            window.clearInterval(visibleProgressHandle);
            visibleProgressHandle = 0;
        }
    });
}

function delay(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function normalizeMessageId(messageId) {
    const numeric = Number.isInteger(messageId) ? messageId : Number(messageId);
    return Number.isFinite(numeric)
        ? numeric
        : null;
}

function readMessageProgressSignature(messageId) {
    const chat = getCurrentChatArray(getContext());
    const message = Array.isArray(chat) && Number.isFinite(messageId)
        ? chat[messageId]
        : null;
    if (!message || typeof message !== 'object') {
        return '';
    }

    const swipeCount = Array.isArray(message.swipes) ? message.swipes.length : 0;
    const swipeId = Number.isFinite(Number(message.swipe_id)) ? Number(message.swipe_id) : -1;
    const mesLen = String(message.mes || '').length;
    return `${mesLen}/${swipeCount}/${swipeId}`;
}
