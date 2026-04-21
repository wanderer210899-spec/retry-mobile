export function getAttachedJobStatusFromStartError(error) {
    if (Number(error?.status) !== 409) {
        return null;
    }

    if (String(error?.payload?.reason || '') !== 'job_running') {
        return null;
    }

    const status = error?.payload?.job;
    if (!status?.jobId) {
        return null;
    }

    return cloneValue(status);
}

export function shouldAttachRunningConflict(fsmState, currentRunId, conflictRunId) {
    return fsmState === 'capturing'
        && String(currentRunId || '') !== ''
        && String(currentRunId || '') === String(conflictRunId || '');
}

export function resolveCaptureSubscriptionChatIdentity(fsmContext, fallbackChatIdentity = null) {
    const mode = String(fsmContext?.intent?.mode || '');
    if (mode === 'single') {
        return cloneValue(fsmContext?.target?.chatIdentity)
            || cloneValue(fsmContext?.chatIdentity)
            || cloneValue(fallbackChatIdentity)
            || null;
    }

    if (mode === 'toggle') {
        return cloneValue(fallbackChatIdentity)
            || cloneValue(fsmContext?.chatIdentity)
            || null;
    }

    return cloneValue(fsmContext?.target?.chatIdentity)
        || cloneValue(fsmContext?.chatIdentity)
        || cloneValue(fallbackChatIdentity)
        || null;
}

export function resolveCaptureTarget(fsmContext, fingerprint = null, fallbackChatIdentity = null) {
    const existingTarget = cloneValue(fsmContext?.target) || null;
    if (existingTarget) {
        return existingTarget;
    }

    if (String(fsmContext?.intent?.mode || '') !== 'single') {
        return null;
    }

    const chatIdentity = cloneValue(fingerprint?.chatIdentity)
        || cloneValue(fallbackChatIdentity)
        || null;
    const userMessageIndex = Number.isInteger(fingerprint?.userMessageIndex)
        ? fingerprint.userMessageIndex
        : (Number.isInteger(fingerprint?.userIndexAtCapture) ? fingerprint.userIndexAtCapture : null);

    if (!chatIdentity || userMessageIndex == null) {
        return null;
    }

    return {
        chatIdentity,
        userMessageIndex,
    };
}

export function collectBootRestoreChatIdentities({
    currentChatIdentity = null,
    singleTarget = null,
    activeRunBinding = null,
} = {}) {
    const candidates = [
        activeRunBinding?.chatIdentity || null,
        currentChatIdentity,
        singleTarget?.chatIdentity || null,
    ];

    const seen = new Set();
    const ordered = [];
    for (const candidate of candidates) {
        const key = buildChatKey(candidate);
        if (!key || seen.has(key)) {
            continue;
        }
        seen.add(key);
        ordered.push(cloneValue(candidate));
    }

    return ordered;
}

export function buildBootArmPayload(intent, currentChatIdentity = null) {
    if (!intent?.engaged) {
        return null;
    }

    if (intent.mode === 'single') {
        const target = cloneValue(intent.singleTarget) || null;
        const chatIdentity = cloneValue(target?.chatIdentity) || null;
        if (!chatIdentity) {
            return null;
        }

        return {
            intent: cloneValue(intent),
            target,
            chatIdentity,
        };
    }

    if (intent.mode !== 'toggle') {
        return null;
    }

    const chatIdentity = cloneValue(currentChatIdentity) || null;
    if (!chatIdentity?.chatId) {
        return null;
    }

    return {
        intent: cloneValue(intent),
        target: null,
        chatIdentity,
    };
}

export function buildRestoreTarget(status, singleTarget = null) {
    const singleTargetChat = singleTarget?.chatIdentity || null;
    const statusChat = status?.chatIdentity || null;
    if (sameChat(singleTargetChat, statusChat)) {
        return cloneValue(singleTarget);
    }

    if (!statusChat) {
        return null;
    }

    return {
        chatIdentity: cloneValue(statusChat),
    };
}

function buildChatKey(chatIdentity = null) {
    if (!chatIdentity?.chatId) {
        return '';
    }

    return [
        String(chatIdentity.kind || ''),
        String(chatIdentity.chatId || ''),
        chatIdentity.groupId == null ? '' : String(chatIdentity.groupId),
    ].join('::');
}

function sameChat(left, right) {
    const leftKey = buildChatKey(left);
    const rightKey = buildChatKey(right);
    return Boolean(leftKey) && leftKey === rightKey;
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
