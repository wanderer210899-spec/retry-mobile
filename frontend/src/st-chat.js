import { getChatIdentity, getContext, getCurrentChatArray } from './st-context.js';
import { createStructuredError } from './retry-error.js';

const INTERNAL_CHAT_RELOAD_GRACE_MS = 1500;
const CAPTURE_TAIL_WINDOW = 4;
const CONFIRM_INDEX_WINDOW = 2;

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
    const userMessageIndex = resolveCapturedUserIndex(chat, type, messageIdHint);

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
        userIndexAtCapture: userMessageIndex,
        userMessageText: String(targetMessage.mes ?? ''),
        precedingMessageText: userMessageIndex > 0
            ? String(chat[userMessageIndex - 1]?.mes ?? '')
            : '',
        capturedChatLength: chat.length,
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
    const attemptedAssistantIndices = resolveCandidateAssistantIndices(fingerprint, assistantMessageIndex, chat.length);
    let sawAssistantGap = false;

    for (const candidateAssistantIndex of attemptedAssistantIndices) {
        const assistantMessage = chat[candidateAssistantIndex];
        if (!assistantMessage || assistantMessage.is_user === true) {
            sawAssistantGap = true;
            continue;
        }

        const userIndex = candidateAssistantIndex - 1;
        if (!isMatchingCapturedUser(chat, fingerprint, userIndex)) {
            continue;
        }

        return {
            ok: true,
            chat,
            assistantMessageIndex: candidateAssistantIndex,
            assistantMessage,
        };
    }

    if (sawAssistantGap) {
        return {
            ok: false,
            reason: 'assistant_missing',
        };
    }

    return {
        ok: false,
        reason: 'assistant_mismatch',
        error: createStructuredError(
            'native_turn_mismatch',
            'Retry Mobile saw a native completion event, but it did not map back to the captured user turn.',
        ),
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

function resolveCapturedUserIndex(chat, type, messageIdHint) {
    const preferred = [];
    if (Number.isInteger(messageIdHint)) {
        if (type === 'swipe' || type === 'regenerate') {
            preferred.push(messageIdHint - 1, messageIdHint);
        } else {
            preferred.push(messageIdHint, messageIdHint - 1);
        }
    }

    for (const index of preferred) {
        if (Number.isInteger(index) && index >= 0 && chat[index]?.is_user === true) {
            return index;
        }
    }

    for (let index = chat.length - 1; index >= Math.max(0, chat.length - CAPTURE_TAIL_WINDOW); index -= 1) {
        if (chat[index]?.is_user === true) {
            return index;
        }
    }

    return -1;
}

function resolveCandidateAssistantIndices(fingerprint, observedAssistantIndex, chatLength) {
    const candidateIndices = [];
    pushCandidateIndex(candidateIndices, observedAssistantIndex, chatLength);

    const anchoredUserIndex = Number.isInteger(fingerprint?.userIndexAtCapture)
        ? fingerprint.userIndexAtCapture
        : null;
    if (Number.isInteger(anchoredUserIndex) && anchoredUserIndex >= 0) {
        for (let offset = -CONFIRM_INDEX_WINDOW; offset <= CONFIRM_INDEX_WINDOW; offset += 1) {
            pushCandidateIndex(candidateIndices, anchoredUserIndex + 1 + offset, chatLength);
        }
    }

    const hintIndex = Number.isInteger(fingerprint?.messageIdHint)
        ? fingerprint.messageIdHint
        : null;
    if (Number.isInteger(hintIndex) && hintIndex >= 0) {
        for (let offset = -CONFIRM_INDEX_WINDOW; offset <= CONFIRM_INDEX_WINDOW; offset += 1) {
            pushCandidateIndex(candidateIndices, hintIndex + offset, chatLength);
        }
    }

    return candidateIndices;
}

function pushCandidateIndex(candidateIndices, value, chatLength) {
    if (!Number.isInteger(value) || value < 0 || value >= chatLength) {
        return;
    }
    if (!candidateIndices.includes(value)) {
        candidateIndices.push(value);
    }
}

function isMatchingCapturedUser(chat, fingerprint, userIndex) {
    const userMessage = Number.isInteger(userIndex) && userIndex >= 0
        ? chat[userIndex]
        : null;
    if (!userMessage || userMessage.is_user !== true || String(userMessage.mes ?? '') !== fingerprint.userMessageText) {
        return false;
    }

    if (!fingerprint?.precedingMessageText) {
        return true;
    }

    const precedingText = userIndex > 0
        ? String(chat[userIndex - 1]?.mes ?? '')
        : '';
    return precedingText === fingerprint.precedingMessageText;
}
