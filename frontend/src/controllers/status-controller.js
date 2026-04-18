import {
    EXTENSION_NAME,
    LOG_PREFIX,
    POLL_INTERVAL_FAST_MS,
    POLL_INTERVAL_SLOW_MS,
    POLL_INTERVAL_STEADY_MS,
    RUN_STATE,
} from '../constants.js';
import { createLogger } from '../logger.js';
import {
    fetchChatState,
    fetchJobOrphans,
    fetchJobStatus,
} from '../backend-api.js';
import {
    getChatIdentity,
    getContext,
    showToast,
    subscribeEvent,
} from '../st-context.js';
import { reloadCurrentChatSafe } from '../st-chat.js';
import { clearCommittedReloads, syncRemoteStatus } from '../chat-sync.js';
import {
    createStructuredError,
    formatStructuredError,
    normalizeStructuredError,
} from '../retry-error.js';
import {
    clearRetryLog,
    sendFrontendLogEvent,
    syncRetryLogForStatus,
} from '../logs/retry-log.js';
import { isRunningLikeState, resolveRunStateFromStatus } from '../core/run-state.js';

const backendLog = createLogger(LOG_PREFIX.BACKEND);

export function createStatusController({ runtime, render }) {
    let scheduleBackendRecovery = () => {};
    let recoverFrontendFromBackend = async () => false;
    let autoRearmAfterRun = async () => {};

    return {
        setRecoveryHandlers,
        setAutoRearmHandler,
        getCurrentState,
        applyErrorState,
        refreshChatState,
        bindChatStateRefresh,
        startPolling,
        clearPolling,
        ensurePolling,
        syncRuntimeStateFromStatus,
        adoptBackendStatus,
        applyTerminalState,
        setActiveBackendStatus,
        clearActiveBackendStatus,
        noteTransportError,
        shouldDeferBackendDisconnect,
        deferBackendDisconnect,
    };

    function setRecoveryHandlers(handlers) {
        scheduleBackendRecovery = handlers?.schedule || (() => {});
        recoverFrontendFromBackend = handlers?.recover || (async () => false);
    }

    function setAutoRearmHandler(handler) {
        autoRearmAfterRun = handler || (async () => {});
    }

    function getCurrentState() {
        return runtime.machine.getSnapshot().state;
    }

    function applyErrorState(error) {
        runtime.machine.setError(normalizeStructuredError(error));
        runtime.machine.transition(RUN_STATE.FAILED);
        runtime.machine.releaseRun();
        render();
    }

    async function refreshChatState(identity = getChatIdentity(getContext())) {
        if (!identity?.chatId) {
            runtime.chatState = null;
            clearRetryLog(runtime);
            render();
            return null;
        }

        try {
            runtime.chatState = await fetchChatState(identity);
        } catch (error) {
            backendLog.warn('Could not fetch Retry Mobile chat state.', error);
            noteTransportError(error, 'backend', 'chat_state_failed', 'Retry Mobile could not fetch backend chat state.', {
                endpoint: '/state',
                occurredDuring: 'restore',
            });
        }

        render();
        return runtime.chatState;
    }

    function bindChatStateRefresh() {
        const context = getContext();
        const eventTypes = context?.eventTypes;
        if (!eventTypes?.CHAT_CHANGED) {
            return;
        }

        subscribeEvent(eventTypes.CHAT_CHANGED, () => {
            clearCommittedReloads(runtime);
            void refreshChatState();
        }, getContext());
    }

    function startPolling(runId) {
        clearPolling();
        const pollSessionId = runtime.machine.startPollSession();
        runtime.pollUnchangedCount = 0;
        runtime.pollTransientFailures = 0;
        runtime.pollUnexpectedServerFailures = 0;
        runtime.pollSignature = '';
        runtime.pollHandle = window.setTimeout(() => {
            void pollStatus(runId, pollSessionId);
        }, 0);
    }

    function clearPolling() {
        if (runtime.pollHandle) {
            window.clearTimeout(runtime.pollHandle);
            runtime.pollHandle = 0;
        }

        runtime.pollUnchangedCount = 0;
        runtime.pollTransientFailures = 0;
        runtime.pollUnexpectedServerFailures = 0;
        runtime.pollSignature = '';
        runtime.machine.clearPollSession(runtime.machine.getSnapshot().pollSessionId);
    }

    function ensurePolling(runId, delayMs = 0) {
        if (!runtime.machine.isCurrentRun(runId) || !runtime.activeJobId) {
            return;
        }

        const pollSessionId = runtime.machine.getSnapshot().pollSessionId;
        if (!pollSessionId || !runtime.machine.isCurrentPollSession(pollSessionId)) {
            startPolling(runId);
            return;
        }

        if (!runtime.pollHandle) {
            scheduleNextPoll(runId, pollSessionId, delayMs);
        }
    }

    function syncRuntimeStateFromStatus(runId, status, options = {}) {
        if (!runtime.machine.isCurrentRun(runId) || !status?.jobId) {
            return;
        }

        const previousStatus = options.previousStatus || null;
        const nextState = resolveRunStateFromStatus(status);
        const snapshot = runtime.machine.getSnapshot();

        if (nextState && snapshot.state !== nextState) {
            runtime.machine.transition(nextState);
        }

        runtime.machine.setOwnsTurn(Boolean(status.nativeState && status.nativeState !== 'pending'));

        if (!options.announceTransitions) {
            return;
        }

        const previousNativeState = previousStatus?.nativeState || '';
        const nextNativeState = status.nativeState || '';
        if (previousNativeState === nextNativeState) {
            return;
        }

        runtime.machine.recordEvent('backend', 'native_state', `Backend native state changed: ${previousNativeState || 'none'} -> ${nextNativeState || 'none'}.`);

        if (nextNativeState === 'abandoned') {
            const message = status.recoveryMode === 'reuse_empty_placeholder'
                ? 'Native first reply was abandoned. Retry Mobile reused the empty native placeholder.'
                : 'Native first reply was abandoned. Retry Mobile created the missing assistant turn.';
            showToast('info', EXTENSION_NAME, message);
            return;
        }

        if (previousNativeState === 'pending' && nextNativeState === 'confirmed') {
            showToast('info', EXTENSION_NAME, 'Native first reply was confirmed. Retry Mobile will handle the remaining retries.');
        }
    }

    async function adoptBackendStatus(runId, sourceError = null, options = {}) {
        const requestedJobId = runtime.activeJobId;
        if (!requestedJobId) {
            return false;
        }

        let status = sourceError?.payload?.job || null;
        if (!status) {
            try {
                status = await fetchJobStatus(requestedJobId);
            } catch {
                return false;
            }
        }

        if (!status?.jobId || !runtime.machine.isCurrentRun(runId) || runtime.activeJobId !== requestedJobId) {
            return false;
        }

        const previousStatus = runtime.activeJobStatus;
        setActiveBackendStatus(status, 'live_active');
        syncRuntimeStateFromStatus(runId, status, {
            previousStatus,
            announceTransitions: Boolean(options.announceTransitions),
        });
        render();

        if (status.state === 'completed') {
            await applyTerminalState(runId, RUN_STATE.COMPLETED, {
                toastKind: 'success',
                toastMessage: 'Retry Mobile finished this turn.',
            });
            return true;
        }

        if (status.state === 'failed') {
            const structured = status.structuredError || createStructuredError(
                'backend_write_failed',
                status.lastError || 'The backend job failed.',
            );
            await applyTerminalState(runId, RUN_STATE.FAILED, {
                error: structured,
                toastKind: 'warning',
                toastMessage: formatStructuredError(structured),
            });
            return true;
        }

        if (status.state === 'cancelled') {
            await applyTerminalState(runId, RUN_STATE.CANCELLED, {
                toastKind: 'info',
                toastMessage: 'Retry Mobile stopped.',
            });
            return true;
        }

        return status.state === 'running';
    }

    async function applyTerminalState(runId, nextState, options = {}) {
        if (runId && !runtime.machine.isCurrentRun(runId) && runtime.machine.getSnapshot().runId !== runId) {
            return;
        }

        const previousChatIdentity = runtime.machine.getSnapshot().chatIdentity;
        clearCaptureSession();
        clearPolling();

        const normalizedError = options.error
            ? normalizeStructuredError(options.error, 'unknown_error', options.error.message || 'Retry Mobile failed.')
            : null;

        if (normalizedError) {
            runtime.machine.setError(normalizedError);
        } else {
            runtime.machine.clearError();
        }

        if (nextState === RUN_STATE.FAILED && runtime.transportErrorContext) {
            runtime.disconnectPolicy = 'failed';
        }

        runtime.machine.setOwnsTurn(false);
        runtime.machine.transition(nextState);
        runtime.machine.releaseRun();

        if (runtime.activeJobStatus?.jobId && Number(runtime.activeJobStatus?.orphanedAcceptedPreview?.count) > 0) {
            try {
                const orphanResult = await fetchJobOrphans(runtime.activeJobStatus.jobId);
                if (orphanResult?.items) {
                    runtime.activeJobStatus.orphanedAcceptedResults = orphanResult.items;
                }
            } catch (error) {
                backendLog.warn('Could not fetch orphaned accepted outputs.', error);
            }
        }

        await syncRetryLogForStatus(runtime, runtime.activeJobStatus, {
            force: true,
            clearWhenMissing: false,
        });

        runtime.activeJobId = null;
        runtime.nativeFailureReported = false;
        clearCommittedReloads(runtime);
        await refreshChatState(previousChatIdentity || getChatIdentity(getContext()));

        render();

        if (options.toastMessage) {
            showToast(options.toastKind || 'info', EXTENSION_NAME, options.toastMessage);
        }

        await autoRearmAfterRun(nextState);
    }

    function setActiveBackendStatus(status, source = 'live_active') {
        runtime.activeJobStatus = status || null;
        runtime.activeJobStatusSource = status ? source : 'none';
        runtime.activeJobStatusObservedAt = status ? getStatusObservedAt(status) : null;
        if (status) {
            clearTransportErrorIfRecovered(status);
        }
        return runtime.activeJobStatus;
    }

    function clearActiveBackendStatus() {
        runtime.activeJobStatus = null;
        runtime.activeJobStatusSource = 'none';
        runtime.activeJobStatusObservedAt = null;
    }

    function noteTransportError(error, source, eventName, summary, context = {}) {
        const status = Number(error?.status);
        const isTransportLoss = !Number.isFinite(status);
        const endpoint = String(context.endpoint || '');
        const transportContext = {
            endpoint,
            message: error?.message || summary || 'Request failed.',
            timestamp: new Date().toISOString(),
            visibilityAtFailure: getFrontendVisibility(),
            onlineAtFailure: getFrontendOnline(),
            occurredDuring: context.occurredDuring || 'polling',
        };

        if (isTransportLoss) {
            runtime.lastTransportError = transportContext.message;
            runtime.lastTransportEndpoint = endpoint;
            runtime.lastTransportErrorAt = transportContext.timestamp;
            runtime.transportErrorContext = transportContext;
        }

        runtime.machine.recordEvent(source, eventName, summary, transportContext);
        void sendFrontendLogEvent(runtime, {
            event: eventName,
            summary,
            detail: transportContext,
        });
    }

    function shouldDeferBackendDisconnect(error) {
        return !Number.isFinite(Number(error?.status));
    }

    function deferBackendDisconnect(runId, eventName, summary) {
        if (!runtime.machine.isCurrentRun(runId)) {
            return;
        }

        runtime.disconnectPolicy = 'deferred_to_backend_truth';
        runtime.machine.clearError();
        runtime.machine.setBackendEvent('connection_lost', summary);
        runtime.machine.recordEvent('backend', eventName, summary);
        void sendFrontendLogEvent(runtime, {
            event: eventName,
            summary,
            detail: {
                disconnectPolicy: 'deferred_to_backend_truth',
            },
        });

        const fallbackState = resolveRunStateFromStatus(runtime.activeJobStatus) || RUN_STATE.BACKEND_RUNNING;
        if (!isRunningLikeState(runtime.machine.getSnapshot().state)) {
            runtime.machine.transition(fallbackState);
        }

        render();
        ensurePolling(runId, POLL_INTERVAL_FAST_MS);

        if (document.visibilityState === 'visible') {
            scheduleBackendRecovery('deferred_disconnect', POLL_INTERVAL_FAST_MS);
        }
    }

    async function pollStatus(runId, pollSessionId) {
        if (!runtime.machine.isCurrentRun(runId) || !runtime.machine.isCurrentPollSession(pollSessionId) || !runtime.activeJobId) {
            return;
        }

        const requestedJobId = runtime.activeJobId;
        try {
            const status = await fetchJobStatus(requestedJobId);
            if (!runtime.machine.isCurrentRun(runId) || !runtime.machine.isCurrentPollSession(pollSessionId)) {
                runtime.machine.recordEvent('backend', 'stale_poll_ignored', `Ignored stale status response for ${requestedJobId}.`);
                render();
                return;
            }

            if (status?.runId && status.runId !== runId) {
                runtime.machine.recordEvent('backend', 'stale_poll_ignored', `Ignored status for a different run id (${status.runId}).`);
                render();
                return;
            }

            const previousStatus = runtime.activeJobStatus;
            const previousAccepted = Number(previousStatus?.acceptedCount) || 0;
            setActiveBackendStatus(status, 'live_active');
            const signatureChanged = updatePollSignature(status);
            runtime.pollTransientFailures = 0;
            runtime.pollUnexpectedServerFailures = 0;
            runtime.pollUnchangedCount = signatureChanged ? 0 : (runtime.pollUnchangedCount + 1);
            syncRuntimeStateFromStatus(runId, status, {
                previousStatus,
                announceTransitions: true,
            });
            runtime.machine.setBackendEvent(status.phase || status.state || 'status', `Backend reported ${status.state || 'unknown'}.`);
            runtime.machine.recordEvent('backend', 'status', `Backend reported ${status.state || 'unknown'} (${status.acceptedCount || 0}/${status.targetAcceptedCount || 0}).`);

            const refreshed = await syncRemoteStatus(status, runtime);
            if (refreshed) {
                runtime.machine.recordEvent('backend', 'chat_reloaded', 'Reloaded the native chat after a new accepted swipe.');
            }

            if (Number(status.acceptedCount) > previousAccepted && runtime.settings.notifyOnSuccess) {
                showToast('success', EXTENSION_NAME, `Retry Mobile accepted ${status.acceptedCount}/${status.targetAcceptedCount} generations.`);
            }

            if (signatureChanged || runtime.retryLogJobId !== status.jobId) {
                await syncRetryLogForStatus(runtime, status, {
                    force: false,
                    clearWhenMissing: false,
                });
            }

            if (status.state === 'completed') {
                await applyTerminalState(runId, RUN_STATE.COMPLETED, {
                    toastKind: 'success',
                    toastMessage: 'Retry Mobile finished this turn.',
                });
                return;
            }

            if (status.state === 'failed') {
                const structured = status.structuredError || createStructuredError(
                    'backend_write_failed',
                    status.lastError || 'The backend job failed.',
                );
                await applyTerminalState(runId, RUN_STATE.FAILED, {
                    error: structured,
                    toastKind: 'warning',
                    toastMessage: formatStructuredError(structured),
                });
                return;
            }

            if (status.state === 'cancelled') {
                await applyTerminalState(runId, RUN_STATE.CANCELLED, {
                    toastKind: 'info',
                    toastMessage: 'Retry Mobile stopped.',
                });
                return;
            }

            render();
            scheduleNextPoll(runId, pollSessionId, getNextPollDelay());
        } catch (error) {
            backendLog.warn('Status poll failed.', error);
            if (!runtime.machine.isCurrentRun(runId) || !runtime.machine.isCurrentPollSession(pollSessionId) || runtime.activeJobId !== requestedJobId) {
                return;
            }
            noteTransportError(error, 'backend', 'poll_failed', error?.message || 'Status poll failed.', {
                endpoint: '/status',
                occurredDuring: 'polling',
            });
            const failureKind = classifyPollFailure(error);
            if (failureKind === 'fatal') {
                const recovered = await recoverFrontendFromBackend('poll_fatal');
                if (recovered) {
                    return;
                }
                await reloadCurrentChatSafe();
                await applyTerminalState(runId, RUN_STATE.FAILED, {
                    error: createStructuredError(
                        'backend_job_missing',
                        error?.status === 404
                            ? 'Retry Mobile lost the backend job while polling. The backend process may have restarted or been suspended.'
                            : 'Retry Mobile hit a fatal backend polling error and stopped instead of guessing.',
                    ),
                    toastKind: 'warning',
                    toastMessage: error?.status === 404
                        ? 'Retry Mobile lost the backend job while polling.'
                        : 'Retry Mobile stopped after a fatal backend polling error.',
                });
                return;
            }

            if (failureKind === 'unexpected_5xx') {
                runtime.pollUnexpectedServerFailures += 1;
                if (runtime.pollUnexpectedServerFailures >= 3) {
                    await applyTerminalState(runId, RUN_STATE.FAILED, {
                        error: createStructuredError(
                            'backend_polling_failed',
                            'Retry Mobile stopped after repeated unexpected backend server errors while polling status.',
                        ),
                        toastKind: 'warning',
                        toastMessage: 'Retry Mobile stopped after repeated backend polling errors.',
                    });
                    return;
                }
            } else {
                runtime.pollTransientFailures += 1;
                runtime.pollUnexpectedServerFailures = 0;
            }

            render();
            scheduleNextPoll(runId, pollSessionId, getNextPollDelay());
        }
    }

    function scheduleNextPoll(runId, pollSessionId, delayMs) {
        clearScheduledPollOnly();
        if (!runtime.machine.isCurrentRun(runId) || !runtime.machine.isCurrentPollSession(pollSessionId)) {
            return;
        }

        const jitterMultiplier = 0.85 + (Math.random() * 0.3);
        runtime.pollHandle = window.setTimeout(() => {
            void pollStatus(runId, pollSessionId);
        }, Math.round(delayMs * jitterMultiplier));
    }

    function clearScheduledPollOnly() {
        if (!runtime.pollHandle) {
            return;
        }

        window.clearTimeout(runtime.pollHandle);
        runtime.pollHandle = 0;
    }

    function getNextPollDelay() {
        if (runtime.pollUnexpectedServerFailures > 0 || runtime.pollTransientFailures >= 3 || runtime.pollUnchangedCount >= 15) {
            return POLL_INTERVAL_SLOW_MS;
        }

        if (runtime.pollUnchangedCount >= 5) {
            return POLL_INTERVAL_STEADY_MS;
        }

        return POLL_INTERVAL_FAST_MS;
    }

    function updatePollSignature(status) {
        const nextSignature = JSON.stringify({
            updatedAt: status?.updatedAt || '',
            logUpdatedAt: status?.logUpdatedAt || '',
            logEntryCount: Number(status?.logEntryCount) || 0,
            state: status?.state || '',
            phase: status?.phase || '',
            nativeState: status?.nativeState || '',
            acceptedCount: Number(status?.acceptedCount) || 0,
            attemptCount: Number(status?.attemptCount) || 0,
            attemptLogLength: Array.isArray(status?.attemptLog) ? status.attemptLog.length : 0,
            targetMessageVersion: Number(status?.targetMessageVersion) || 0,
            cancelRequested: Boolean(status?.cancelRequested),
            structuredErrorCode: status?.structuredError?.code || '',
        });
        const changed = runtime.pollSignature !== nextSignature;
        runtime.pollSignature = nextSignature;
        return changed;
    }

    function classifyPollFailure(error) {
        const status = Number(error?.status);
        if (!Number.isFinite(status)) {
            return 'transient';
        }

        if (status === 429 || status === 502 || status === 503 || status === 504) {
            return 'transient';
        }

        if (status === 500 || status >= 505) {
            return 'unexpected_5xx';
        }

        if (status === 400 || status === 401 || status === 403 || status === 404) {
            return 'fatal';
        }

        return 'transient';
    }

    function clearTransportErrorIfRecovered(status) {
        if (!status?.jobId) {
            return;
        }

        if (!runtime.transportErrorContext) {
            return;
        }

        runtime.disconnectPolicy = 'deferred_to_backend_truth';
    }

    function clearCaptureSession() {
        if (!runtime.captureSession) {
            return;
        }

        try {
            runtime.captureSession.stop?.();
        } catch (error) {
            backendLog.warn('Capture session cleanup failed.', error);
        }
        runtime.captureSession = null;
    }

    function getFrontendVisibility() {
        return document.visibilityState === 'visible'
            ? 'visible'
            : 'hidden';
    }

    function getFrontendOnline() {
        if (typeof navigator?.onLine !== 'boolean') {
            return 'unknown';
        }

        return navigator.onLine ? 'online' : 'offline';
    }

    function getStatusObservedAt(status) {
        return status?.updatedAt || status?.createdAt || null;
    }
}
