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
    let activeChatIdentity = cloneChatIdentity(chatIdentity);
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

    if (eventTypes.CHAT_COMPLETION_SETTINGS_READY) {
        stopListening.push(
            subscribeEvent(eventTypes.CHAT_COMPLETION_SETTINGS_READY, (payload) => {
                void handleCapturePayload(payload, 'CHAT_COMPLETION_SETTINGS_READY');
            }, context),
        );
    }

    if (eventTypes.TEXT_COMPLETION_SETTINGS_READY) {
        stopListening.push(
            subscribeEvent(eventTypes.TEXT_COMPLETION_SETTINGS_READY, (payload) => {
                void handleCapturePayload(payload, 'TEXT_COMPLETION_SETTINGS_READY');
            }, context),
        );
    }

    if (eventTypes.GENERATE_AFTER_DATA) {
        stopListening.push(
            subscribeEvent(eventTypes.GENERATE_AFTER_DATA, (payload) => {
                void handleCapturePayload(payload, 'GENERATE_AFTER_DATA');
            }, context),
        );
    }

    stopListening.push(
        subscribeEvent(eventTypes.CHAT_CHANGED, () => {
            if (closed) {
                return;
            }

            const liveIdentity = getChatIdentity(getContext());
            const alignedIdentity = resolveCaptureChatIdentity(activeChatIdentity, liveIdentity, {
                liveChat: getCurrentChatArray(getContext()),
            });
            if (alignedIdentity && wasInternalChatReloadRecentlyTriggered(alignedIdentity)) {
                activeChatIdentity = alignedIdentity;
                onEvent?.('CHAT_CHANGED_IGNORED', 'Ignored CHAT_CHANGED triggered by Retry Mobile refreshing the current chat.');
                return;
            }

            if (alignedIdentity) {
                activeChatIdentity = alignedIdentity;
                onEvent?.('CHAT_CHANGED_IGNORED', 'Ignored CHAT_CHANGED while the armed chat was stabilizing its saved identity.');
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

    async function handleCapturePayload(payload, sourceEventName = 'CHAT_COMPLETION_SETTINGS_READY') {
        if (closed || capturePending) {
            return;
        }

        const liveIdentity = getChatIdentity(getContext());
        const alignedIdentity = resolveCaptureChatIdentity(activeChatIdentity, liveIdentity, {
            liveChat: getCurrentChatArray(getContext()),
        });
        if (!alignedIdentity) {
            return;
        }
        activeChatIdentity = alignedIdentity;

        // SillyTavern emits CHAT_COMPLETION_SETTINGS_READY for dry-run prompt probes too.
        // Those probes are diagnostics/capability checks, not real user sends, so they
        // must not consume the armed capture subscription.
        if (payload?.dryRun === true) {
            onEvent?.(sourceEventName, 'Ignored dry-run request while armed.');
            return;
        }

        const requestType = normalizeRequestType(payload?.type);
        if (requestType === 'continue') {
            onEvent?.(sourceEventName, 'Ignored continue request while armed.');
            return;
        }

        if (!payloadHasRequiredKeys(payload)) {
            if (sourceEventName === 'GENERATE_AFTER_DATA') {
                onEvent?.(sourceEventName, 'Ignored fallback payload without required keys while armed.');
                return;
            }
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
                chatIdentity: activeChatIdentity,
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

function resolveCaptureChatIdentity(expectedIdentity, liveIdentity, options = {}) {
    if (!expectedIdentity || !liveIdentity) {
        return null;
    }

    if (isSameChat(expectedIdentity, liveIdentity)) {
        return cloneChatIdentity(liveIdentity);
    }

    const sameKind = String(expectedIdentity.kind || '') === String(liveIdentity.kind || '');
    const sameGroup = String(expectedIdentity.groupId || '') === String(liveIdentity.groupId || '');
    if (!sameKind || !sameGroup) {
        return null;
    }

    const expectedChatId = String(expectedIdentity.chatId || '').trim();
    const liveChatId = String(liveIdentity.chatId || '').trim();
    if (expectedChatId && liveChatId && expectedChatId !== liveChatId) {
        return isFreshSameCharacterChat(liveIdentity, options.liveChat)
            && hasSameCharacterIdentity(expectedIdentity, liveIdentity)
            ? cloneChatIdentity(liveIdentity)
            : null;
    }

    if (!isProvisionalCaptureIdentity(expectedIdentity, liveIdentity)) {
        return null;
    }

    return cloneChatIdentity(liveIdentity);
}

function isProvisionalCaptureIdentity(expectedIdentity, liveIdentity) {
    const expectedChatId = String(expectedIdentity?.chatId || '').trim();
    const liveChatId = String(liveIdentity?.chatId || '').trim();
    if (expectedChatId && liveChatId) {
        return false;
    }

    const expectedAvatar = String(expectedIdentity?.avatarUrl || '').trim();
    const liveAvatar = String(liveIdentity?.avatarUrl || '').trim();
    if (expectedAvatar && liveAvatar) {
        return expectedAvatar === liveAvatar;
    }

    const expectedAssistant = String(expectedIdentity?.assistantName || '').trim();
    const liveAssistant = String(liveIdentity?.assistantName || '').trim();
    return Boolean(expectedAssistant) && expectedAssistant === liveAssistant;
}

function isFreshSameCharacterChat(liveIdentity, liveChat) {
    if (String(liveIdentity?.kind || '') !== 'character') {
        return false;
    }

    if (!Array.isArray(liveChat)) {
        return false;
    }

    return liveChat.length === 0
        || (liveChat.length === 1 && liveChat[0]?.is_user === true);
}

function hasSameCharacterIdentity(expectedIdentity, liveIdentity) {
    const expectedAvatar = String(expectedIdentity?.avatarUrl || '').trim();
    const liveAvatar = String(liveIdentity?.avatarUrl || '').trim();
    if (expectedAvatar && liveAvatar && expectedAvatar === liveAvatar) {
        return true;
    }

    const expectedAssistant = String(expectedIdentity?.assistantName || '').trim();
    const liveAssistant = String(liveIdentity?.assistantName || '').trim();
    return Boolean(expectedAssistant) && expectedAssistant === liveAssistant;
}

function cloneChatIdentity(chatIdentity) {
    if (!chatIdentity) {
        return null;
    }

    return {
        kind: String(chatIdentity.kind || ''),
        chatId: String(chatIdentity.chatId || ''),
        fileName: String(chatIdentity.fileName || chatIdentity.chatId || ''),
        groupId: chatIdentity.groupId == null ? null : String(chatIdentity.groupId),
        avatarUrl: String(chatIdentity.avatarUrl || ''),
        assistantName: String(chatIdentity.assistantName || ''),
    };
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
