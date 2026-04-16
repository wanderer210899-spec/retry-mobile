import { payloadHasRequiredKeys, clonePayload, getContext, getCurrentChatArray, getEventTypes, getChatIdentity, getUserMessageIndexFromEvent, subscribeEvent } from './st-context.js';
import { buildFingerprint, isSameChat, normalizeRequestType } from './st-chat.js';
import { createStructuredError } from './retry-error.js';

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
            if (closed) {
                return;
            }

            const liveIdentity = getChatIdentity(getContext());
            if (!isSameChat(chatIdentity, liveIdentity)) {
                return;
            }

            const requestType = normalizeRequestType(payload?.type);
            if (requestType === 'continue') {
                onEvent?.('CHAT_COMPLETION_SETTINGS_READY', 'Ignored continue request while armed.');
                return;
            }

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

            const chat = getCurrentChatArray(getContext());
            const fingerprint = buildFingerprint({
                chatIdentity,
                chat,
                requestType,
                messageIdHint,
            });
            if (!fingerprint) {
                close();
                onCapture?.({
                    ok: false,
                    error: createStructuredError(
                        'native_turn_mismatch',
                        'Retry Mobile could not confirm which user turn this generation belongs to.',
                    ),
                });
                return;
            }

            close();
            onCapture?.({
                ok: true,
                capturedRequest: clonePayload(payload),
                fingerprint,
                requestType,
            });
        }, context),
        subscribeEvent(eventTypes.CHAT_CHANGED, () => {
            if (closed) {
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

