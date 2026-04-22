export function chooseOperationalChatIdentity(...candidates) {
    const normalized = candidates
        .map(cloneChatIdentity)
        .filter(Boolean);
    if (normalized.length === 0) {
        return null;
    }

    const anchor = normalized[0];
    const compatible = normalized.filter((candidate) => isCompatibleChatIdentity(anchor, candidate));
    const ready = compatible.find(hasStableChatId);
    return ready || compatible[0] || anchor;
}

export async function resolveExpectedPreviousGeneration(fetchChatState, chatIdentity) {
    if (typeof fetchChatState !== 'function' || !hasStableChatId(chatIdentity)) {
        return {
            currentGeneration: 0,
            meta: {
                source: 'identity_fallback',
                reason: 'chat_id_missing',
            },
        };
    }

    try {
        const chatState = await fetchChatState(chatIdentity);
        return {
            currentGeneration: Number(chatState?.currentGeneration) || 0,
            meta: {
                source: 'backend_state',
                reason: 'resolved',
            },
        };
    } catch (error) {
        if (isMissingIdentityStateError(error)) {
            return {
                currentGeneration: 0,
                meta: {
                    source: 'identity_fallback',
                    reason: 'backend_missing_chat_identity',
                },
            };
        }

        throw error;
    }
}

function hasStableChatId(chatIdentity) {
    return Boolean(String(chatIdentity?.chatId || '').trim());
}

function isCompatibleChatIdentity(anchor, candidate) {
    if (!anchor || !candidate) {
        return false;
    }

    if (String(anchor.kind || '') !== String(candidate.kind || '')) {
        return false;
    }

    if (String(anchor.groupId || '') !== String(candidate.groupId || '')) {
        return false;
    }

    const anchorChatId = String(anchor.chatId || '').trim();
    const candidateChatId = String(candidate.chatId || '').trim();
    if (anchorChatId && candidateChatId && anchorChatId !== candidateChatId) {
        return false;
    }

    return true;
}

function isObject(value) {
    return value != null && typeof value === 'object';
}

function cloneChatIdentity(chatIdentity) {
    if (!isObject(chatIdentity)) {
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

function isMissingIdentityStateError(error) {
    if (Number(error?.status) !== 400) {
        return false;
    }

    const message = String(error?.payload?.error || error?.message || '');
    return /missing chat identity/i.test(message);
}
