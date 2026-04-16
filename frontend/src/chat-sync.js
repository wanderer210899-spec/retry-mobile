import { getContext, getChatIdentity } from './st-context.js';
import { isSameChat, reloadCurrentChatSafe } from './st-chat.js';

export async function syncRemoteStatus(status, runtimeState) {
    const context = getContext();
    const identity = getChatIdentity(context);
    if (!context || !identity || !status?.chatIdentity) {
        return false;
    }

    if (!isSameChat(identity, status.chatIdentity)) {
        return false;
    }

    const version = Number(status.targetMessageVersion);
    if (!Number.isFinite(version) || version <= 0 || version === runtimeState.lastAppliedVersion) {
        return false;
    }

    const reloaded = await reloadCurrentChatSafe(context);
    if (!reloaded) {
        return false;
    }

    runtimeState.lastAppliedVersion = version;
    return true;
}

