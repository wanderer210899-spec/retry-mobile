import { findLatestActiveRunBinding, recoverBoundStatus } from './job/run-binding.js';
import { createStructuredError } from './retry-error.js';
import { RetryState } from './retry-fsm.js';

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

export function createRestoreController({
    runtime,
    retryFsm,
    intentPort,
    baseBackendPort,
    updateActiveJob,
    render,
    syncRuntimeFromFsm,
    getCurrentChatIdentity,
    toStructuredError,
    windowRef = window,
}) {
    async function restoreControlState() {
        if (retryFsm.getState() !== RetryState.IDLE) {
            return;
        }

        const currentChatIdentity = getCurrentChatIdentity();
        const intent = intentPort.readIntent?.() || null;
        const activeRunBinding = findLatestActiveRunBinding(runtime.sessionId);
        const restoreIdentities = collectBootRestoreChatIdentities({
            currentChatIdentity,
            singleTarget: intent?.singleTarget || null,
            activeRunBinding,
        });

        try {
            for (const chatIdentity of restoreIdentities) {
                const recovered = await recoverBoundStatus({
                    chatIdentity,
                    sessionId: runtime.sessionId || '',
                    fetchStatus: baseBackendPort.pollStatus,
                    fetchActive: baseBackendPort.fetchActiveJob,
                });
                if (retryFsm.getState() !== RetryState.IDLE) {
                    return;
                }
                const status = recovered?.status || null;
                if (status?.jobId && String(status.state || '') === 'running') {
                    updateActiveJob(status, status.jobId);
                    retryFsm.restoreRunning({
                        status,
                        runId: status.runId,
                        jobId: status.jobId,
                        chatIdentity: status.chatIdentity || chatIdentity,
                        target: buildRestoreTarget(status, intent?.singleTarget || null),
                    });
                    syncRuntimeFromFsm(retryFsm);
                    render();
                    return;
                }
            }

            if (intent?.engaged
                && intent?.mode === 'toggle'
                && !currentChatIdentity?.chatId) {
                scheduleRestoreRetry();
                return;
            }

            if (intent?.engaged
                && intent?.mode === 'single'
                && !intent?.singleTarget?.chatIdentity) {
                runtime.controlError = createStructuredError(
                    'single_target_missing',
                    'Retry Mobile could not restore single mode because the durable target identity is missing.',
                );
                render();
                return;
            }

            const armPayload = buildBootArmPayload(intent, currentChatIdentity);
            if (armPayload && retryFsm.getState() === RetryState.IDLE) {
                retryFsm.arm(armPayload);
                if (retryFsm.getState() !== RetryState.ARMED) {
                    runtime.controlError = retryFsm.getContext().terminalError || createStructuredError(
                        'retry_arm_failed',
                        'Retry Mobile could not restore armed mode from saved settings.',
                    );
                }
                syncRuntimeFromFsm(retryFsm);
                render();
            }
        } catch (error) {
            runtime.controlError = toStructuredError(
                error,
                'Retry Mobile could not restore backend state during boot.',
            );
            render();
        }
    }

    function scheduleRestoreRetry() {
        if (runtime.restoreRetryHandle) {
            return;
        }

        runtime.restoreRetryHandle = windowRef.setTimeout(() => {
            runtime.restoreRetryHandle = 0;
            void restoreControlState();
        }, 250);
    }

    return {
        restoreControlState,
        scheduleRestoreRetry,
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
