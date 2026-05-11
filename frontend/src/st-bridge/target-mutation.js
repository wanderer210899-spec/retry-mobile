import {
    getChatIdentity,
    getCurrentChatArray,
    getEventTypes,
    subscribeEvent,
} from './internal/ctx.js';
import { isSameChat } from './inspect.js';

const TARGET_EVENT_NAMES = Object.freeze([
    'MESSAGE_DELETED',
    'MESSAGE_EDITED',
    'MESSAGE_UPDATED',
    'MESSAGE_SWIPED',
    'MESSAGE_SWIPE_DELETED',
]);

export function createTargetMutationGuard({
    getContext,
    onMutation,
    onEvent,
} = {}) {
    let watchedStatus = null;
    let stops = [];
    const reported = new Set();

    return {
        watch,
        clear,
    };

    function watch(status) {
        if (!canWatchStatus(status)) {
            clearMatchingJob(status?.jobId);
            return false;
        }

        watchedStatus = cloneValue(status);
        ensureSubscribed();
        return true;
    }

    function clear() {
        watchedStatus = null;
        reported.clear();
        for (const stop of stops) {
            try { stop(); } catch {}
        }
        stops = [];
    }

    function clearMatchingJob(jobId) {
        if (!jobId || String(watchedStatus?.jobId || '') === String(jobId || '')) {
            clear();
        }
    }

    function ensureSubscribed() {
        if (stops.length > 0) {
            return;
        }

        const context = getContext?.();
        const eventTypes = getEventTypes(context);
        stops = TARGET_EVENT_NAMES
            .map((name) => eventTypes?.[name]
                ? subscribeEvent(eventTypes[name], (...args) => handleEvent(name, args), context)
                : null)
            .filter((stop) => typeof stop === 'function');
    }

    function handleEvent(sourceEvent, args) {
        if (!watchedStatus?.jobId) {
            return;
        }

        const context = getContext?.();
        const liveChatIdentity = getChatIdentity(context);
        if (!isSameChat(watchedStatus.chatIdentity, liveChatIdentity)) {
            return;
        }

        const chat = getCurrentChatArray(context);
        const eventMessageId = readEventMessageId(sourceEvent, args);
        const inspection = inspectWatchedTarget({
            status: watchedStatus,
            chat,
            sourceEvent,
            eventMessageId,
        });
        if (!inspection.affected) {
            return;
        }

        const reportKey = [
            watchedStatus.jobId,
            sourceEvent,
            inspection.reason,
            Number(watchedStatus.targetMessageVersion) || 0,
        ].join(':');
        if (reported.has(reportKey)) {
            return;
        }
        reported.add(reportKey);

        const payload = {
            jobId: watchedStatus.jobId,
            runId: watchedStatus.runId || '',
            chatIdentity: cloneValue(watchedStatus.chatIdentity),
            mutationType: inspection.mutationType,
            reason: inspection.reason,
            sourceEvent,
            targetMessageVersion: Number(watchedStatus.targetMessageVersion) || 0,
        };
        onEvent?.('target_mutation_detected', `Detected ${inspection.reason} from ${sourceEvent}.`);
        void onMutation?.(payload);
    }
}

export function inspectWatchedTarget({
    status,
    chat,
    sourceEvent,
    eventMessageId = null,
} = {}) {
    const assistantIndex = resolveAssistantIndex(status, chat);
    const userIndex = resolveUserIndex(status, chat);
    const eventHitsAssistant = eventMessageId != null && assistantIndex != null && eventMessageId === assistantIndex;
    const eventHitsUser = eventMessageId != null && userIndex != null && eventMessageId === userIndex;
    const hasSpecificMessage = eventMessageId != null && sourceEvent !== 'MESSAGE_DELETED';

    if (hasSpecificMessage && !eventHitsAssistant && !eventHitsUser) {
        return { affected: false };
    }

    if (sourceEvent === 'MESSAGE_DELETED') {
        if (assistantIndex == null) {
            return affected('assistant_missing_after_delete', 'message_deleted');
        }
        if (userIndex == null) {
            return affected('user_missing_after_delete', 'message_deleted');
        }
        return { affected: false };
    }

    if (sourceEvent === 'MESSAGE_SWIPE_DELETED') {
        return eventHitsAssistant
            ? affected('assistant_swipe_deleted', 'swipe_deleted')
            : { affected: false };
    }

    if (sourceEvent === 'MESSAGE_SWIPED') {
        return eventHitsAssistant
            ? affected('assistant_swiped', 'message_swiped')
            : { affected: false };
    }

    if (sourceEvent === 'MESSAGE_EDITED') {
        return eventHitsAssistant || eventHitsUser
            ? affected(eventHitsUser ? 'user_message_edited' : 'assistant_message_edited', 'message_edited')
            : { affected: false };
    }

    if (sourceEvent === 'MESSAGE_UPDATED') {
        return eventHitsAssistant || eventHitsUser
            ? affected(eventHitsUser ? 'user_message_updated' : 'assistant_message_updated', 'message_updated')
            : { affected: false };
    }

    return { affected: false };
}

function canWatchStatus(status) {
    if (!status?.jobId || status?.recoverySuppressed || status?.userTombstone) {
        return false;
    }

    const state = String(status.state || '');
    if (state === 'running') {
        return true;
    }

    return ['completed', 'failed', 'cancelled'].includes(state)
        && Number(status.targetMessageVersion) > 0;
}

function readEventMessageId(sourceEvent, args) {
    const first = Array.isArray(args) ? args[0] : null;
    if (sourceEvent === 'MESSAGE_SWIPE_DELETED') {
        return numberOrNull(first?.messageId);
    }

    return numberOrNull(first);
}

function resolveAssistantIndex(status, chat) {
    const byAnchor = findMessageIndexByAnchor(chat, status?.targetAssistantAnchorId, 'retryMobileAssistantAnchorId', false);
    if (byAnchor != null) {
        return byAnchor;
    }

    return indexIfMessageExists(chat, status?.targetMessageIndex, false);
}

function resolveUserIndex(status, chat) {
    const byAnchor = findMessageIndexByAnchor(chat, status?.targetUserAnchorId, 'retryMobileUserAnchorId', true);
    if (byAnchor != null) {
        return byAnchor;
    }

    return indexIfMessageExists(chat, status?.targetFingerprint?.userMessageIndex, true);
}

function findMessageIndexByAnchor(chat, anchorId, key, requireUser) {
    const target = typeof anchorId === 'string' && anchorId.trim() ? anchorId.trim() : '';
    if (!target || !Array.isArray(chat)) {
        return null;
    }

    for (let index = 0; index < chat.length; index += 1) {
        const message = chat[index];
        if (!message || typeof message !== 'object') {
            continue;
        }
        if (requireUser === true && message.is_user !== true) {
            continue;
        }
        if (requireUser === false && message.is_user === true) {
            continue;
        }
        if (readAnchor(message, key) === target) {
            return index;
        }
    }

    return null;
}

function readAnchor(message, key) {
    const direct = typeof message?.extra?.[key] === 'string' ? message.extra[key].trim() : '';
    if (direct) {
        return direct;
    }

    const swipeInfo = Array.isArray(message?.swipe_info) ? message.swipe_info : [];
    for (const row of swipeInfo) {
        const candidate = typeof row?.extra?.[key] === 'string' ? row.extra[key].trim() : '';
        if (candidate) {
            return candidate;
        }
    }

    return '';
}

function indexIfMessageExists(chat, value, requireUser) {
    const index = numberOrNull(value);
    if (index == null || !Array.isArray(chat)) {
        return null;
    }

    const message = chat[index];
    if (!message || typeof message !== 'object') {
        return null;
    }
    if (requireUser === true && message.is_user !== true) {
        return null;
    }
    if (requireUser === false && message.is_user === true) {
        return null;
    }

    return index;
}

function affected(reason, mutationType) {
    return {
        affected: true,
        reason,
        mutationType,
    };
}

function numberOrNull(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) {
        return null;
    }

    return Math.trunc(number);
}

function cloneValue(value) {
    if (value == null) {
        return value ?? null;
    }
    if (typeof globalThis.structuredClone === 'function') {
        return globalThis.structuredClone(value);
    }
    return JSON.parse(JSON.stringify(value));
}
