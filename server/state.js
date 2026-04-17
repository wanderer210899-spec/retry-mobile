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
        phase: 'pending_native',
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
        nativeState: 'pending',
        recoveryMode: '',
        captureConfirmedAt: new Date().toISOString(),
        nativeGraceDeadline: '',
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
        phaseText: describePhase(job),
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
        nativeState: job.nativeState,
        recoveryMode: job.recoveryMode,
        captureConfirmedAt: job.captureConfirmedAt,
        nativeGraceDeadline: job.nativeGraceDeadline,
        assistantMessageIndex: job.assistantMessageIndex == null
            ? null
            : (Number.isFinite(Number(job.assistantMessageIndex)) ? Number(job.assistantMessageIndex) : null),
        lastAcceptedMetrics: job.lastAcceptedMetrics ?? null,
        lastAcceptedAt: job.lastAcceptedAt ?? null,
        lastValidation: job.lastValidation ?? null,
        attemptLog: Array.isArray(job.attemptLog) ? job.attemptLog : [],
    };
}

function describePhase(job) {
    if (!job) {
        return 'Idle';
    }

    if (job.state === 'completed') {
        return 'Completed';
    }

    if (job.state === 'failed') {
        return 'Failed';
    }

    if (job.state === 'cancelled') {
        return 'Cancelled';
    }

    if (job.nativeState === 'pending') {
        return 'Waiting for native first reply';
    }

    if (job.phase === 'native_confirmed' && Number(job.attemptCount) === 0 && Number(job.acceptedCount) === 0) {
        return 'Native first reply confirmed';
    }

    if (job.phase === 'native_abandoned') {
        if (job.recoveryMode === 'reuse_empty_placeholder') {
            return 'Native abandoned, backend reused empty native placeholder';
        }
        if (job.recoveryMode === 'create_missing_turn') {
            return 'Native abandoned, backend created the missing assistant turn';
        }
        return 'Native abandoned, backend recovered the turn';
    }

    if (job.phase === 'requesting_generation' || job.phase === 'writing_chat' || job.phase === 'awaiting_retry_results') {
        return 'Retry loop active';
    }

    if (job.nativeState === 'abandoned' && job.recoveryMode === 'reuse_empty_placeholder') {
        return 'Backend reused empty native placeholder';
    }

    if (job.nativeState === 'abandoned' && job.recoveryMode === 'create_missing_turn') {
        return 'Backend created missing assistant turn';
    }

    return 'Retry loop active';
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
