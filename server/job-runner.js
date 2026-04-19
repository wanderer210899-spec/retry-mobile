const { acquireWakeLock, notify, releaseWakeLock } = require('./notifier');
const { appendJobLog } = require('./job-log-store');
const { pruneTerminalJobUnits } = require('./job-store');
const { createStructuredError, toStructuredError } = require('./retry-error');
const { validateAcceptedText } = require('./validation');
const { appendAttemptLog, touchJob } = require('./state');
const {
    assertWritePathReady,
    inspectNativeAssistantState,
    writeAcceptedResult,
} = require('./chat-writer');

const NATIVE_PENDING_POLL_MS = 1000;
const FORCED_NATIVE_INSPECTION_DELAYS_MS = [0, 1000, 2000, 4000, 8000];
const BASE_RETRY_DELAY_MS = 750;
const MAX_RETRY_DELAY_MS = 10000;
const MAX_TARGET_PENDING_INSPECTIONS = 5;

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
            const validation = validateAcceptedText(text, job.runConfig);

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
                    writeResult = await writeAcceptedResult(job, validation.metrics);
                }

                if (writeResult) {
                    // The accepted response survived a state wait and was written successfully.
                } else if (structuredError.code === 'write_conflict') {
                    job.orphanedAcceptedResults.push({
                        text: validation.metrics.text,
                        characterCount: validation.metrics.characterCount,
                        tokenCount: validation.metrics.tokenCount,
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
                        },
                    });
                    throw error;
                }
            }

            job.acceptedResults.push({
                text: validation.metrics.text,
                characterCount: validation.metrics.characterCount,
                tokenCount: validation.metrics.tokenCount,
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

        const structuredError = toStructuredError(createStructuredError(
            'backend_write_failed',
            'Maximum attempts reached before the accepted target was met.',
            buildAttemptSummary(job),
        ));
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
        nativeGraceDeadline: new Date(Date.now() + (Number(job.nativeGraceSeconds || 30) * 1000)).toISOString(),
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
            applyInspectionResolution(job, inspection, '');
            return;
        }

        const graceDeadlineMs = Number.isFinite(Date.parse(job.nativeGraceDeadline))
            ? Date.parse(job.nativeGraceDeadline)
            : 0;
        if (graceDeadlineMs > 0 && Date.now() >= graceDeadlineMs) {
            await resolvePendingNativeState(job, job.nativeResolutionCause || 'grace_expired');
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

            const inspection = await inspectPendingNativeState(job);
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
                    nativeGraceDeadline: new Date(Date.now() + (Number(job.nativeGraceSeconds || 30) * 1000)).toISOString(),
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
        nativeGraceDeadline: new Date(Date.now() + (Number(job.nativeGraceSeconds || 30) * 1000)).toISOString(),
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
    if (inspection.kind === 'filled') {
        touchJob(job, {
            nativeState: 'confirmed',
            phase: 'native_confirmed',
            recoveryMode: 'top_up_existing',
            nativeResolutionCause: cause || job.nativeResolutionCause || '',
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
            nativeResolutionCause: cause || job.nativeResolutionCause || '',
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
        touchJob(job, {
            nativeState: 'abandoned',
            phase: 'native_abandoned',
            recoveryMode: 'create_missing_turn',
            nativeResolutionCause: cause || job.nativeResolutionCause || '',
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

async function inspectPendingNativeState(job) {
    let latestInspection = null;
    for (const delayMs of FORCED_NATIVE_INSPECTION_DELAYS_MS) {
        if (delayMs > 0) {
            await sleep(delayMs);
        }

        if (job.state !== 'running' || job.cancelRequested) {
            return null;
        }

        latestInspection = inspectNativeAssistantState(job);
        if (latestInspection.kind !== 'target_pending') {
            return latestInspection;
        }
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
        try {
            response = await fetch(`${environment.baseUrl}${endpoint}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json',
                },
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
        if (!response.ok) {
            throw createStructuredError(
                'handoff_request_failed',
                payload?.error || `Generation request failed with status ${response.status}`,
            );
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

function extractResponseText(payload) {
    if (typeof payload === 'string') {
        return payload;
    }

    const choice = Array.isArray(payload?.choices) ? payload.choices[0] : null;
    const messageContent = choice?.message?.content;
    if (typeof messageContent === 'string') {
        return messageContent;
    }

    if (Array.isArray(messageContent)) {
        return messageContent.map(flattenMessagePart).join('').trim();
    }

    if (typeof choice?.text === 'string') {
        return choice.text;
    }

    if (typeof payload?.content === 'string') {
        return payload.content;
    }

    if (Array.isArray(payload?.content)) {
        return payload.content.map(flattenMessagePart).join('').trim();
    }

    if (typeof payload?.responseContent === 'string') {
        return payload.responseContent;
    }

    throw createStructuredError(
        'handoff_request_failed',
        'Retry Mobile could not extract text from the generation response.',
    );
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

function clone(value) {
    return JSON.parse(JSON.stringify(value ?? null));
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
    confirmNativeAssistant,
    resolvePendingNativeState,
    runJob,
    waitForNativeResolutionIdle,
};
