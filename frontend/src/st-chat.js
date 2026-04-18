import { getChatIdentity, getContext, getCurrentChatArray } from './st-context.js';
import { createStructuredError } from './retry-error.js';

const INTERNAL_CHAT_RELOAD_GRACE_MS = 1500;

let internalChatReloadState = {
    at: 0,
    chatIdentity: null,
};

export function normalizeRequestType(value) {
    return typeof value === 'string'
        ? value.trim().toLowerCase()
        : '';
}

export function isSameChat(left, right) {
    return String(left?.kind || '') === String(right?.kind || '')
        && String(left?.chatId || '') === String(right?.chatId || '')
        && String(left?.groupId || '') === String(right?.groupId || '');
}

export function buildFingerprint({ chatIdentity, chat, requestType, messageIdHint = null }) {
    if (!Array.isArray(chat) || chat.length === 0) {
        return null;
    }

    const type = normalizeRequestType(requestType);
    let userMessageIndex = -1;

    if ((type === 'swipe' || type === 'regenerate') && Number.isInteger(messageIdHint) && messageIdHint > 0) {
        userMessageIndex = chat[messageIdHint - 1]?.is_user === true
            ? messageIdHint - 1
            : -1;
    }

    if (userMessageIndex < 0 && type !== 'swipe' && type !== 'regenerate' && Number.isInteger(messageIdHint) && messageIdHint >= 0) {
        if (chat[messageIdHint]?.is_user === true) {
            userMessageIndex = messageIdHint;
        }
    }

    if (userMessageIndex < 0 && (type === 'swipe' || type === 'regenerate')) {
        for (let i = chat.length - 1; i >= 0; i--) {
            if (chat[i]?.is_user === true) {
                userMessageIndex = i;
                break;
            }
        }
    }

    if (userMessageIndex < 0) {
        const lastIndex = chat.length - 1;
        if (chat[lastIndex]?.is_user === true) {
            userMessageIndex = lastIndex;
        }
    }

    if (userMessageIndex < 0) {
        return null;
    }

    const targetMessage = chat[userMessageIndex];
    if (!targetMessage || targetMessage.is_user !== true) {
        return null;
    }

    return {
        chatIdentity,
        userMessageIndex,
        userMessageText: String(targetMessage.mes ?? ''),
        capturedAt: new Date().toISOString(),
        requestType: type,
        messageIdHint: Number.isInteger(messageIdHint) ? messageIdHint : null,
    };
}

export function confirmTargetTurn(fingerprint, assistantMessageIndex) {
    const context = getContext();
    const liveIdentity = getChatIdentity(context);
    if (!fingerprint || !isSameChat(fingerprint.chatIdentity, liveIdentity)) {
        return {
            ok: false,
            reason: 'chat_changed',
            error: createStructuredError(
                'capture_chat_changed',
                'The active chat changed before Retry Mobile could attach to the native turn.',
            ),
        };
    }

    const chat = getCurrentChatArray(context);
    const userIndex = Number(fingerprint.userMessageIndex);
    const userMessage = chat[userIndex];
    if (!userMessage || userMessage.is_user !== true || String(userMessage.mes ?? '') !== fingerprint.userMessageText) {
        return {
            ok: false,
            reason: 'user_mismatch',
            error: createStructuredError(
                'native_turn_mismatch',
                'Retry Mobile could not confirm the original user turn before backend handoff.',
            ),
        };
    }

    const assistantIndex = Number(assistantMessageIndex);
    const assistantMessage = chat[assistantIndex];
    if (!assistantMessage || assistantMessage.is_user === true) {
        return {
            ok: false,
            reason: 'assistant_missing',
        };
    }

    const previous = chat[assistantIndex - 1];
    if (assistantIndex !== userIndex + 1 && previous?.is_user !== true) {
        return {
            ok: false,
            reason: 'assistant_mismatch',
            error: createStructuredError(
                'native_turn_mismatch',
                'Retry Mobile saw a native completion event, but it did not map back to the captured user turn.',
            ),
        };
    }

    if (assistantIndex !== userIndex + 1 && String(previous?.mes ?? '') !== fingerprint.userMessageText) {
        return {
            ok: false,
            reason: 'assistant_mismatch',
            error: createStructuredError(
                'native_turn_mismatch',
                'Retry Mobile saw a native completion event, but the preceding user turn no longer matched the captured request.',
            ),
        };
    }

    return {
        ok: true,
        chat,
        assistantMessageIndex: assistantIndex,
        assistantMessage,
    };
}

export function getAssistantMessageAt(index, context = getContext()) {
    const chat = getCurrentChatArray(context);
    const assistantMessage = Number.isInteger(index) && index >= 0
        ? chat[index]
        : null;
    return assistantMessage && assistantMessage.is_user !== true
        ? assistantMessage
        : null;
}

export function markInternalChatReload(chatIdentity = getChatIdentity(getContext())) {
    internalChatReloadState = {
        at: Date.now(),
        chatIdentity: cloneChatIdentity(chatIdentity),
    };
}

export function wasInternalChatReloadRecentlyTriggered(chatIdentity = getChatIdentity(getContext())) {
    if (!internalChatReloadState.at) {
        return false;
    }

    if ((Date.now() - internalChatReloadState.at) > INTERNAL_CHAT_RELOAD_GRACE_MS) {
        return false;
    }

    if (!internalChatReloadState.chatIdentity || !chatIdentity) {
        return true;
    }

    return isSameChat(chatIdentity, internalChatReloadState.chatIdentity);
}

export function clearInternalChatReloadMarker() {
    internalChatReloadState = {
        at: 0,
        chatIdentity: null,
    };
}

export async function reloadCurrentChatSafe(context = getContext()) {
    if (typeof context?.reloadCurrentChat === 'function') {
        markInternalChatReload(getChatIdentity(context));
        await context.reloadCurrentChat();
        markInternalChatReload(getChatIdentity(context));
        return true;
    }

    return false;
}

function cloneChatIdentity(chatIdentity) {
    if (!chatIdentity) {
        return null;
    }

    return {
        kind: String(chatIdentity.kind || ''),
        chatId: String(chatIdentity.chatId || ''),
        groupId: chatIdentity.groupId == null
            ? null
            : String(chatIdentity.groupId),
    };
}

