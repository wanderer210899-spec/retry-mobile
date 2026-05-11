import { findLatestActiveRunBinding, recoverBoundStatus } from './job/run-binding.js';
import { createStructuredError } from './retry-error.js';
import { RetryState } from './retry-fsm.js';
import { getChatIdentity, wasInternalChatReloadRecentlyTriggered } from './st-bridge/index.js';

const RESTORE_RETRY_CAP = 5;

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
    stPort,
    updateActiveJob,
    render,
    syncRuntimeFromFsm,
    getCurrentChatIdentity,
    toStructuredError,
    subscribeEvent = null,
    eventTypes = null,
    logEvent = () => {},
    windowRef = globalThis.window || globalThis,
}) {
    let chatChangedStop = null;
    let chatLoadedStop = null;
    let restoreRetryCount = 0;
    let chatChangedDebounceHandle = 0;

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
                    retryFsm.restoreRunning({
                        status,
                        runId: status.runId,
                        jobId: status.jobId,
                        chatIdentity: status.chatIdentity || chatIdentity,
                        target: buildRestoreTarget(status, intent?.singleTarget || null),
                    });
                    await updateActiveJob(status, status.jobId);
                    syncRuntimeFromFsm(retryFsm);
                    render();
                    return;
                }

                // If the browser was suspended while the backend finished writing accepted
                // swipes, the in-memory chat can be stale even though the run is already
                // terminal. In that case, reconcile against the latest backend snapshot for
                // the *current* chat to avoid requiring a full page refresh.
                if (sameChat(chatIdentity, currentChatIdentity) && baseBackendPort?.fetchLatestJob) {
                    try {
                        const latest = await baseBackendPort.fetchLatestJob(chatIdentity);
                        const latestState = String(latest?.state || '');
                        if (latest?.jobId
                            && latestState
                            && latestState !== 'running'
                            && Number(latest?.targetMessageVersion) > 0) {
                            await updateActiveJob(latest, latest.jobId, {
                                recoverTerminal: true,
                                reason: 'boot_restore_latest',
                                chatIdentity,
                            });
                            syncRuntimeFromFsm(retryFsm);
                            render();
                            return;
                        }
                    } catch (error) {
                        if (Number(error?.status) !== 404) {
                            throw error;
                        }
                    }
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

    async function reconcileLatestForCurrentChat(options = {}) {
        const fsmState = retryFsm.getState();
        if (fsmState === RetryState.RUNNING || fsmState === RetryState.CAPTURING) {
            return {
                ok: false,
                reason: 'latest_reconcile_skipped',
            };
        }
        if (fsmState === RetryState.ARMED && typeof retryFsm.getContext === 'function') {
            const context = retryFsm.getContext();
            // Fresh manual arm clears `lastTerminalResult`. In that case, do not
            // reconcile a previous terminal job or write its status back into
            // runtime mirrors while the user is waiting to send a new prompt.
            if (!context?.lastTerminalResult) {
                return {
                    ok: false,
                    reason: 'latest_reconcile_skipped',
                };
            }
        }

        const currentChatIdentity = getCurrentChatIdentity?.() || null;
        if (!currentChatIdentity?.chatId || !baseBackendPort?.fetchLatestJob) {
            return {
                ok: false,
                reason: 'latest_reconcile_unavailable',
            };
        }

        const now = Date.now();
        const lastObservedAt = Date.parse(runtime.activeJobStatusObservedAt || runtime.activeJobStatus?.updatedAt || '');
        if (!options.force
            && runtime.activeJobStatus
            && String(runtime.activeJobStatus.state || '') !== 'running'
            && Number.isFinite(lastObservedAt)
            && (now - lastObservedAt) < 1500) {
            return {
                ok: false,
                reason: 'latest_reconcile_throttled',
            };
        }

        const latest = await baseBackendPort.fetchLatestJob(currentChatIdentity);
        if (!latest?.jobId) {
            return {
                ok: false,
                reason: 'latest_job_missing',
            };
        }

        const latestState = String(latest.state || '');
        const targetMessageVersion = Number(latest.targetMessageVersion) || 0;
        if (latestState === 'running' || targetMessageVersion <= 0) {
            return {
                ok: false,
                reason: latestState === 'running' ? 'latest_job_running' : 'latest_job_has_no_renderable_output',
                status: latest,
            };
        }

        await logEvent?.('reconcile_latest_started', `Reconciling latest job output version ${targetMessageVersion}.`, {
            reason: options.reason || 'latest_reconcile',
            jobId: latest.jobId,
            targetMessageVersion,
        });

        const accepted = await updateActiveJob(latest, latest.jobId, {
            recoverTerminal: true,
            reason: options.reason || 'latest_reconcile',
            chatIdentity: currentChatIdentity,
        });
        render();
        if (accepted) {
            await logEvent?.('reconcile_latest_succeeded', `Reconciled latest job output version ${targetMessageVersion}.`, {
                reason: options.reason || 'latest_reconcile',
                jobId: latest.jobId,
                targetMessageVersion,
            });
            return {
                ok: true,
                status: latest,
            };
        }

        await logEvent?.('reconcile_latest_failed', 'Latest output status was rejected by the FSM ingest path.', {
            reason: options.reason || 'latest_reconcile',
            jobId: latest.jobId,
            targetMessageVersion,
        });
        return {
            ok: false,
            status: latest,
            error: null,
        };
    }

    function scheduleRestoreRetry() {
        if (runtime.restoreRetryHandle) {
            return;
        }
        if (restoreRetryCount >= RESTORE_RETRY_CAP) {
            return;
        }
        restoreRetryCount += 1;

        runtime.restoreRetryHandle = windowRef.setTimeout(() => {
            runtime.restoreRetryHandle = 0;
            void restoreControlState();
        }, 250);
    }

    function subscribeChatChangedRestore() {
        if (!subscribeEvent || chatChangedStop) {
            return;
        }
        // Shared handler for CHAT_CHANGED (group / neutral chats) and CHAT_LOADED
        // (character chat reloads). ST emits CHAT_LOADED from getChat() which is
        // gated on this_chid != undefined, while CHAT_CHANGED fires in all other
        // reload paths. Subscribing to both ensures a chat identity change is never
        // silently missed during reloadCurrentChat().
        const onChatIdentityChanged = () => {
            const liveChatIdentity = getCurrentChatIdentity?.() || getChatIdentity();
            if (wasInternalChatReloadRecentlyTriggered(liveChatIdentity)) {
                void logEvent?.('CHAT_IDENTITY_CHANGED_IGNORED', 'Ignored chat identity change triggered by Retry Mobile refreshing the current chat.', null);
                return;
            }
            if (retryFsm.getState() !== RetryState.IDLE) {
                return;
            }
            // ST fires CHAT_CHANGED multiple times in quick succession during a chat
            // reload (e.g. when the browser returns from a hidden state). Debounce so
            // we only attempt restore once, after the chat has had a chance to settle.
            if (chatChangedDebounceHandle) {
                windowRef.clearTimeout(chatChangedDebounceHandle);
            }
            chatChangedDebounceHandle = windowRef.setTimeout(() => {
                chatChangedDebounceHandle = 0;
                void restoreControlState();
            }, 400);
        };

        if (eventTypes?.CHAT_CHANGED) {
            chatChangedStop = subscribeEvent(eventTypes.CHAT_CHANGED, onChatIdentityChanged);
        }
        if (eventTypes?.CHAT_LOADED) {
            chatLoadedStop = subscribeEvent(eventTypes.CHAT_LOADED, onChatIdentityChanged);
        }
    }

    function unsubscribeChatChangedRestore() {
        if (typeof chatChangedStop === 'function') {
            chatChangedStop();
        }
        chatChangedStop = null;
        if (typeof chatLoadedStop === 'function') {
            chatLoadedStop();
        }
        chatLoadedStop = null;
        if (chatChangedDebounceHandle) {
            windowRef.clearTimeout(chatChangedDebounceHandle);
            chatChangedDebounceHandle = 0;
        }
    }

    return {
        restoreControlState,
        reconcileLatestForCurrentChat,
        scheduleRestoreRetry,
        subscribeChatChangedRestore,
        unsubscribeChatChangedRestore,
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
