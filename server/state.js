const jobs = new Map();

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
    };
}

module.exports = {
    buildChatKey,
    createJob,
    getJob,
    getJobByChat,
    jobs,
    serializeJob,
    touchJob,
};
