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
    onStatusPolled,
    logEvent = null,
}) {
    return {
        ...baseBackendPort,
        startJob(payload) {
            void Promise.resolve()
                .then(() => buildStartPayload(payload))
                .then((startPayload) => baseBackendPort.startJob(startPayload))
                .then(async (result) => {
                    const retryFsm = getRetryFsm();
                    if (!result?.jobId) {
                        throw createStructuredError(
                            'handoff_request_failed',
                            'Retry Mobile backend start did not return a job id.',
                        );
                    }

                    retryFsm.jobStarted({
                        runId: payload.runId,
                        jobId: result.jobId,
                        chatIdentity: payload.chatIdentity,
                        target: payload.target,
                    });
                    await updateActiveJob(
                        result.job?.state === 'running' ? result.job : null,
                        result.jobId,
                    );
                    syncRuntimeFromFsm(retryFsm);
                    render();
                    void flushPendingNativeOutcome();
                })
                .catch((error) => {
                    void handleStartJobFailure({
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
                    const accepted = await handlePollingPortStatus({
                        status,
                        jobId,
                        updateActiveJob,
                        onStatus,
                        syncRuntimeFromFsm,
                        retryFsm: getRetryFsm(),
                        render,
                        logEvent,
                    });
                    if (accepted) {
                        await onStatusPolled?.(status);
                    }
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
            return await handleJobPortResponse({
                result,
                jobId,
                runId: payload?.runId,
                updateActiveJob,
                render,
                logEvent,
                source: 'confirm_native_response',
            });
        },
        async reportNativeFailure(jobId, payload) {
            const result = await baseBackendPort.reportNativeFailure(jobId, payload);
            return await handleJobPortResponse({
                result,
                jobId,
                runId: payload?.runId,
                updateActiveJob,
                render,
                logEvent,
                source: 'native_failed_response',
            });
        },
        async reportFrontendPresence(jobId, payload) {
            const result = await baseBackendPort.reportFrontendPresence(jobId, payload);
            return await handleJobPortResponse({
                result,
                jobId,
                runId: payload?.runId,
                updateActiveJob,
                render,
                logEvent,
                source: 'frontend_presence_response',
            });
        },
        async reportTargetMutation(jobId, payload) {
            const result = await baseBackendPort.reportTargetMutation(jobId, payload);
            return await handleJobPortResponse({
                result,
                jobId,
                runId: payload?.runId,
                updateActiveJob,
                render,
                logEvent,
                source: 'target_mutation_response',
            });
        },
        async cancelJob(jobId, payload) {
            return baseBackendPort.cancelJob(jobId, payload);
        },
    };
}

export async function handleStartJobFailure({
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
        // Compare against the conflicting job's runId (from the 409 payload),
        // not against payload.runId — those are the SAME value and the guard
        // would always pass, allowing us to re-attach to a cancelling job from
        // a previous Stop. With attachedStatus.runId we only attach when the
        // running conflict really belongs to this capture run.
        if (shouldAttachRunningConflict(
            retryFsm.getState(),
            current.runId,
            attachedStatus.runId,
        )) {
            retryFsm.restoreRunning({
                status: attachedStatus,
                runId: attachedStatus.runId || payload.runId,
                jobId: attachedStatus.jobId,
                chatIdentity: attachedStatus.chatIdentity || current.chatIdentity || payload.chatIdentity,
                target: buildRestoreTarget(attachedStatus, current.target),
            });
            await updateActiveJob(attachedStatus, attachedStatus.jobId);
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
    logEvent = null,
}) {
    const statusJobId = String(status?.jobId || '').trim();
    const expectedJobId = String(jobId || '').trim();
    if (statusJobId && expectedJobId && statusJobId !== expectedJobId) {
        logEvent?.(
            'status_response_rejected',
            `Ignored polling status for job ${statusJobId}; polling job is ${expectedJobId}.`,
            buildResponseMismatchDetail({
                source: 'poll_status',
                reason: 'job_id_mismatch',
                expectedJobId,
                responseJob: status,
            }),
        );
        return false;
    }
    const accepted = await updateActiveJob(status || null, jobId);
    if (!accepted) {
        return false;
    }
    syncRuntimeFromFsm(retryFsm);
    render();
    return true;
}

export async function handleJobPortResponse({
    result,
    jobId,
    runId = '',
    updateActiveJob,
    render,
    logEvent = null,
    source = 'job_response',
}) {
    const mismatch = getJobResponseMismatch(result?.job, jobId, runId);
    if (mismatch) {
        logEvent?.(
            'job_response_rejected',
            buildJobResponseRejectedSummary(mismatch),
            buildResponseMismatchDetail({
                source,
                ...mismatch,
                responseJob: result?.job,
            }),
        );
        return result;
    }

    if (result?.job && await updateActiveJob(result.job, jobId)) {
        render();
    }

    return result;
}

function getJobResponseMismatch(job, expectedJobId, expectedRunId = '') {
    if (!job) {
        return null;
    }

    const responseJobId = String(job.jobId || '').trim();
    const jobId = String(expectedJobId || '').trim();
    if (jobId && responseJobId && responseJobId !== jobId) {
        return {
            reason: 'job_id_mismatch',
            expectedJobId: jobId,
            responseJobId,
        };
    }

    const responseRunId = String(job.runId || '').trim();
    const runId = String(expectedRunId || '').trim();
    if (runId && responseRunId && responseRunId !== runId) {
        return {
            reason: 'run_id_mismatch',
            expectedJobId: jobId || responseJobId || '',
            responseJobId,
            expectedRunId: runId,
            responseRunId,
        };
    }

    return null;
}

function buildJobResponseRejectedSummary(mismatch) {
    if (mismatch.reason === 'run_id_mismatch') {
        return `Ignored backend job response for run ${mismatch.responseRunId}; active run is ${mismatch.expectedRunId}.`;
    }

    return `Ignored backend job response for job ${mismatch.responseJobId}; active job is ${mismatch.expectedJobId}.`;
}

function buildResponseMismatchDetail({
    source,
    reason,
    expectedJobId = '',
    responseJobId = '',
    expectedRunId = '',
    responseRunId = '',
    responseJob = null,
}) {
    return {
        source,
        reason,
        expectedJobId: expectedJobId || '',
        responseJobId: responseJobId || String(responseJob?.jobId || ''),
        expectedRunId: expectedRunId || '',
        responseRunId: responseRunId || String(responseJob?.runId || ''),
        responseState: String(responseJob?.state || ''),
        responsePhase: String(responseJob?.phase || ''),
        responseRevision: Number.isFinite(Number(responseJob?.revision))
            ? Number(responseJob.revision)
            : null,
        responseTargetMessageVersion: Number.isFinite(Number(responseJob?.targetMessageVersion))
            ? Number(responseJob.targetMessageVersion)
            : null,
    };
}

function toStructuredError(error, fallbackMessage) {
    if (error?.code && error?.message) {
        return error;
    }

    return getStructuredErrorFromApi(error, fallbackMessage);
}
