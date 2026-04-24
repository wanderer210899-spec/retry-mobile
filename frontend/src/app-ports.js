import { getStructuredErrorFromApi } from './backend-api.js';
import { createStructuredError } from './retry-error.js';
import {
    buildRestoreTarget,
    getAttachedJobStatusFromStartError,
    shouldAttachRunningConflict,
} from './app-recovery.js';

export function createAppPorts({
    baseBackendPort,
    getRetryFsm,
    updateActiveJob,
    syncRuntimeFromFsm,
    render,
    buildStartPayload,
    flushPendingNativeOutcome,
}) {
    return {
        ...baseBackendPort,
        startJob(payload) {
            void Promise.resolve()
                .then(() => buildStartPayload(payload))
                .then((startPayload) => baseBackendPort.startJob(startPayload))
                .then((result) => {
                    const retryFsm = getRetryFsm();
                    if (!result?.jobId) {
                        throw createStructuredError(
                            'handoff_request_failed',
                            'Retry Mobile backend start did not return a job id.',
                        );
                    }

                    updateActiveJob(result.job || null, result.jobId);
                    retryFsm.jobStarted({
                        runId: payload.runId,
                        jobId: result.jobId,
                        chatIdentity: payload.chatIdentity,
                        target: payload.target,
                    });
                    syncRuntimeFromFsm(retryFsm);
                    render();
                    void flushPendingNativeOutcome();
                })
                .catch((error) => {
                    handleStartJobFailure({
                        error,
                        payload,
                        retryFsm: getRetryFsm(),
                        updateActiveJob,
                        syncRuntimeFromFsm,
                        render,
                        flushPendingNativeOutcome,
                    });
                });
        },
        startPolling(jobId, onStatus, onError, selectCadence) {
            return baseBackendPort.startPolling(
                jobId,
                async (status) => {
                    await handlePollingPortStatus({
                        status,
                        jobId,
                        updateActiveJob,
                        onStatus,
                        syncRuntimeFromFsm,
                        retryFsm: getRetryFsm(),
                        render,
                    });
                },
                async (error) => {
                    await onError?.(toStructuredError(error, 'Retry Mobile backend polling failed.'));
                    syncRuntimeFromFsm(getRetryFsm());
                    render();
                },
                selectCadence,
            );
        },
        async confirmNative(jobId, payload) {
            const result = await baseBackendPort.confirmNative(jobId, payload);
            return handleJobPortResponse({
                result,
                jobId,
                updateActiveJob,
                render,
            });
        },
        async reportNativeFailure(jobId, payload) {
            const result = await baseBackendPort.reportNativeFailure(jobId, payload);
            return handleJobPortResponse({
                result,
                jobId,
                updateActiveJob,
                render,
            });
        },
        async reportFrontendPresence(jobId, payload) {
            const result = await baseBackendPort.reportFrontendPresence(jobId, payload);
            return handleJobPortResponse({
                result,
                jobId,
                updateActiveJob,
                render,
            });
        },
        async cancelJob(jobId, payload) {
            return baseBackendPort.cancelJob(jobId, payload);
        },
    };
}

export function handleStartJobFailure({
    error,
    payload,
    retryFsm,
    updateActiveJob,
    syncRuntimeFromFsm,
    render,
    flushPendingNativeOutcome,
}) {
    const attachedStatus = getAttachedJobStatusFromStartError(error);
    if (attachedStatus?.jobId) {
        const current = retryFsm.getContext();
        if (shouldAttachRunningConflict(
            retryFsm.getState(),
            current.runId,
            payload.runId,
        )) {
            updateActiveJob(attachedStatus, attachedStatus.jobId);
            retryFsm.restoreRunning({
                status: attachedStatus,
                runId: attachedStatus.runId || payload.runId,
                jobId: attachedStatus.jobId,
                chatIdentity: attachedStatus.chatIdentity || current.chatIdentity || payload.chatIdentity,
                target: buildRestoreTarget(attachedStatus, current.target),
            });
            syncRuntimeFromFsm(retryFsm);
            render();
            void flushPendingNativeOutcome?.();
            return;
        }
    }

    retryFsm.jobFailed({
        chatIdentity: payload.chatIdentity,
        error: attachedStatus?.jobId
            ? createStructuredError(
                'attach_conflict_rejected',
                'Retry Mobile refused to attach to a conflicting backend job because it no longer matches the active capture run.',
                [
                    attachedStatus.jobId ? `conflict_job_id=${attachedStatus.jobId}` : '',
                    attachedStatus.runId ? `conflict_run_id=${attachedStatus.runId}` : '',
                    payload.runId ? `capture_run_id=${payload.runId}` : '',
                ].filter(Boolean).join(' | '),
            )
            : toStructuredError(error, 'Retry Mobile could not start the backend retry job.'),
    });
    syncRuntimeFromFsm(retryFsm);
    render();
}

export async function handlePollingPortStatus({
    status,
    jobId,
    updateActiveJob,
    onStatus,
    syncRuntimeFromFsm,
    retryFsm,
    render,
}) {
    updateActiveJob(status || null, jobId);
    await onStatus?.(status);
    syncRuntimeFromFsm(retryFsm);
    render();
}

export function handleJobPortResponse({
    result,
    jobId,
    updateActiveJob,
    render,
}) {
    if (result?.job && updateActiveJob(result.job, jobId)) {
        render();
    }

    return result;
}

function toStructuredError(error, fallbackMessage) {
    if (error?.code && error?.message) {
        return error;
    }

    return getStructuredErrorFromApi(error, fallbackMessage);
}
