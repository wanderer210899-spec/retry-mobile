import {
    NATIVE_CONFIRM_POLL_MS,
    NATIVE_CONFIRM_TIMEOUT_MS,
    NATIVE_WAIT_PROGRESS_TIMEOUT_MS,
    NATIVE_WAIT_RENDERED_WITHOUT_END_TIMEOUT_MS,
    NATIVE_WAIT_TIMEOUT_MS,
} from './constants.js';
import { getContext, getEventTypes, subscribeEvent } from './st-context.js';
import { confirmTargetTurn } from './st-chat.js';
import { createStructuredError } from './retry-error.js';

export function waitForNativeCompletion({
    chatIdentity,
    fingerprint,
    timeoutMs = NATIVE_WAIT_TIMEOUT_MS,
    onEvent,
}) {
    return new Promise((resolve, reject) => {
        const context = getContext();
        const eventTypes = getEventTypes(context);
        const stopListening = [];
        let settled = false;
        let confirming = false;
        let timeoutHandle = 0;
        let progressTimeoutHandle = 0;
        let renderedWithoutEndHandle = 0;
        let lastEndedMessageId = null;
        let lastRenderedMessageId = null;
        let lastRenderedType = '';
        let lastRenderedSummary = '';

        if (!eventTypes.GENERATION_ENDED) {
            reject(createStructuredError(
                'native_wait_timeout',
                'Retry Mobile could not subscribe to SillyTavern generation completion events.',
            ));
            return;
        }

        stopListening.push(
            subscribeEvent(eventTypes.GENERATION_ENDED, (messageId) => {
                lastEndedMessageId = normalizeMessageId(messageId);
                clearProgressTimeout();
                clearRenderedWithoutEndTimeout();
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
                    clearProgressTimeout();
                    armRenderedWithoutEndTimeout();
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
            fail(createStructuredError(
                'native_wait_timeout',
                'Retry Mobile timed out while waiting for SillyTavern to finish the captured reply.',
                lastEndedMessageId == null
                    ? ''
                    : `The last native completion event pointed at message ${lastEndedMessageId}. ${lastRenderedSummary}`.trim(),
            ));
        }, timeoutMs);
        progressTimeoutHandle = window.setTimeout(() => {
            fail(createStructuredError(
                'native_wait_stalled',
                'Retry Mobile captured the request, but SillyTavern never reported native completion progress.',
                describeObservedEvents() || 'No native lifecycle events arrived after capture.',
            ));
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
                        settled = true;
                        cleanup();
                        resolve({
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
            clearRenderedWithoutEndTimeout();

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

        function armRenderedWithoutEndTimeout() {
            if (lastEndedMessageId != null) {
                clearRenderedWithoutEndTimeout();
                return;
            }

            clearRenderedWithoutEndTimeout();
            renderedWithoutEndHandle = window.setTimeout(() => {
                if (lastEndedMessageId != null) {
                    return;
                }

                fail(createStructuredError(
                    'native_wait_stalled',
                    'Retry Mobile saw the native assistant render, but SillyTavern never emitted the matching completion event.',
                    describeObservedEvents() || lastRenderedSummary,
                ));
            }, Math.min(timeoutMs, NATIVE_WAIT_RENDERED_WITHOUT_END_TIMEOUT_MS));
        }

        function clearRenderedWithoutEndTimeout() {
            if (!renderedWithoutEndHandle) {
                return;
            }

            window.clearTimeout(renderedWithoutEndHandle);
            renderedWithoutEndHandle = 0;
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
