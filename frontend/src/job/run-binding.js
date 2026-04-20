const STORAGE_PREFIX = 'retry-mobile:active-run:';
const SESSION_ID_STORAGE_KEY = 'retry-mobile:session-id';

export function getFrontendSessionId(storage = getSessionStorage()) {
    if (!storage) {
        return createSessionId();
    }

    try {
        const existing = String(storage.getItem(SESSION_ID_STORAGE_KEY) || '').trim();
        if (existing) {
            return existing;
        }

        const next = createSessionId();
        storage.setItem(SESSION_ID_STORAGE_KEY, next);
        return next;
    } catch {
        return createSessionId();
    }
}

export function buildChatKey(chatIdentity) {
    if (!chatIdentity?.chatId) {
        return '';
    }

    return [
        String(chatIdentity.kind || ''),
        String(chatIdentity.chatId || ''),
        chatIdentity.groupId == null ? '' : String(chatIdentity.groupId),
    ].join('::');
}

export function readActiveRunBinding(chatIdentity, storage = getSessionStorage()) {
    const chatKey = buildChatKey(chatIdentity);
    if (!chatKey || !storage) {
        return null;
    }

    try {
        const raw = storage.getItem(`${STORAGE_PREFIX}${chatKey}`);
        if (!raw) {
            return null;
        }
        return normalizeBinding(JSON.parse(raw), chatIdentity);
    } catch {
        return null;
    }
}

export function writeActiveRunBinding(binding, storage = getSessionStorage()) {
    const normalized = normalizeBinding(binding);
    if (!normalized?.chatKey || !storage) {
        return null;
    }

    try {
        storage.setItem(`${STORAGE_PREFIX}${normalized.chatKey}`, JSON.stringify(normalized));
        return normalized;
    } catch {
        return null;
    }
}

export function clearActiveRunBinding(chatIdentity, storage = getSessionStorage()) {
    const chatKey = buildChatKey(chatIdentity);
    if (!chatKey || !storage) {
        return;
    }

    try {
        storage.removeItem(`${STORAGE_PREFIX}${chatKey}`);
    } catch {
        // Ignore storage failures; recovery can still fall back to chat-scoped backend state.
    }
}

export function syncActiveRunBindingFromState(state, storage = getSessionStorage()) {
    const nextBinding = buildBindingFromState(state);
    if (!nextBinding) {
        if (state?.chatIdentity) {
            clearActiveRunBinding(state.chatIdentity, storage);
        }
        return null;
    }

    return writeActiveRunBinding(nextBinding, storage);
}

export async function recoverBoundStatus({
    chatIdentity,
    sessionId,
    fetchStatus,
    fetchActive,
    readBinding = readActiveRunBinding,
    clearBinding = clearActiveRunBinding,
}) {
    const binding = readBinding(chatIdentity);
    if (binding?.jobId) {
        try {
            const status = await fetchStatus(binding.jobId);
            if (isRunningStatus(status) && isBindingMatch(status, binding, chatIdentity)) {
                return {
                    status,
                    source: 'binding',
                    binding,
                };
            }
            clearBinding(chatIdentity);
        } catch (error) {
            if (Number(error?.status) !== 404) {
                throw error;
            }
            clearBinding(chatIdentity);
        }
    }

    if (sessionId) {
        const sameSessionActive = await fetchActive(chatIdentity, {
            sessionId,
            sameSessionOnly: true,
        });
        if (isRunningStatus(sameSessionActive) && isStatusForChat(sameSessionActive, chatIdentity)) {
            return {
                status: sameSessionActive,
                source: 'same_session_active',
                binding: null,
            };
        }
    }

    const active = await fetchActive(chatIdentity, {
        sessionId,
        sameSessionOnly: false,
    });
    if (isRunningStatus(active) && isStatusForChat(active, chatIdentity)) {
        return {
            status: active,
            source: 'active',
            binding: null,
        };
    }

    return {
        status: null,
        source: binding ? 'binding_stale' : 'none',
        binding,
    };
}

export function buildBindingFromState(state) {
    if (!state?.jobId || !state?.runId || !state?.chatIdentity || !state?.sessionId) {
        return null;
    }

    if (isTerminalPhase(state.phase)) {
        return null;
    }

    const chatKey = buildChatKey(state.chatIdentity);
    if (!chatKey) {
        return null;
    }

    return normalizeBinding({
        runId: state.runId,
        jobId: state.jobId,
        sessionId: state.sessionId,
        chatKey,
        chatIdentity: state.chatIdentity,
        lastKnownTargetMessageVersion: Number(state.activeStatus?.targetMessageVersion || state.lastAppliedVersion || 0),
        lastKnownState: String(state.activeStatus?.state || state.phase || 'unknown'),
        updatedAt: state.activeStatus?.updatedAt || new Date().toISOString(),
    });
}

function normalizeBinding(binding, fallbackChatIdentity = null) {
    const chatIdentity = cloneChatIdentity(binding?.chatIdentity || fallbackChatIdentity);
    const chatKey = String(binding?.chatKey || buildChatKey(chatIdentity));
    if (!chatKey || !chatIdentity?.chatId) {
        return null;
    }

    const runId = String(binding?.runId || '').trim();
    const jobId = String(binding?.jobId || '').trim();
    const sessionId = String(binding?.sessionId || '').trim();
    if (!runId || !jobId || !sessionId) {
        return null;
    }

    return {
        runId,
        jobId,
        sessionId,
        chatKey,
        chatIdentity,
        lastKnownTargetMessageVersion: Number(binding?.lastKnownTargetMessageVersion) || 0,
        lastKnownState: String(binding?.lastKnownState || 'unknown'),
        updatedAt: typeof binding?.updatedAt === 'string' && binding.updatedAt
            ? binding.updatedAt
            : new Date().toISOString(),
    };
}

function isBindingMatch(status, binding, chatIdentity) {
    return String(status?.jobId || '') === String(binding?.jobId || '')
        && String(status?.runId || '') === String(binding?.runId || '')
        && String(status?.ownerSessionId || '') === String(binding?.sessionId || '')
        && isStatusForChat(status, chatIdentity);
}

function isStatusForChat(status, chatIdentity) {
    return buildChatKey(status?.chatIdentity) === buildChatKey(chatIdentity);
}

function isRunningStatus(status) {
    return Boolean(status)
        && String(status.state || '') === 'running'
        && String(status.jobId || '').trim();
}

function isTerminalPhase(phase) {
    return phase === 'completed'
        || phase === 'failed'
        || phase === 'cancelled';
}

function cloneChatIdentity(chatIdentity) {
    if (!chatIdentity?.chatId) {
        return null;
    }

    return {
        kind: String(chatIdentity.kind || ''),
        chatId: String(chatIdentity.chatId || ''),
        groupId: chatIdentity.groupId == null
            ? null
            : String(chatIdentity.groupId),
        avatarUrl: typeof chatIdentity.avatarUrl === 'string' ? chatIdentity.avatarUrl : '',
        assistantName: typeof chatIdentity.assistantName === 'string' ? chatIdentity.assistantName : '',
        fileName: typeof chatIdentity.fileName === 'string' ? chatIdentity.fileName : String(chatIdentity.chatId || ''),
    };
}

function getSessionStorage() {
    try {
        return globalThis.sessionStorage ?? null;
    } catch {
        return null;
    }
}

function createSessionId() {
    if (globalThis.crypto?.randomUUID) {
        return globalThis.crypto.randomUUID();
    }

    return `rm-session-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
