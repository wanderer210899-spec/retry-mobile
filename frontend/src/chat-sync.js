import { getContext, getChatIdentity } from './st-context.js';
import { isSameChat, reloadCurrentChatSafe } from './st-chat.js';

export async function syncRemoteStatus(status, runtimeState) {
    return await commitCanonicalReloadForStatus(status, runtimeState);
}

export async function syncRestoredStatus(status, runtimeState) {
    return await commitCanonicalReloadForStatus(status, runtimeState);
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
    const context = getContext();
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

    const reloaded = await reloadCurrentChatSafe(context);
    if (!reloaded) {
        return false;
    }

    const key = buildCommittedReloadKey(status);
    runtimeState.committedReloadKeys ??= new Set();
    runtimeState.committedReloadKeys.add(key);
    runtimeState.lastAppliedVersion = Number(status.targetMessageVersion) || runtimeState.lastAppliedVersion || 0;
    return true;
}
