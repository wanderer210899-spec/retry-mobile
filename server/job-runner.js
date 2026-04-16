const { acquireWakeLock, notify, releaseWakeLock } = require('./notifier');
const { createStructuredError, toStructuredError } = require('./retry-error');
const { validateAcceptedText } = require('./validation');
const { touchJob } = require('./state');
const { writeAcceptedResult } = require('./chat-writer');

async function runJob(job, environment) {
    acquireWakeLock();
    try {
        while (!job.cancelRequested && job.acceptedCount < job.targetAcceptedCount && job.attemptCount < job.maxAttempts) {
            job.attemptCount += 1;
            touchJob(job, {
                phase: 'requesting_generation',
                structuredError: null,
            });

            const responsePayload = await replayCapturedRequest(job, environment);
            const text = extractResponseText(responsePayload);
            const validation = validateAcceptedText(text, job.runConfig);

            if (!validation.accepted) {
                job.lastError = `Rejected response: ${validation.reason}`;
                job.structuredError = null;
                job.lastAcceptedMetrics = validation.metrics;
                touchJob(job, {
                    phase: 'validation_rejected',
                });
                continue;
            }

            touchJob(job, {
                phase: 'writing_chat',
            });
            await writeAcceptedResult(job, validation.metrics);
            job.acceptedResults.push({
                text: validation.metrics.text,
                wordCount: validation.metrics.wordCount,
                tokenCount: validation.metrics.tokenCount,
            });
            job.acceptedCount += 1;
            job.lastAcceptedMetrics = validation.metrics;
            job.lastAcceptedAt = new Date().toISOString();
            job.lastError = '';
            job.structuredError = null;
            touchJob(job, {
                phase: 'awaiting_retry_results',
            });

            notify(job.runConfig, 'success', {
                acceptedCount: job.acceptedCount,
                targetAcceptedCount: job.targetAcceptedCount,
                wordCount: validation.metrics.wordCount,
                tokenCount: validation.metrics.tokenCount,
            });
        }

        if (job.cancelRequested) {
            touchJob(job, {
                state: 'cancelled',
                phase: 'cancelled',
            });
            notify(job.runConfig, 'stopped', {
                attemptCount: job.attemptCount,
                acceptedCount: job.acceptedCount,
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
            });
            releaseWakeLock();
            return;
        }

        const structuredError = toStructuredError(createStructuredError(
            'backend_write_failed',
            'Maximum attempts reached before the accepted target was met.',
        ));
        touchJob(job, {
            state: 'failed',
            phase: 'failed',
            lastError: structuredError.message,
            structuredError,
        });
        notify(job.runConfig, 'stopped', {
            attemptCount: job.attemptCount,
            acceptedCount: job.acceptedCount,
        });
        releaseWakeLock();
    } catch (error) {
        const structuredError = toStructuredError(error, 'backend_write_failed', 'Retry Mobile backend job failed.');
        touchJob(job, {
            state: 'failed',
            phase: 'failed',
            lastError: structuredError.message,
            structuredError,
        });
        console.error('[retry-mobile:backend] Job failed:', job.jobId, error);
        releaseWakeLock();
    }
}

async function replayCapturedRequest(job, environment) {
    const body = clone(job.capturedRequest);
    body.stream = false;

    const endpoint = resolveGenerationEndpoint(body);
    const response = await fetch(`${environment.baseUrl}${endpoint}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            ...(job.authHeaders || {}),
        },
        body: JSON.stringify(body),
    });

    const text = await response.text();
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
    runJob,
};

