import { getContext, getChatIdentity } from './st-context.js';
import { isSameChat, reloadCurrentChatSafe } from './st-chat.js';

export async function syncRemoteStatus(status, runtimeState) {
    return await commitStatusSyncForContext(status, runtimeState, getContext(), {
        preferLiveUpdate: true,
    });
}

export async function syncRestoredStatus(status, runtimeState) {
    return await commitStatusSyncForContext(status, runtimeState, getContext(), {
        preferLiveUpdate: false,
    });
}

export function clearCommittedReloads(runtimeState) {
    runtimeState.committedReloadKeys = new Set();
}

export function buildCommittedReloadKey(status) {
    const jobId = String(status?.jobId || '').trim();
    const version = Number(status?.targetMessageVersion);
    if (!jobId || !Number.isFinite(version) || version <= 0) {
        return '';
    }

    return `${jobId}:${version}`;
}

export function shouldCommitStatusReload(status, runtimeState) {
    const key = buildCommittedReloadKey(status);
    if (!key) {
        return false;
    }

    runtimeState.committedReloadKeys ??= new Set();
    return !runtimeState.committedReloadKeys.has(key);
}

async function commitCanonicalReloadForStatus(status, runtimeState) {
    return await commitStatusSyncForContext(status, runtimeState, getContext(), {
        preferLiveUpdate: false,
    });
}

export async function commitStatusSyncForContext(status, runtimeState, context, options = {}) {
    const identity = getChatIdentity(context);
    if (!context || !identity || !status?.chatIdentity) {
        return false;
    }

    if (!isSameChat(identity, status.chatIdentity)) {
        return false;
    }

    if (!shouldCommitStatusReload(status, runtimeState)) {
        return false;
    }

    const preferLiveUpdate = options.preferLiveUpdate === true;
    let refreshed = false;

    if (preferLiveUpdate) {
        refreshed = applyStatusToExistingMessage(status, context);
    }

    if (!refreshed) {
        refreshed = await reloadCurrentChatSafe(context);
    }

    if (!refreshed) {
        return false;
    }

    const key = buildCommittedReloadKey(status);
    runtimeState.committedReloadKeys ??= new Set();
    runtimeState.committedReloadKeys.add(key);
    runtimeState.lastAppliedVersion = Number(status.targetMessageVersion) || runtimeState.lastAppliedVersion || 0;
    return true;
}

export function applyStatusToExistingMessage(status, context) {
    const targetMessageIndex = Number(status?.targetMessageIndex);
    const liveTargetMessage = cloneValue(status?.targetMessage);
    const liveChat = Array.isArray(context?.chat) ? context.chat : null;

    if (!Number.isInteger(targetMessageIndex) || targetMessageIndex < 0 || !liveTargetMessage || !liveChat) {
        return false;
    }

    const existingMessage = liveChat[targetMessageIndex];
    if (!existingMessage || existingMessage.is_user === true || liveTargetMessage.is_user === true) {
        return false;
    }

    liveChat[targetMessageIndex] = {
        ...existingMessage,
        ...liveTargetMessage,
    };

    try {
        if (typeof context?.updateMessageBlock === 'function') {
            context.updateMessageBlock(targetMessageIndex, liveChat[targetMessageIndex]);
        } else {
            return false;
        }

        if (typeof context?.swipe?.refresh === 'function') {
            context.swipe.refresh(true);
        }

        if (typeof context?.activateSendButtons === 'function') {
            context.activateSendButtons();
        }
    } catch {
        return false;
    }

    return true;
}

function cloneValue(value) {
    if (value == null) {
        return null;
    }

    if (typeof structuredClone === 'function') {
        return structuredClone(value);
    }

    return JSON.parse(JSON.stringify(value));
}
