const { acquireWakeLock, notify, releaseWakeLock } = require('./notifier');
const { createStructuredError, toStructuredError } = require('./retry-error');
const { validateAcceptedText } = require('./validation');
const { appendAttemptLog, touchJob } = require('./state');
const { confirmNativeAssistantTurn, inspectNativeAssistantState, writeAcceptedResult } = require('./chat-writer');

const NATIVE_PENDING_POLL_MS = 1000;

async function runJob(job, environment) {
    acquireWakeLock();
    try {
        await awaitNativeOutcome(job);
        if (job.cancelRequested) {
            touchJob(job, {
                state: 'cancelled',
                phase: 'cancelled',
            });
            releaseWakeLock();
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
                responsePayload = await replayCapturedRequest(job, environment);
            } catch (error) {
                const structuredError = toStructuredError(error, 'handoff_request_failed', 'Retry Mobile could not complete a retry attempt.');
                if (structuredError.code === 'attempt_timeout') {
                    job.lastError = structuredError.message;
                    job.structuredError = null;
                    job.lastValidation = null;
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
                throw error;
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
                continue;
            }

            touchJob(job, {
                phase: 'writing_chat',
            });
            let writeResult = null;
            try {
                writeResult = await writeAcceptedResult(job, validation.metrics);
            } catch (error) {
                const structuredError = toStructuredError(error, 'backend_write_failed', 'Retry Mobile could not write an accepted result back to chat.');
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
                throw error;
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

            notify(job.runConfig, 'success', {
                acceptedCount: job.acceptedCount,
                targetAcceptedCount: job.targetAcceptedCount,
                attemptCount: job.attemptCount,
                characterCount: validation.metrics.characterCount,
                tokenCount: validation.metrics.tokenCount,
            });
        }

        if (job.cancelRequested) {
            touchJob(job, {
                state: 'cancelled',
                phase: 'cancelled',
            });
            releaseWakeLock();
            return;
        }

        if (job.acceptedCount >= job.targetAcceptedCount) {
            touchJob(job, {
                state: 'completed',
                phase: 'completed',
            });
            notify(job.runConfig, 'completed', {
                attemptCount: job.attemptCount,
                acceptedCount: job.acceptedCount,
                targetAcceptedCount: job.targetAcceptedCount,
            });
            releaseWakeLock();
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
        releaseWakeLock();
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
        console.error('[retry-mobile:backend] Job failed:', job.jobId, error);
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
    });

    const graceDeadlineMs = Number.isFinite(Date.parse(job.nativeGraceDeadline))
        ? Date.parse(job.nativeGraceDeadline)
        : Date.now();

    while (!job.cancelRequested) {
        if (job.nativeState === 'confirmed' || job.nativeState === 'abandoned') {
            return;
        }

        const inspection = inspectNativeAssistantState(job);
        if (inspection.kind === 'filled') {
            touchJob(job, {
                nativeState: 'confirmed',
                phase: 'native_confirmed',
                recoveryMode: 'top_up_existing',
                assistantMessageIndex: inspection.assistantMessageIndex,
                targetMessageIndex: inspection.assistantMessageIndex,
                targetMessage: clone(inspection.assistantMessage),
                lastError: '',
                structuredError: null,
            });
            appendLifecycleLog(job, 'native_confirmed', `Native first reply was confirmed at assistant message ${inspection.assistantMessageIndex}.`);
            return;
        }

        if (Date.now() >= graceDeadlineMs) {
            if (inspection.kind === 'empty_placeholder') {
                touchJob(job, {
                    nativeState: 'abandoned',
                    phase: 'native_abandoned',
                    recoveryMode: 'reuse_empty_placeholder',
                    assistantMessageIndex: inspection.assistantMessageIndex,
                    targetMessageIndex: inspection.assistantMessageIndex,
                    targetMessage: clone(inspection.assistantMessage),
                    lastError: '',
                    structuredError: null,
                });
                appendLifecycleLog(job, 'native_abandoned', `Native first reply was abandoned. Backend will reuse empty assistant slot ${inspection.assistantMessageIndex}.`);
                return;
            }

            if (inspection.kind === 'missing_assistant') {
                touchJob(job, {
                    nativeState: 'abandoned',
                    phase: 'native_abandoned',
                    recoveryMode: 'create_missing_turn',
                    assistantMessageIndex: null,
                    targetMessageIndex: null,
                    targetMessage: null,
                    lastError: '',
                    structuredError: null,
                });
                appendLifecycleLog(job, 'native_abandoned', 'Native first reply was abandoned. Backend will create the missing assistant turn.');
                return;
            }

            if (inspection.kind === 'missing_user_anchor') {
                touchJob(job, {
                    nativeState: 'abandoned',
                    phase: 'native_abandoned',
                    recoveryMode: 'create_missing_turn',
                    assistantMessageIndex: null,
                    targetMessageIndex: null,
                    targetMessage: null,
                    lastError: '',
                    structuredError: null,
                });
                appendLifecycleLog(job, 'native_abandoned', 'Native first reply was abandoned before SillyTavern saved the captured user turn. Backend will recreate the user and assistant anchor.');
                return;
            }

            throw createStructuredError(
                'backend_turn_missing',
                'Retry Mobile could not resolve the captured user turn on disk before native recovery.',
            );
        }

        await sleep(NATIVE_PENDING_POLL_MS);
    }
}

async function confirmNativeAssistant(job, assistantMessageIndex) {
    const confirmation = await confirmNativeAssistantTurn(job, assistantMessageIndex);
    touchJob(job, {
        nativeState: 'confirmed',
        phase: 'native_confirmed',
        recoveryMode: 'top_up_existing',
        assistantMessageIndex: confirmation.assistantMessageIndex,
        targetMessageIndex: confirmation.targetMessageIndex,
        targetMessage: confirmation.targetMessage,
        lastError: '',
        structuredError: null,
    });
    appendLifecycleLog(job, 'native_confirmed', `Frontend confirmed native assistant turn ${confirmation.assistantMessageIndex}.`);
    return confirmation;
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
}

async function replayCapturedRequest(job, environment) {
    const body = clone(job.capturedRequest);
    body.stream = false;

    const endpoint = resolveGenerationEndpoint(body);
    const timeoutSeconds = Math.max(1, Number(job.runConfig?.attemptTimeoutSeconds) || 0);
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => {
        controller.abort();
    }, timeoutSeconds * 1000);

    let response = null;
    try {
        response = await fetch(`${environment.baseUrl}${endpoint}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
                ...(job.authHeaders || {}),
            },
            body: JSON.stringify(body),
            signal: controller.signal,
        });
    } catch (error) {
        if (error?.name === 'AbortError') {
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
            throw createStructuredError(
                'attempt_timeout',
                `Attempt timed out after ${timeoutSeconds} seconds with no response.`,
            );
        }

        throw error;
    } finally {
        clearTimeout(timeoutHandle);
    }

    const payload = tryParseJson(text);
    if (!response.ok) {
        throw createStructuredError(
            'handoff_request_failed',
            payload?.error || `Generation request failed with status ${response.status}`,
        );
    }

    return payload;
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

    return '';
}

function flattenMessagePart(part) {
    if (typeof part === 'string') {
        return part;
    }

    if (part?.type === 'text' && typeof part.text === 'string') {
        return part.text;
    }

    return '';
}

function tryParseJson(text) {
    try {
        return text ? JSON.parse(text) : {};
    } catch {
        return { raw: text };
    }
}

function clone(value) {
    return JSON.parse(JSON.stringify(value ?? null));
}

module.exports = {
    confirmNativeAssistant,
    runJob,
};

function formatValidationRejection(validation) {
    if (validation?.reason === 'below_min_characters') {
        return `below minimum character count (${validation.metrics?.characterCount || 0}/${validation.threshold || 0})`;
    }

    if (validation?.reason === 'below_min_tokens') {
        return `below minimum token count (${validation.metrics?.tokenCount || 0}/${validation.threshold || 0})`;
    }

    if (validation?.reason === 'empty') {
        return 'empty response';
    }

    return validation?.reason || 'validation failed';
}

function buildAttemptSummary(job) {
    const latest = Array.isArray(job?.attemptLog) && job.attemptLog.length > 0
        ? job.attemptLog[job.attemptLog.length - 1]
        : null;
    if (!latest) {
        return '';
    }

    const latestReason = latest.message || latest.reason || latest.outcome || 'unknown';
    return `Accepted ${job.acceptedCount || 0}/${job.targetAcceptedCount || 0} after ${job.attemptCount || 0} attempts. Last attempt: ${latestReason}`;
}
