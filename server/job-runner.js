const { acquireWakeLock, notify, releaseWakeLock } = require('./notifier');
const { appendJobLog } = require('./job-log-store');
const { pruneTerminalJobUnits } = require('./job-store');
const { createStructuredError, toStructuredError } = require('./retry-error');
const { countTextTokensWithSt } = require('./st-runtime');
const { validateAcceptedText } = require('./validation');
const { appendAttemptLog, touchJob } = require('./state');
const {
    assertWritePathReady,
    inspectNativeAssistantState,
    writeAcceptedResult,
} = require('./chat-writer');

const NATIVE_PENDING_POLL_MS = 1000;
const FORCED_NATIVE_INSPECTION_DELAYS_MS = [0, 1000, 2000, 4000, 8000];
const FRONTEND_CONFIRMED_PERSIST_DELAYS_MS = [0, 250, 500, 1000, 1500];
const BASE_RETRY_DELAY_MS = 750;
const MAX_RETRY_DELAY_MS = 10000;
const MAX_TARGET_PENDING_INSPECTIONS = 5;
const FRONTEND_STALE_FAILSAFE_MS = 5 * 60 * 1000;

const nativeResolutionByJob = new Map();

function isNativeResolutionInProgress(jobId) {
    return nativeResolutionByJob.get(jobId)?.inProgress === true;
}

function getNativeResolutionPromise(jobId) {
    return nativeResolutionByJob.get(jobId)?.promise || null;
}

function clearNativeResolution(jobId) {
    nativeResolutionByJob.delete(jobId);
}

async function runJob(job, environment) {
    acquireWakeLock();
    job.jobController ??= new AbortController();
    job.transportFailureCount = 0;
    appendJobLog(job, {
        source: 'backend',
        event: 'run_loop_started',
        summary: 'Backend retry loop started.',
    });

    try {
        await awaitNativeOutcome(job);
        if (job.state && job.state !== 'running') {
            return;
        }
        if (job.cancelRequested) {
            finalizeCancelled(job);
            return;
        }

        while (!job.cancelRequested && job.acceptedCount < job.targetAcceptedCount && job.attemptCount < job.maxAttempts) {
            job.attemptCount += 1;
            const attemptRecord = {
                attemptNumber: job.attemptCount,
                startedAt: new Date().toISOString(),
                phase: 'requesting_generation',
            };
            touchJob(job, {
                phase: 'requesting_generation',
                structuredError: null,
            });

            let responsePayload = null;
            try {
                appendJobLog(job, {
                    source: 'backend',
                    event: 'attempt_started',
                    summary: `Started retry attempt ${job.attemptCount}/${job.maxAttempts}.`,
                    detail: {
                        attemptNumber: job.attemptCount,
                        phase: 'requesting_generation',
                    },
                });
                responsePayload = await replayCapturedRequest(job, environment);
                job.transportFailureCount = 0;
            } catch (error) {
                const structuredError = toStructuredError(error, 'handoff_request_failed', 'Retry Mobile could not complete a retry attempt.');
                if (structuredError.code === 'cancelled' || job.cancelRequested || job.jobController?.signal?.aborted) {
                    finalizeCancelled(job);
                    return;
                }

                if (structuredError.code === 'attempt_timeout') {
                    job.lastError = structuredError.message;
                    job.structuredError = null;
                    job.lastValidation = null;
                    job.transportFailureCount += 1;
                    appendAttemptLog(job, {
                        ...attemptRecord,
                        finishedAt: new Date().toISOString(),
                        outcome: 'timed_out',
                        reason: structuredError.code,
                        message: structuredError.message,
                        phase: 'attempt_timed_out',
                    });
                    touchJob(job, {
                        phase: 'attempt_timed_out',
                    });
                    appendJobLog(job, {
                        source: 'backend',
                        event: 'attempt_timed_out',
                        summary: structuredError.message,
                        detail: {
                            attemptNumber: job.attemptCount,
                        },
                    });
                    await waitBeforeNextAttempt(job, 'transport');
                    continue;
                }

                if (structuredError.code === 'attempt_upstream_retryable') {
                    job.lastError = structuredError.message;
                    job.structuredError = null;
                    job.lastValidation = null;
                    job.transportFailureCount += 1;
                    appendAttemptLog(job, {
                        ...attemptRecord,
                        finishedAt: new Date().toISOString(),
                        outcome: 'retryable_request_failure',
                        reason: structuredError.code,
                        message: structuredError.message,
                        phase: 'attempt_request_retryable',
                    });
                    touchJob(job, {
                        phase: 'attempt_request_retryable',
                    });
                    appendJobLog(job, {
                        source: 'backend',
                        event: 'attempt_request_retryable',
                        summary: structuredError.message,
                        detail: {
                            attemptNumber: job.attemptCount,
                            code: structuredError.code,
                        },
                    });
                    await waitBeforeNextAttempt(job, 'transport');
                    continue;
                }

                appendAttemptLog(job, {
                    ...attemptRecord,
                    finishedAt: new Date().toISOString(),
                    outcome: 'failed',
                    reason: structuredError.code,
                    message: structuredError.message,
                    phase: 'request_failed',
                });
                appendJobLog(job, {
                    source: 'backend',
                    event: 'attempt_request_failed',
                    summary: structuredError.message,
                    detail: {
                        attemptNumber: job.attemptCount,
                        code: structuredError.code,
                    },
                });
                throw error;
            }

            if (job.cancelRequested) {
                break;
            }

            const text = extractResponseText(responsePayload);
            const validation = await validateAcceptedText(text, job.runConfig, {
                countTokens: (value) => countTextTokensWithSt(value, {
                    tokenizerDescriptor: job.tokenizerDescriptor,
                    requestModel: job.capturedRequest?.model,
                }),
            });

            if (!validation.accepted) {
                job.lastError = `Rejected response: ${formatValidationRejection(validation)}`;
                job.structuredError = null;
                job.lastValidation = validation;
                appendAttemptLog(job, {
                    ...attemptRecord,
                    finishedAt: new Date().toISOString(),
                    outcome: 'rejected',
                    reason: validation.reason,
                    message: formatValidationRejection(validation),
                    phase: 'validation_rejected',
                    characterCount: validation.metrics.characterCount,
                    tokenCount: validation.metrics.tokenCount,
                    tokenCountSource: validation.metrics.tokenCountSource,
                    tokenCountModel: validation.metrics.tokenizerModel,
                    tokenCountDetail: validation.metrics.tokenCountDetail,
                });
                touchJob(job, {
                    phase: 'validation_rejected',
                });
                appendJobLog(job, {
                    source: 'backend',
                    event: 'attempt_rejected',
                    summary: formatValidationRejection(validation),
                    detail: {
                        attemptNumber: job.attemptCount,
                        reason: validation.reason,
                        characterCount: validation.metrics.characterCount,
                        tokenCount: validation.metrics.tokenCount,
                        tokenCountSource: validation.metrics.tokenCountSource,
                        tokenCountModel: validation.metrics.tokenizerModel,
                        tokenCountDetail: validation.metrics.tokenCountDetail,
                    },
                });
                await waitBeforeNextAttempt(job, 'validation');
                continue;
            }

            if (job.cancelRequested) {
                break;
            }

            await ensureNativeWriteReady(job, attemptRecord);
            if (job.cancelRequested) {
                break;
            }

            touchJob(job, {
                phase: 'writing_chat',
            });

            let writeResult = null;
            try {
                writeResult = await writeAcceptedResult(job, validation.metrics);
            } catch (error) {
                const structuredError = toStructuredError(error, 'backend_write_failed', 'Retry Mobile could not write an accepted result back to chat.');
                if (structuredError.code === 'native_write_not_ready') {
                    appendAttemptLog(job, {
                        ...attemptRecord,
                        finishedAt: new Date().toISOString(),
                        outcome: 'state_wait',
                        reason: structuredError.code,
                        message: structuredError.message,
                        phase: 'awaiting_native_confirmation',
                        characterCount: validation.metrics.characterCount,
                        tokenCount: validation.metrics.tokenCount,
                    });
                    await awaitNativeOutcome(job);
                    if (job.state && job.state !== 'running') {
                        return;
                    }
                    writeResult = await writeAcceptedResult(job, validation.metrics);
                } else if (structuredError.code === 'native_persist_unresolved') {
                    appendAttemptLog(job, {
                        ...attemptRecord,
                        finishedAt: new Date().toISOString(),
                        outcome: 'state_wait',
                        reason: structuredError.code,
                        message: structuredError.message,
                        phase: 'native_confirming_persisted',
                        characterCount: validation.metrics.characterCount,
                        tokenCount: validation.metrics.tokenCount,
                    });
                    await recoverConfirmedAssistantGap(job);
                    if (job.state && job.state !== 'running') {
                        return;
                    }
                    writeResult = await writeAcceptedResult(job, validation.metrics);
                }

                if (writeResult) {
                    // The accepted response survived a state wait and was written successfully.
                } else if (structuredError.code === 'write_conflict') {
                    job.orphanedAcceptedResults.push({
                        text: validation.metrics.text,
                        characterCount: validation.metrics.characterCount,
                        tokenCount: validation.metrics.tokenCount,
                        tokenCountSource: validation.metrics.tokenCountSource,
                        tokenizerModel: validation.metrics.tokenizerModel,
                    });
                }

                if (!writeResult) {
                    appendAttemptLog(job, {
                        ...attemptRecord,
                        finishedAt: new Date().toISOString(),
                        outcome: 'write_failed',
                        reason: structuredError.code,
                        message: structuredError.message,
                        phase: 'writing_chat',
                        characterCount: validation.metrics.characterCount,
                        tokenCount: validation.metrics.tokenCount,
                        tokenCountSource: validation.metrics.tokenCountSource,
                        tokenCountModel: validation.metrics.tokenizerModel,
                        tokenCountDetail: validation.metrics.tokenCountDetail,
                    });
                    appendJobLog(job, {
                        source: 'backend',
                        event: 'attempt_write_failed',
                        summary: structuredError.message,
                        detail: {
                            attemptNumber: job.attemptCount,
                            code: structuredError.code,
                            characterCount: validation.metrics.characterCount,
                            tokenCount: validation.metrics.tokenCount,
                            tokenCountSource: validation.metrics.tokenCountSource,
                            tokenCountModel: validation.metrics.tokenizerModel,
                            tokenCountDetail: validation.metrics.tokenCountDetail,
                        },
                    });
                    throw error;
                }
            }

            job.acceptedResults.push({
                text: validation.metrics.text,
                characterCount: validation.metrics.characterCount,
                tokenCount: validation.metrics.tokenCount,
                tokenCountSource: validation.metrics.tokenCountSource,
                tokenizerModel: validation.metrics.tokenizerModel,
            });
            job.acceptedCount += 1;
            job.lastAcceptedMetrics = validation.metrics;
            job.lastValidation = validation;
            job.lastAcceptedAt = new Date().toISOString();
            job.lastError = '';
            job.structuredError = null;
            touchJob(job, {
                phase: 'awaiting_retry_results',
            });
            appendAttemptLog(job, {
                ...attemptRecord,
                finishedAt: new Date().toISOString(),
                outcome: 'accepted',
                reason: validation.reason,
                message: `Accepted and wrote swipe ${job.acceptedCount}/${job.targetAcceptedCount}.`,
                phase: 'awaiting_retry_results',
                characterCount: validation.metrics.characterCount,
                tokenCount: validation.metrics.tokenCount,
                tokenCountSource: validation.metrics.tokenCountSource,
                tokenCountModel: validation.metrics.tokenizerModel,
                tokenCountDetail: validation.metrics.tokenCountDetail,
                targetMessageVersion: writeResult?.targetMessageVersion,
                targetMessageIndex: writeResult?.targetMessageIndex,
            });
            appendJobLog(job, {
                source: 'backend',
                event: 'attempt_accepted',
                summary: `Accepted and wrote swipe ${job.acceptedCount}/${job.targetAcceptedCount}.`,
                detail: {
                    attemptNumber: job.attemptCount,
                    characterCount: validation.metrics.characterCount,
                    tokenCount: validation.metrics.tokenCount,
                    tokenCountSource: validation.metrics.tokenCountSource,
                    tokenCountModel: validation.metrics.tokenizerModel,
                    tokenCountDetail: validation.metrics.tokenCountDetail,
                    targetMessageVersion: writeResult?.targetMessageVersion ?? null,
                    targetMessageIndex: writeResult?.targetMessageIndex ?? null,
                },
            });

            notify(job.runConfig, 'success', {
                acceptedCount: job.acceptedCount,
                targetAcceptedCount: job.targetAcceptedCount,
                attemptCount: job.attemptCount,
                characterCount: validation.metrics.characterCount,
                tokenCount: validation.metrics.tokenCount,
            });
        }

        if (job.cancelRequested) {
            finalizeCancelled(job);
            return;
        }

        if (job.acceptedCount >= job.targetAcceptedCount) {
            touchJob(job, {
                state: 'completed',
                phase: 'completed',
            });
            appendJobLog(job, {
                source: 'backend',
                event: 'job_completed',
                summary: `Retry Mobile completed with ${job.acceptedCount}/${job.targetAcceptedCount} accepted outputs.`,
            });
            pruneTerminalJobUnits(job.userContext.handle, job.userContext.directories);
            notify(job.runConfig, 'completed', {
                attemptCount: job.attemptCount,
                acceptedCount: job.acceptedCount,
                targetAcceptedCount: job.targetAcceptedCount,
            });
            return;
        }

        const structuredError = toStructuredError(buildMaxAttemptsStructuredError(job), 
            'backend_write_failed',
            'Maximum attempts reached before the accepted target was met.',
        );
        touchJob(job, {
            state: 'failed',
            phase: 'failed',
            lastError: structuredError.message,
            structuredError,
        });
        appendJobLog(job, {
            source: 'backend',
            event: 'job_failed',
            summary: structuredError.message,
            detail: structuredError.detail || buildAttemptSummary(job),
        });
        pruneTerminalJobUnits(job.userContext.handle, job.userContext.directories);
    } catch (error) {
        const structuredError = toStructuredError(error, 'backend_write_failed', 'Retry Mobile backend job failed.');
        touchJob(job, {
            state: 'failed',
            phase: 'failed',
            lastError: structuredError.message,
            structuredError: {
                ...structuredError,
                detail: structuredError.detail || buildAttemptSummary(job),
            },
        });
        appendJobLog(job, {
            source: 'backend',
            event: 'job_failed',
            summary: structuredError.message,
            detail: structuredError.detail || buildAttemptSummary(job),
        });
        pruneTerminalJobUnits(job.userContext.handle, job.userContext.directories);
        console.error('[retry-mobile:backend] Job failed:', job.jobId, error);
    } finally {
        releaseWakeLock();
    }
}

async function awaitNativeOutcome(job) {
    if (job.nativeState === 'confirmed') {
        touchJob(job, {
            phase: 'native_confirmed',
            recoveryMode: job.recoveryMode || 'top_up_existing',
        });
        return;
    }

    if (job.nativeState === 'abandoned') {
        touchJob(job, {
            phase: 'native_abandoned',
        });
        return;
    }

    touchJob(job, {
        nativeState: 'pending',
        phase: 'pending_native',
        structuredError: null,
        nativeGraceDeadline: '',
    });

    while (!job.cancelRequested) {
        if (job.nativeState === 'confirmed' || job.nativeState === 'abandoned') {
            return;
        }

        if (isNativeResolutionInProgress(job.jobId)) {
            await observeNativeResolution(job);
            continue;
        }

        if (job.phase === 'native_confirming_persisted') {
            await resolvePendingNativeState(job, job.nativeResolutionCause || 'frontend_confirmed');
            continue;
        }

        const inspection = inspectNativeAssistantState(job);
        if (inspection.kind === 'filled') {
            if (job.state !== 'running' || job.cancelRequested) {
                return;
            }
            applyInspectionResolution(job, inspection, '');
            return;
        }

        if (shouldTriggerHiddenTakeover(job)) {
            await resolvePendingNativeState(job, job.nativeResolutionCause || 'hidden_timeout');
            continue;
        }

        if (shouldTriggerFrontendStaleTakeover(job)) {
            await resolvePendingNativeState(job, job.nativeResolutionCause || 'frontend_stale');
            continue;
        }

        await sleep(NATIVE_PENDING_POLL_MS);
    }
}

async function resolvePendingNativeState(job, cause) {
    nativeResolutionByJob.set(job.jobId, { inProgress: true, promise: null });
    job.nativeResolutionInProgress = true;
    const resolutionPromise = (async () => {
        try {
            if (job.state !== 'running' || job.cancelRequested) {
                return { outcome: 'cancelled' };
            }

            if (job.nativeState === 'confirmed' || job.nativeState === 'abandoned') {
                return { outcome: job.nativeState };
            }

            const inspection = await inspectPendingNativeState(job, cause);
            if (!inspection || job.state !== 'running' || job.cancelRequested) {
                return { outcome: 'cancelled' };
            }

            if (inspection.kind === 'target_pending') {
                const nextAttempts = Number(job.inspectionAttempts || 0) + 1;
                if (nextAttempts >= MAX_TARGET_PENDING_INSPECTIONS) {
                    const forcedInspection = {
                        kind: 'missing_assistant',
                        persistedAssistantIndex: null,
                        assistantMessageIndex: null,
                        assistantMessage: null,
                    };
                    touchJob(job, {
                        inspectionAttempts: nextAttempts,
                    });
                    applyInspectionResolution(job, forcedInspection, cause || 'forced_recovery');
                    return {
                        outcome: job.nativeState,
                        inspection: forcedInspection,
                    };
                }

                touchJob(job, {
                    inspectionAttempts: nextAttempts,
                    phase: job.phase === 'native_confirming_persisted'
                        ? 'native_confirming_persisted'
                        : 'pending_native',
                    nativeGraceDeadline: '',
                });
                return {
                    outcome: 'pending',
                    inspection,
                };
            }

            touchJob(job, {
                inspectionAttempts: 0,
            });
            applyInspectionResolution(job, inspection, cause);
            return {
                outcome: job.nativeState,
                inspection,
            };
        } finally {
            clearNativeResolution(job.jobId);
            job.nativeResolutionInProgress = false;
        }
    })();

    if (nativeResolutionByJob.has(job.jobId)) {
        nativeResolutionByJob.set(job.jobId, { inProgress: true, promise: resolutionPromise });
    }
    return await resolutionPromise;
}

async function waitForNativeResolutionIdle(job, timeoutMs) {
    const promise = getNativeResolutionPromise(job?.jobId);
    if (!promise) {
        return true;
    }

    const result = await Promise.race([
        promise.then(() => 'resolved'),
        sleep(timeoutMs).then(() => 'timed_out'),
    ]);

    return result === 'resolved';
}

async function confirmNativeAssistant(job, assistantMessageIndex) {
    const liveAssistantIndex = Number(assistantMessageIndex);
    if (!Number.isFinite(liveAssistantIndex) || liveAssistantIndex < 0) {
        throw createStructuredError(
            'handoff_request_failed',
            'Retry Mobile did not receive a valid native assistant turn to confirm.',
        );
    }

    touchJob(job, {
        nativeState: 'pending',
        phase: 'native_confirming_persisted',
        recoveryMode: '',
        nativeResolutionCause: 'frontend_confirmed',
        assistantMessageIndex: liveAssistantIndex,
        targetMessageIndex: liveAssistantIndex,
        targetMessage: null,
        lastError: '',
        structuredError: null,
        inspectionAttempts: 0,
        nativeGraceDeadline: '',
    });
    appendLifecycleLog(job, 'native_confirming_persisted', `Frontend confirmed native assistant turn ${liveAssistantIndex}; backend is waiting for the saved chat to expose it.`);
    if (!isNativeResolutionInProgress(job.jobId)) {
        void resolvePendingNativeState(job, 'frontend_confirmed');
    }
    return {
        assistantMessageIndex: liveAssistantIndex,
        targetMessageIndex: liveAssistantIndex,
        targetMessage: null,
    };
}

function applyInspectionResolution(job, inspection, cause) {
    const resolutionCause = cause || job.nativeResolutionCause || '';
    if (inspection.kind === 'filled') {
        touchJob(job, {
            nativeState: 'confirmed',
            phase: 'native_confirmed',
            recoveryMode: 'top_up_existing',
            nativeResolutionCause: resolutionCause,
            nativeGraceDeadline: '',
            assistantMessageIndex: inspection.assistantMessageIndex,
            targetMessageIndex: inspection.assistantMessageIndex,
            targetMessage: clone(inspection.assistantMessage),
            lastError: '',
            structuredError: null,
        });
        appendLifecycleLog(job, 'native_confirmed', `Native first reply was confirmed at assistant message ${inspection.assistantMessageIndex}.`);
        return;
    }

    if (inspection.kind === 'empty_placeholder') {
        touchJob(job, {
            nativeState: 'abandoned',
            phase: 'native_abandoned',
            recoveryMode: 'reuse_empty_placeholder',
            nativeResolutionCause: resolutionCause,
            nativeGraceDeadline: '',
            assistantMessageIndex: inspection.assistantMessageIndex,
            targetMessageIndex: inspection.assistantMessageIndex,
            targetMessage: clone(inspection.assistantMessage),
            lastError: '',
            structuredError: null,
        });
        appendLifecycleLog(job, 'native_abandoned', `Native first reply was abandoned. Backend will reuse empty assistant slot ${inspection.assistantMessageIndex}.`);
        return;
    }

    if (inspection.kind === 'missing_assistant' || inspection.kind === 'missing_user_anchor') {
        if (resolutionCause === 'frontend_confirmed' || job.phase === 'native_confirming_persisted') {
            const structuredError = inspection.kind === 'missing_user_anchor'
                ? createStructuredError(
                    'capture_chat_changed',
                    'Retry Mobile stopped because the captured user turn disappeared before the confirmed native handoff could be persisted.',
                    `nativeResolutionCause=${resolutionCause || 'unknown'}`,
                )
                : createStructuredError(
                    'native_turn_missing',
                    'Retry Mobile stopped because the confirmed native assistant turn disappeared before Retry Mobile could continue safely.',
                    `nativeResolutionCause=${resolutionCause || 'unknown'}`,
                );
            finalizeFailed(job, structuredError);
            appendLifecycleLog(job, 'native_confirmation_failed', structuredError.message);
            return;
        }

        touchJob(job, {
            nativeState: 'abandoned',
            phase: 'native_abandoned',
            recoveryMode: 'create_missing_turn',
            nativeResolutionCause: resolutionCause,
            nativeGraceDeadline: '',
            assistantMessageIndex: null,
            targetMessageIndex: null,
            targetMessage: null,
            lastError: '',
            structuredError: null,
        });
        appendLifecycleLog(job, 'native_abandoned', inspection.kind === 'missing_user_anchor'
            ? 'Native first reply was abandoned before SillyTavern saved the captured user turn. Backend will recreate the user and assistant anchor.'
            : 'Native first reply was abandoned. Backend will create the missing assistant turn.');
        return;
    }

    throw createStructuredError(
        'backend_turn_missing',
        'Retry Mobile could not resolve the captured user turn on disk before native recovery.',
    );
}

async function inspectPendingNativeState(job, cause) {
    let latestInspection = null;
    const resolutionCause = cause || job?.nativeResolutionCause || '';
    const delays = resolutionCause === 'frontend_confirmed'
        ? FRONTEND_CONFIRMED_PERSIST_DELAYS_MS
        : FORCED_NATIVE_INSPECTION_DELAYS_MS;
    for (const delayMs of delays) {
        if (delayMs > 0) {
            await sleep(delayMs);
        }

        if (job.state !== 'running' || job.cancelRequested) {
            return null;
        }

        latestInspection = inspectNativeAssistantState(job);
        if (latestInspection.kind === 'target_pending') {
            continue;
        }

        if (
            resolutionCause === 'frontend_confirmed'
            && (latestInspection.kind === 'missing_assistant' || latestInspection.kind === 'missing_user_anchor')
        ) {
            continue;
        }

        return latestInspection;
    }

    return latestInspection;
}

async function observeNativeResolution(job) {
    const promise = getNativeResolutionPromise(job?.jobId);
    if (!promise) {
        return;
    }

    await promise;
}

function shouldTriggerHiddenTakeover(job) {
    if (String(job?.frontendVisibilityState || '') !== 'hidden') {
        return false;
    }

    const hiddenSinceMs = Date.parse(String(job?.frontendHiddenSince || ''));
    if (!Number.isFinite(hiddenSinceMs) || hiddenSinceMs <= 0) {
        return false;
    }

    return (Date.now() - hiddenSinceMs) >= (Math.max(10, Number(job?.nativeGraceSeconds) || 30) * 1000);
}

function shouldTriggerFrontendStaleTakeover(job) {
    const lastSeenMs = Date.parse(String(job?.lastFrontendSeenAt || ''));
    if (!Number.isFinite(lastSeenMs) || lastSeenMs <= 0) {
        return false;
    }

    return (Date.now() - lastSeenMs) >= FRONTEND_STALE_FAILSAFE_MS;
}

async function ensureNativeWriteReady(job, attemptRecord) {
    try {
        assertWritePathReady(job);
    } catch (error) {
        const structuredError = toStructuredError(error, 'native_write_not_ready', 'Retry Mobile delayed the write because native confirmation was still resolving.');
        appendAttemptLog(job, {
            ...attemptRecord,
            finishedAt: new Date().toISOString(),
            outcome: 'state_wait',
            reason: structuredError.code,
            message: structuredError.message,
            phase: job.phase,
        });
        await awaitNativeOutcome(job);
    }
}

async function recoverConfirmedAssistantGap(job) {
    if (job.nativeResolutionInProgress || job.phase === 'native_confirming_persisted') {
        await awaitNativeOutcome(job);
        return;
    }

    const inspection = inspectNativeAssistantState(job);
    if (inspection.kind === 'filled' || inspection.kind === 'empty_placeholder' || inspection.kind === 'missing_assistant' || inspection.kind === 'missing_user_anchor') {
        applyInspectionResolution(job, inspection, 'confirmed_write_recheck');
        return;
    }

    applyInspectionResolution(job, {
        kind: 'missing_assistant',
        persistedAssistantIndex: null,
        assistantMessageIndex: null,
        assistantMessage: null,
    }, 'confirmed_write_recheck');
}

function appendLifecycleLog(job, reason, message) {
    const alreadyLogged = Array.isArray(job.attemptLog)
        && job.attemptLog.some((entry) => entry?.attemptNumber === 0 && entry?.reason === reason);
    if (alreadyLogged) {
        return;
    }

    appendAttemptLog(job, {
        attemptNumber: 0,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        outcome: 'native',
        reason,
        message,
        phase: job.phase,
        targetMessageIndex: job.targetMessageIndex,
    });
    appendJobLog(job, {
        source: 'backend',
        event: reason,
        summary: message,
        detail: {
            reason,
            phase: job.phase,
        },
    });
}

async function replayCapturedRequest(job, environment) {
    const body = clone(job.capturedRequest);
    body.stream = false;

    const endpoint = resolveGenerationEndpoint(body);
    const timeoutSeconds = Math.max(1, Number(job.runConfig?.attemptTimeoutSeconds) || 0);
    const timeoutController = new AbortController();
    const timeoutHandle = setTimeout(() => {
        timeoutController.abort();
    }, timeoutSeconds * 1000);

    const onJobAbort = () => timeoutController.abort();
    job.jobController?.signal?.addEventListener?.('abort', onJobAbort, { once: true });

    try {
        let response = null;
        const replayHeaders = buildReplayRequestHeaders(environment?.requestAuth);
        try {
            response = await fetch(`${environment.baseUrl}${endpoint}`, {
                method: 'POST',
                headers: replayHeaders,
                body: JSON.stringify(body),
                signal: timeoutController.signal,
            });
        } catch (error) {
            if (error?.name === 'AbortError') {
                if (job.cancelRequested || job.jobController?.signal?.aborted) {
                    throw createStructuredError('cancelled', 'Retry Mobile cancelled the active retry attempt.');
                }

                throw createStructuredError(
                    'attempt_timeout',
                    `Attempt timed out after ${timeoutSeconds} seconds with no response.`,
                );
            }

            throw error;
        }

        let text = '';
        try {
            text = await response.text();
        } catch (error) {
            if (error?.name === 'AbortError') {
                if (job.cancelRequested || job.jobController?.signal?.aborted) {
                    throw createStructuredError('cancelled', 'Retry Mobile cancelled the active retry attempt.');
                }

                throw createStructuredError(
                    'attempt_timeout',
                    `Attempt timed out after ${timeoutSeconds} seconds with no response.`,
                );
            }

            throw error;
        }

        const payload = tryParseJson(text);
        const replayFailureContext = {
            endpoint,
            status: response.status,
            responseText: text,
            requestAuth: environment?.requestAuth,
        };

        if (!response.ok) {
            const payloadError = buildReplayPayloadStructuredError(payload, replayFailureContext);
            if (payloadError) {
                throw payloadError;
            }

            throw createStructuredError(
                'handoff_request_failed',
                `Generation request failed with status ${response.status}`,
                buildReplayFailureDetail(replayFailureContext),
            );
        }

        const payloadError = buildReplayPayloadStructuredError(payload, replayFailureContext);
        if (payloadError) {
            throw payloadError;
        }

        return payload;
    } finally {
        clearTimeout(timeoutHandle);
        job.jobController?.signal?.removeEventListener?.('abort', onJobAbort);
    }
}

function resolveGenerationEndpoint(body) {
    if (body && typeof body === 'object' && ('chat_completion_source' in body || Array.isArray(body.messages))) {
        return '/api/backends/chat-completions/generate';
    }

    return '/api/backends/text-completions/generate';
}

function buildReplayRequestHeaders(requestAuth) {
    const headers = {
        'Content-Type': 'application/json',
        Accept: 'application/json',
    };

    const cookieHeader = typeof requestAuth?.cookieHeader === 'string' && requestAuth.cookieHeader.trim()
        ? requestAuth.cookieHeader.trim()
        : '';
    const csrfToken = typeof requestAuth?.csrfToken === 'string' && requestAuth.csrfToken.trim()
        ? requestAuth.csrfToken.trim()
        : '';

    if (cookieHeader) {
        headers.Cookie = cookieHeader;
    }

    if (csrfToken) {
        headers['X-CSRF-Token'] = csrfToken;
    }

    return headers;
}

function buildReplayFailureDetail({ endpoint, status, responseText, requestAuth }) {
    const responsePreview = typeof responseText === 'string' && responseText.trim()
        ? responseText.trim().slice(0, 240)
        : '';
    const parts = [
        `cookie=${requestAuth?.cookieHeader ? 'present' : 'missing'}`,
        `csrf=${requestAuth?.csrfToken ? 'present' : 'missing'}`,
    ];

    if (typeof endpoint === 'string' && endpoint.trim()) {
        parts.unshift(`request=POST ${endpoint.trim()}`);
    }

    if (Number.isFinite(Number(status))) {
        parts.push(`status=${Number(status)}`);
    }

    if (responsePreview) {
        parts.push(`response=${responsePreview}`);
    }

    return parts.join('; ');
}

function extractResponseText(payload) {
    const extracted = tryExtractResponseText(payload);
    if (extracted !== null) {
        return extracted;
    }

    const payloadError = buildReplayPayloadStructuredError(payload);
    if (payloadError) {
        throw payloadError;
    }

    throw createStructuredError(
        'handoff_request_failed',
        'Retry Mobile could not extract text from the generation response.',
    );
}

function tryExtractResponseText(payload) {
    if (typeof payload === 'string') {
        return payload;
    }

    const choice = Array.isArray(payload?.choices) ? payload.choices[0] : null;
    const messageContent = extractTextContent(choice?.message?.content);
    if (messageContent !== null) {
        return messageContent;
    }

    if (typeof choice?.text === 'string') {
        return choice.text;
    }

    const topLevelMessageContent = extractTextContent(payload?.message?.content);
    if (topLevelMessageContent !== null) {
        return topLevelMessageContent;
    }

    const topLevelContent = extractTextContent(payload?.content);
    if (topLevelContent !== null) {
        return topLevelContent;
    }

    const responseContent = extractTextContent(payload?.responseContent);
    if (responseContent !== null) {
        return responseContent;
    }

    return null;
}

function flattenMessagePart(part) {
    if (typeof part === 'string') {
        return part;
    }

    if (part && typeof part === 'object' && typeof part.text === 'string') {
        return part.text;
    }

    return '';
}

function extractTextContent(value) {
    if (typeof value === 'string') {
        return value;
    }

    if (Array.isArray(value)) {
        return value.map(flattenMessagePart).join('').trim();
    }

    if (value && typeof value === 'object' && Array.isArray(value.parts)) {
        return value.parts.map(flattenMessagePart).join('').trim();
    }

    return null;
}

function buildReplayPayloadStructuredError(payload, context = {}) {
    const descriptor = readReplayPayloadErrorDescriptor(payload);
    if (!descriptor) {
        return null;
    }

    const code = isRetryableReplayPayloadError(descriptor, context)
        ? 'attempt_upstream_retryable'
        : 'handoff_request_failed';
    const detail = buildReplayPayloadErrorDetail(descriptor, context);
    return createStructuredError(code, descriptor.message, detail);
}

function readReplayPayloadErrorDescriptor(payload) {
    const errorBlock = payload?.error;
    if (typeof errorBlock === 'string' && errorBlock.trim()) {
        return {
            message: errorBlock.trim(),
            code: firstNonEmptyString(payload?.code),
            type: firstNonEmptyString(payload?.type),
            detail: firstNonEmptyString(payload?.detail),
        };
    }

    if (errorBlock && typeof errorBlock === 'object') {
        const message = firstNonEmptyString(
            errorBlock.message,
            errorBlock.detail,
            errorBlock.error,
            payload?.message,
            payload?.detail,
        );
        if (message) {
            return {
                message,
                code: firstNonEmptyString(errorBlock.code, payload?.code),
                type: firstNonEmptyString(errorBlock.type, payload?.type),
                detail: firstNonEmptyString(payload?.detail, errorBlock.detail),
            };
        }
    }

    const hasRecognizedResponse = tryExtractResponseText(payload) !== null;
    const topLevelMessage = firstNonEmptyString(payload?.message);
    const topLevelDetail = firstNonEmptyString(payload?.detail);
    const topLevelCode = firstNonEmptyString(payload?.code);
    const topLevelType = firstNonEmptyString(payload?.type);
    const topLevelStatus = Number.isFinite(Number(payload?.status)) ? Number(payload.status) : null;

    if (!hasRecognizedResponse && topLevelMessage && (topLevelDetail || topLevelCode || topLevelType || (topLevelStatus && topLevelStatus >= 400))) {
        return {
            message: topLevelMessage,
            code: topLevelCode,
            type: topLevelType,
            detail: topLevelDetail,
            status: topLevelStatus,
        };
    }

    return null;
}

function isRetryableReplayPayloadError(descriptor, context = {}) {
    const status = Number.isFinite(Number(context?.status)) ? Number(context.status) : descriptor?.status;
    if (status === 429 || (status >= 500 && status < 600)) {
        return true;
    }

    const haystack = [
        descriptor?.message,
        descriptor?.detail,
        descriptor?.code,
        descriptor?.type,
    ].filter(Boolean).join(' ').toLowerCase();

    return /too many requests|rate limit|rate-limit|try again later|temporarily unavailable|server busy|overloaded|timeout|timed out|请求数限制|频率限制|稍后再试/u.test(haystack);
}

function buildReplayPayloadErrorDetail(descriptor, context = {}) {
    const parts = [];
    const baseDetail = buildReplayFailureDetail(context);
    if (baseDetail) {
        parts.push(baseDetail);
    }

    if (descriptor?.code) {
        parts.push(`providerCode=${descriptor.code}`);
    }

    if (descriptor?.type) {
        parts.push(`providerType=${descriptor.type}`);
    }

    const providerDetail = typeof descriptor?.detail === 'string' ? descriptor.detail.trim() : '';
    if (providerDetail && providerDetail !== descriptor?.message) {
        parts.push(`providerDetail=${providerDetail.slice(0, 240)}`);
    }

    return parts.join('; ');
}

function firstNonEmptyString(...values) {
    for (const value of values) {
        if (typeof value === 'string' && value.trim()) {
            return value.trim();
        }
    }

    return '';
}

function tryParseJson(text) {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

function buildAttemptSummary(job) {
    return `Attempts: ${job.attemptCount}/${job.maxAttempts}; accepted: ${job.acceptedCount}/${job.targetAcceptedCount}.`;
}

function buildMaxAttemptsStructuredError(job) {
    const detailParts = [buildAttemptSummary(job)];
    if (job?.lastValidation) {
        detailParts.push(`lastValidation=${formatValidationRejection(job.lastValidation)}`);
    } else if (typeof job?.lastError === 'string' && job.lastError.trim()) {
        detailParts.push(`lastFailure=${job.lastError.trim()}`);
    }

    return createStructuredError(
        'max_attempts_reached',
        'Maximum attempts reached before the accepted target was met.',
        detailParts.join('; '),
    );
}

function formatValidationRejection(validation) {
    if (!validation) {
        return 'Validation rejected the response.';
    }

    if (validation.reason === 'empty') {
        return 'The provider returned an empty response.';
    }

    if (validation.reason === 'below_min_characters') {
        return `The response only had ${validation.metrics.characterCount} characters, below the required ${validation.threshold}.`;
    }

    if (validation.reason === 'below_min_tokens') {
        return `The response only had ${validation.metrics.tokenCount} tokens, below the required ${validation.threshold}.`;
    }

    if (validation.reason === 'tokenizer_unavailable') {
        const detail = validation.metrics?.tokenCountDetail
            ? ` ${validation.metrics.tokenCountDetail}`
            : '';
        return `Retry Mobile could not verify token length with a real tokenizer and heuristic fallback is disabled.${detail}`;
    }

    return 'Validation rejected the response.';
}

async function waitBeforeNextAttempt(job, failureKind) {
    if (job.cancelRequested) {
        return;
    }

    const jitterMultiplier = 0.8 + (Math.random() * 0.4);
    const consecutiveTransportFailures = Number(job.transportFailureCount || 0);
    let baseDelay = BASE_RETRY_DELAY_MS;
    if (failureKind === 'transport') {
        baseDelay = Math.min(MAX_RETRY_DELAY_MS, BASE_RETRY_DELAY_MS * (2 ** Math.max(0, consecutiveTransportFailures - 1)));
    }

    await sleep(Math.round(baseDelay * jitterMultiplier));
}

function finalizeCancelled(job) {
    touchJob(job, {
        state: 'cancelled',
        phase: 'cancelled',
    });
    appendJobLog(job, {
        source: 'backend',
        event: 'job_cancelled',
        summary: 'Retry Mobile cancelled this backend job.',
    });
    pruneTerminalJobUnits(job.userContext.handle, job.userContext.directories);
}

function finalizeFailed(job, structuredError) {
    const normalized = toStructuredError(structuredError, 'backend_write_failed', 'Retry Mobile backend job failed.');
    touchJob(job, {
        state: 'failed',
        phase: 'failed',
        nativeState: 'failed',
        recoveryMode: '',
        nativeGraceDeadline: '',
        lastError: normalized.message,
        structuredError: {
            ...normalized,
            detail: normalized.detail || buildAttemptSummary(job),
        },
    });
    appendJobLog(job, {
        source: 'backend',
        event: 'job_failed',
        summary: normalized.message,
        detail: normalized.detail || buildAttemptSummary(job),
    });
    pruneTerminalJobUnits(job.userContext.handle, job.userContext.directories);
}

function clone(value) {
    return JSON.parse(JSON.stringify(value ?? null));
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
    confirmNativeAssistant,
    extractResponseText,
    replayCapturedRequest,
    resolvePendingNativeState,
    runJob,
    waitForNativeResolutionIdle,
};
