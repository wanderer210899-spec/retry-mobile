import { PANEL_ID, RUN_STATE, LOG_PREFIX } from '../constants.js';
import { createLogger } from '../logger.js';
import { fetchActiveJob, fetchLatestJob } from '../backend-api.js';
import { syncRestoredStatus, clearCommittedReloads } from '../chat-sync.js';
import { getChatIdentity, getContext } from '../st-context.js';
import { reloadCurrentChatSafe } from '../st-chat.js';
import { clearRetryLog, sendFrontendLogEvent, syncRetryLogForStatus } from '../logs/retry-log.js';

const backendLog = createLogger(LOG_PREFIX.BACKEND);

export function createRecoveryController({ runtime, render, statusController, ensurePanelMounted }) {
    return {
        bindFrontendRecoverySignals,
        bindHostObserver,
        scheduleMountRetry,
        scheduleBackendRecovery,
        recoverFrontendFromBackend,
        restoreActiveJob,
    };

    async function restoreActiveJob() {
        await recoverFrontendFromBackend('boot', {
            reloadWhenMissing: true,
        });
    }

    async function recoverFrontendFromBackend(reason, options = {}) {
        if (runtime.recoveryPromise) {
            return await runtime.recoveryPromise;
        }

        runtime.recoveryPromise = (async () => {
            const identity = getChatIdentity(getContext());
            if (!identity?.chatId) {
                return false;
            }

            await statusController.refreshChatState(identity);

            try {
                const status = await fetchActiveJob(identity);
                if (status?.jobId) {
                    await restoreRunningJobStatus(status, identity, reason);
                    return true;
                }

                const latestStatus = await fetchLatestJob(identity);
                if (latestStatus?.jobId) {
                    runtime.activeJobId = null;
                    statusController.clearActiveBackendStatus();
                    await syncRetryLogForStatus(runtime, latestStatus, { force: true, clearWhenMissing: false });
                    clearCommittedReloads(runtime);
                    await reloadCurrentChatSafe();
                    render();
                    return true;
                }

                if (options.reloadWhenMissing) {
                    clearRetryLog(runtime);
                    await reloadCurrentChatSafe();
                    render();
                }
            } catch (error) {
                backendLog.warn(`Could not recover frontend state from backend (${reason}).`, error);
                statusController.noteTransportError(error, 'backend', 'restore_failed', `Could not recover frontend state from backend (${reason}).`, {
                    endpoint: '/active-or-latest',
                    occurredDuring: 'restore',
                });
            }

            return false;
        })();

        try {
            return await runtime.recoveryPromise;
        } finally {
            runtime.recoveryPromise = null;
        }
    }

    function bindFrontendRecoverySignals() {
        if (runtime.recoverySignalsBound) {
            return;
        }

        runtime.recoverySignalsBound = true;
        document.addEventListener('visibilitychange', () => {
            void sendFrontendLogEvent(runtime, {
                event: 'visibility_changed',
                summary: `Frontend visibility changed to ${document.visibilityState}.`,
                detail: {
                    visibilityState: document.visibilityState,
                },
            });
            if (document.visibilityState === 'visible') {
                scheduleBackendRecovery('page_visible');
            }
        });
        window.addEventListener('focus', () => {
            void sendFrontendLogEvent(runtime, {
                event: 'window_focus',
                summary: 'Frontend window regained focus.',
                detail: null,
            });
            scheduleBackendRecovery('window_focus');
        });
        window.addEventListener('online', () => {
            void sendFrontendLogEvent(runtime, {
                event: 'browser_online',
                summary: 'Frontend browser reported an online transition.',
                detail: null,
            });
            scheduleBackendRecovery('browser_online');
        });
    }

    function bindHostObserver() {
        if (runtime.hostObserver || !document.body) {
            return;
        }

        runtime.hostObserver = new MutationObserver(() => {
            if (!document.getElementById(PANEL_ID)) {
                ensurePanelMounted();
            }
        });

        runtime.hostObserver.observe(document.body, {
            childList: true,
            subtree: true,
        });
    }

    function scheduleMountRetry() {
        if (runtime.mountRetryHandle) {
            return;
        }

        runtime.mountRetryHandle = window.setTimeout(() => {
            runtime.mountRetryHandle = 0;
            ensurePanelMounted();
        }, 900);
    }

    function scheduleBackendRecovery(reason, delayMs = 0) {
        if (!shouldAttemptFrontendRecovery()) {
            return;
        }

        if (runtime.recoveryHandle) {
            window.clearTimeout(runtime.recoveryHandle);
        }

        runtime.recoveryHandle = window.setTimeout(() => {
            runtime.recoveryHandle = 0;
            void recoverFrontendFromBackend(reason);
        }, Math.max(0, Number(delayMs) || 0));
    }

    async function restoreRunningJobStatus(status, identity, reason = 'restored') {
        const runId = status.runId || status.jobId;
        const snapshot = runtime.machine.getSnapshot();
        const hasLiveSameRun = runtime.activeJobId === status.jobId
            && snapshot.runId === runId
            && snapshot.activeRunId === runId;

        if (!hasLiveSameRun) {
            runtime.machine.startRun({
                runId,
                chatIdentity: status.chatIdentity || identity,
            });
        }

        statusController.syncRuntimeStateFromStatus(status.runId || status.jobId, status, {
            previousStatus: runtime.activeJobStatus,
            announceTransitions: false,
        });
        runtime.machine.clearError();
        runtime.machine.setBackendEvent(reason, `Recovered backend job ${status.jobId}.`);
        runtime.machine.recordEvent('backend', reason, `Recovered backend job ${status.jobId}.`);
        runtime.activeJobId = status.jobId;
        statusController.setActiveBackendStatus(status, 'live_active');
        clearCommittedReloads(runtime);
        runtime.lastAppliedVersion = 0;
        await syncRestoredStatus(status, runtime);
        await syncRetryLogForStatus(runtime, status, { force: true, clearWhenMissing: false });
        void sendFrontendLogEvent(runtime, {
            event: 'frontend_restored',
            summary: `Frontend restored backend job ${status.jobId} after ${reason}.`,
            detail: {
                reason,
            },
        });

        if (status.state === 'running') {
            statusController.ensurePolling(status.runId || status.jobId, 0);
        } else {
            runtime.machine.releaseRun();
        }

        render();
    }

    function shouldAttemptFrontendRecovery() {
        const state = statusController.getCurrentState();
        return Boolean(runtime.activeJobId)
            || state === RUN_STATE.CAPTURED_PENDING_NATIVE
            || state === RUN_STATE.NATIVE_CONFIRMED
            || state === RUN_STATE.NATIVE_ABANDONED
            || state === RUN_STATE.BACKEND_RUNNING
            || state === RUN_STATE.FAILED;
    }
}
