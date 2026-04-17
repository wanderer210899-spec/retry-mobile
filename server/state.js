const jobs = new Map();
const ATTEMPT_LOG_LIMIT = 24;

function buildChatKey(chatIdentity = {}) {
    return [
        chatIdentity.kind || '',
        chatIdentity.chatId || '',
        chatIdentity.groupId || '',
    ].join('::');
}

function createJob(input) {
    const job = {
        jobId: input.jobId,
        runId: input.runId || input.jobId,
        state: 'running',
        phase: 'awaiting_retry_results',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        acceptedCount: 0,
        attemptCount: 0,
        acceptedResults: [],
        cancelRequested: false,
        lastError: '',
        structuredError: null,
        targetMessageIndex: null,
        targetMessageVersion: 0,
        targetMessage: null,
        lastAcceptedAt: null,
        lastValidation: null,
        attemptLog: [],
        ...input,
    };

    jobs.set(job.jobId, job);
    return job;
}

function getJob(jobId) {
    return jobs.get(jobId) ?? null;
}

function getJobByChat(chatIdentity) {
    const chatKey = buildChatKey(chatIdentity);
    for (const job of jobs.values()) {
        if (job.chatKey === chatKey && job.state === 'running') {
            return job;
        }
    }

    return null;
}

function touchJob(job, patch = {}) {
    Object.assign(job, patch, {
        updatedAt: new Date().toISOString(),
    });
    return job;
}

function appendAttemptLog(job, entry = {}) {
    const nextEntry = {
        attemptNumber: Number(entry.attemptNumber) || 0,
        startedAt: typeof entry.startedAt === 'string' ? entry.startedAt : new Date().toISOString(),
        finishedAt: typeof entry.finishedAt === 'string' ? entry.finishedAt : new Date().toISOString(),
        outcome: typeof entry.outcome === 'string' ? entry.outcome : 'unknown',
        reason: typeof entry.reason === 'string' ? entry.reason : '',
        message: typeof entry.message === 'string' ? entry.message : '',
        phase: typeof entry.phase === 'string' ? entry.phase : '',
        characterCount: Number.isFinite(Number(entry.characterCount)) ? Number(entry.characterCount) : null,
        tokenCount: Number.isFinite(Number(entry.tokenCount)) ? Number(entry.tokenCount) : null,
        targetMessageVersion: Number.isFinite(Number(entry.targetMessageVersion)) ? Number(entry.targetMessageVersion) : null,
        targetMessageIndex: Number.isFinite(Number(entry.targetMessageIndex)) ? Number(entry.targetMessageIndex) : null,
    };

    const current = Array.isArray(job.attemptLog) ? job.attemptLog : [];
    job.attemptLog = [...current, nextEntry].slice(-ATTEMPT_LOG_LIMIT);
    job.updatedAt = new Date().toISOString();
    return nextEntry;
}

function serializeJob(job) {
    if (!job) {
        return null;
    }

    return {
        jobId: job.jobId,
        runId: job.runId,
        state: job.state,
        phase: job.phase,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        acceptedCount: job.acceptedCount,
        attemptCount: job.attemptCount,
        targetAcceptedCount: job.targetAcceptedCount,
        maxAttempts: job.maxAttempts,
        chatIdentity: job.chatIdentity,
        lastError: job.lastError,
        structuredError: job.structuredError,
        cancelRequested: job.cancelRequested,
        targetMessageIndex: job.targetMessageIndex,
        targetMessageVersion: job.targetMessageVersion,
        targetMessage: job.targetMessage,
        targetFingerprint: job.targetFingerprint,
        lastAcceptedMetrics: job.lastAcceptedMetrics ?? null,
        lastAcceptedAt: job.lastAcceptedAt ?? null,
        lastValidation: job.lastValidation ?? null,
        attemptLog: Array.isArray(job.attemptLog) ? job.attemptLog : [],
    };
}

module.exports = {
    buildChatKey,
    createJob,
    getJob,
    getJobByChat,
    jobs,
    appendAttemptLog,
    serializeJob,
    touchJob,
};
