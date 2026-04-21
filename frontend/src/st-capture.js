import { payloadHasRequiredKeys, clonePayload, getContext, getCurrentChatArray, getEventTypes, getChatIdentity, getUserMessageIndexFromEvent, subscribeEvent } from './st-context.js';
import { buildFingerprint, isSameChat, normalizeRequestType, wasInternalChatReloadRecentlyTriggered } from './st-chat.js';
import { createStructuredError } from './retry-error.js';

const FRESH_SEND_HINT_WAIT_MS = 1600;
const FRESH_SEND_HINT_POLL_MS = 50;

export function createArmCaptureSession({
    chatIdentity,
    onCapture,
    onCancel,
    onEvent,
}) {
    const context = getContext();
    const eventTypes = getEventTypes(context);
    const stopListening = [];
    let messageIdHint = null;
    let capturePending = false;
    let closed = false;

    if (eventTypes.MESSAGE_SENT) {
        stopListening.push(
            subscribeEvent(eventTypes.MESSAGE_SENT, (messageId) => {
                messageIdHint = getUserMessageIndexFromEvent(messageId);
                onEvent?.('MESSAGE_SENT', `Captured user-message hint ${messageIdHint ?? 'unknown'}.`);
            }, context),
        );
    }

    stopListening.push(
        subscribeEvent(eventTypes.CHAT_COMPLETION_SETTINGS_READY, (payload) => {
            void handleCapturePayload(payload);
        }, context),
        subscribeEvent(eventTypes.CHAT_CHANGED, () => {
            if (closed) {
                return;
            }

            const liveIdentity = getChatIdentity(getContext());
            if (isSameChat(chatIdentity, liveIdentity) && wasInternalChatReloadRecentlyTriggered(liveIdentity)) {
                onEvent?.('CHAT_CHANGED_IGNORED', 'Ignored CHAT_CHANGED triggered by Retry Mobile refreshing the current chat.');
                return;
            }

            close();
            onCancel?.(createStructuredError(
                'capture_chat_changed',
                'Retry Mobile disarmed because the active chat changed before capture completed.',
            ));
        }, context),
        subscribeEvent(eventTypes.CHAT_DELETED, () => {
            if (closed) {
                return;
            }

            close();
            onCancel?.(createStructuredError(
                'capture_chat_changed',
                'Retry Mobile stopped because the active chat was deleted before capture completed.',
            ));
        }, context),
    );

    return {
        stop: close,
    };

    async function handleCapturePayload(payload) {
        if (closed || capturePending) {
            return;
        }

        const liveIdentity = getChatIdentity(getContext());
        if (!isSameChat(chatIdentity, liveIdentity)) {
            return;
        }

        // SillyTavern emits CHAT_COMPLETION_SETTINGS_READY for dry-run prompt probes too.
        // Those probes are diagnostics/capability checks, not real user sends, so they
        // must not consume the armed capture subscription.
        if (payload?.dryRun === true) {
            onEvent?.('CHAT_COMPLETION_SETTINGS_READY', 'Ignored dry-run request while armed.');
            return;
        }

        const requestType = normalizeRequestType(payload?.type);
        if (requestType === 'continue') {
            onEvent?.('CHAT_COMPLETION_SETTINGS_READY', 'Ignored continue request while armed.');
            return;
        }

        capturePending = true;
        try {
            if (!payloadHasRequiredKeys(payload)) {
                close();
                onCapture?.({
                    ok: false,
                    error: createStructuredError(
                        'capture_missing_payload',
                        'Retry Mobile captured a generation request that was missing required keys.',
                    ),
                });
                return;
            }

            const captureResult = await resolveCaptureFingerprint({
                chatIdentity,
                requestType,
                messageIdHint,
                onEvent,
                isClosed: () => closed,
            });
            if (closed) {
                return;
            }

            if (!captureResult.ok) {
                close();
                onCapture?.({
                    ok: false,
                    error: captureResult.error,
                });
                return;
            }

            close();
            onCapture?.({
                ok: true,
                capturedRequest: clonePayload(payload),
                fingerprint: captureResult.fingerprint,
                requestType,
            });
        } finally {
            if (!closed) {
                capturePending = false;
            }
        }
    }

    function close() {
        if (closed) {
            return;
        }

        closed = true;
        stopListening.splice(0).forEach((stop) => {
            try {
                stop();
            } catch {}
        });
    }
}

async function resolveCaptureFingerprint({
    chatIdentity,
    requestType,
    messageIdHint,
    onEvent,
    isClosed,
}) {
    const immediate = buildCurrentFingerprint(chatIdentity, requestType, messageIdHint);
    if (!shouldAwaitHintedFreshSend(requestType, messageIdHint, immediate)) {
        return immediate
            ? { ok: true, fingerprint: immediate }
            : {
                ok: false,
                error: createStructuredError(
                    'native_turn_mismatch',
                    'Retry Mobile could not confirm which user turn this generation belongs to.',
                ),
            };
    }

    onEvent?.(
        'CAPTURE_WAITING_FOR_USER_ROW',
        `Waiting for fresh user row ${messageIdHint} to become readable before capture.`,
    );

    const deadline = Date.now() + FRESH_SEND_HINT_WAIT_MS;
    while (!isClosed() && Date.now() < deadline) {
        await delay(FRESH_SEND_HINT_POLL_MS);
        if (isClosed()) {
            break;
        }

        const liveIdentity = getChatIdentity(getContext());
        if (!isSameChat(chatIdentity, liveIdentity)) {
            return {
                ok: false,
                error: createStructuredError(
                    'capture_chat_changed',
                    'Retry Mobile disarmed because the active chat changed before capture completed.',
                ),
            };
        }

        const fingerprint = buildCurrentFingerprint(chatIdentity, requestType, messageIdHint);
        if (fingerprint?.userIndexAtCapture === messageIdHint) {
            onEvent?.(
                'CAPTURE_USER_ROW_READY',
                `Fresh user row ${messageIdHint} became readable; continuing capture.`,
            );
            return {
                ok: true,
                fingerprint,
            };
        }
    }

    return {
        ok: false,
        error: createStructuredError(
            'native_turn_mismatch',
            'Retry Mobile saw a fresh-send hint, but the new user turn never became readable before capture timed out.',
            `messageIdHint=${messageIdHint}`,
        ),
    };
}

function buildCurrentFingerprint(chatIdentity, requestType, messageIdHint) {
    const chat = getCurrentChatArray(getContext());
    return buildFingerprint({
        chatIdentity,
        chat,
        requestType,
        messageIdHint,
    });
}

function shouldAwaitHintedFreshSend(requestType, messageIdHint, fingerprint) {
    if (!Number.isInteger(messageIdHint) || messageIdHint < 0) {
        return false;
    }

    if (requestType === 'swipe' || requestType === 'regenerate') {
        return false;
    }

    return fingerprint?.userIndexAtCapture !== messageIdHint;
}

function delay(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
}
