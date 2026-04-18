const jobs = new Map();
const ATTEMPT_LOG_LIMIT = 24;
const ORPHAN_PREVIEW_LIMIT = 3;
const ORPHAN_PREVIEW_TEXT_LIMIT = 240;

let persistJobSnapshotHandler = null;

function setPersistenceHandler(handler) {
    persistJobSnapshotHandler = typeof handler === 'function' ? handler : null;
}

function buildChatKey(chatIdentity = {}) {
    return [
        chatIdentity.kind || '',
        chatIdentity.chatId || '',
        chatIdentity.groupId || '',
    ].join('::');
}

function createJob(input = {}) {
    const job = {
        schemaVersion: Number(input.schemaVersion) || 1,
        jobId: input.jobId,
        runId: input.runId || input.jobId,
        state: input.state || 'running',
        phase: input.phase || 'pending_native',
        createdAt: input.createdAt || new Date().toISOString(),
        updatedAt: input.updatedAt || new Date().toISOString(),
        acceptedCount: Number(input.acceptedCount) || 0,
        attemptCount: Number(input.attemptCount) || 0,
        acceptedResults: Array.isArray(input.acceptedResults) ? input.acceptedResults : [],
        orphanedAcceptedResults: Array.isArray(input.orphanedAcceptedResults) ? input.orphanedAcceptedResults : [],
        cancelRequested: Boolean(input.cancelRequested),
        lastError: typeof input.lastError === 'string' ? input.lastError : '',
        structuredError: input.structuredError ?? null,
        targetMessageIndex: Number.isFinite(Number(input.targetMessageIndex)) ? Number(input.targetMessageIndex) : null,
        targetMessageVersion: Number.isFinite(Number(input.targetMessageVersion)) ? Number(input.targetMessageVersion) : 0,
        targetMessage: input.targetMessage ?? null,
        targetAcceptedCount: Number(input.targetAcceptedCount) || 0,
        maxAttempts: Number(input.maxAttempts) || 0,
        chatIdentity: input.chatIdentity ?? null,
        chatKey: typeof input.chatKey === 'string' ? input.chatKey : buildChatKey(input.chatIdentity),
        targetFingerprint: input.targetFingerprint ?? null,
        nativeState: typeof input.nativeState === 'string' ? input.nativeState : 'pending',
        recoveryMode: typeof input.recoveryMode === 'string' ? input.recoveryMode : '',
        nativeResolutionCause: typeof input.nativeResolutionCause === 'string' ? input.nativeResolutionCause : '',
        nativeFailureHintedAt: input.nativeFailureHintedAt ?? null,
        nativeResolutionInProgress: false,
        nativeResolutionPromise: null,
        captureConfirmedAt: input.captureConfirmedAt || new Date().toISOString(),
        nativeGraceDeadline: typeof input.nativeGraceDeadline === 'string' ? input.nativeGraceDeadline : '',
        lastAcceptedAt: input.lastAcceptedAt ?? null,
        lastValidation: input.lastValidation ?? null,
        lastAcceptedMetrics: input.lastAcceptedMetrics ?? null,
        attemptLog: Array.isArray(input.attemptLog) ? input.attemptLog : [],
        runConfig: input.runConfig ?? {},
        capturedRequest: input.capturedRequest ?? null,
        captureMeta: input.captureMeta ?? {},
        assistantMessageIndex: Number.isFinite(Number(input.assistantMessageIndex)) ? Number(input.assistantMessageIndex) : null,
        userContext: input.userContext ?? null,
        generationNumber: Number.isFinite(Number(input.generationNumber)) ? Number(input.generationNumber) : 0,
        expectedPreviousGeneration: Number.isFinite(Number(input.expectedPreviousGeneration)) ? Number(input.expectedPreviousGeneration) : 0,
        inspectionAttempts: Number.isFinite(Number(input.inspectionAttempts)) ? Number(input.inspectionAttempts) : 0,
        capturedChatIntegrity: typeof input.capturedChatIntegrity === 'string' ? input.capturedChatIntegrity : '',
        capturedChatLength: Number.isFinite(Number(input.capturedChatLength)) ? Number(input.capturedChatLength) : 0,
        tokenizerDescriptor: input.tokenizerDescriptor ?? null,
        nativeGraceSeconds: Number.isFinite(Number(input.nativeGraceSeconds)) ? Number(input.nativeGraceSeconds) : 30,
        logTitle: typeof input.logTitle === 'string' ? input.logTitle : '',
        logUpdatedAt: typeof input.logUpdatedAt === 'string' ? input.logUpdatedAt : null,
        logEntryCount: Number.isFinite(Number(input.logEntryCount)) ? Number(input.logEntryCount) : 0,
        jobController: null,
        skipPersist: Boolean(input.skipPersist),
    };

    jobs.set(job.jobId, job);
    if (!job.skipPersist) {
        persistJobSnapshot(job);
    }
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

function getLatestJobByChat(chatIdentity) {
    const chatKey = buildChatKey(chatIdentity);
    let latestJob = null;
    let latestTimestamp = -1;

    for (const job of jobs.values()) {
        if (job.chatKey !== chatKey) {
            continue;
        }

        const timestamp = getJobTimestamp(job);
        if (!latestJob || timestamp > latestTimestamp || (timestamp === latestTimestamp && job.state === 'running' && latestJob.state !== 'running')) {
            latestJob = job;
            latestTimestamp = timestamp;
        }
    }

    return latestJob;
}

function touchJob(job, patch = {}) {
    Object.assign(job, patch, {
        updatedAt: new Date().toISOString(),
    });
    persistJobSnapshot(job);
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
    persistJobSnapshot(job);
    return nextEntry;
}

function updateJobLogState(job, patch = {}) {
    Object.assign(job, patch);
    persistJobSnapshot(job);
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
        phaseText: describePhase(job),
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        acceptedCount: job.acceptedCount,
        attemptCount: job.attemptCount,
        targetAcceptedCount: job.targetAcceptedCount,
        maxAttempts: job.maxAttempts,
        chatIdentity: job.chatIdentity,
        chatKey: job.chatKey,
        lastError: job.lastError,
        structuredError: job.structuredError,
        cancelRequested: job.cancelRequested,
        targetMessageIndex: job.targetMessageIndex,
        targetMessageVersion: job.targetMessageVersion,
        targetMessage: job.targetMessage,
        targetFingerprint: job.targetFingerprint,
        nativeState: job.nativeState,
        recoveryMode: job.recoveryMode,
        nativeResolutionCause: job.nativeResolutionCause || '',
        nativeFailureHintedAt: job.nativeFailureHintedAt ?? null,
        captureConfirmedAt: job.captureConfirmedAt,
        nativeGraceDeadline: job.nativeGraceDeadline,
        assistantMessageIndex: job.assistantMessageIndex == null ? null : Number(job.assistantMessageIndex),
        lastAcceptedMetrics: job.lastAcceptedMetrics ?? null,
        lastAcceptedAt: job.lastAcceptedAt ?? null,
        lastValidation: job.lastValidation ?? null,
        attemptLog: Array.isArray(job.attemptLog) ? job.attemptLog : [],
        generationNumber: Number(job.generationNumber) || 0,
        inspectionAttempts: Number(job.inspectionAttempts) || 0,
        orphanedAcceptedPreview: buildOrphanPreview(job.orphanedAcceptedResults),
        logTitle: typeof job.logTitle === 'string' ? job.logTitle : '',
        logUpdatedAt: typeof job.logUpdatedAt === 'string' ? job.logUpdatedAt : null,
        logEntryCount: Number(job.logEntryCount) || 0,
    };
}

function snapshotJobForPersistence(job) {
    if (!job) {
        return null;
    }

    return {
        schemaVersion: 1,
        jobId: job.jobId,
        runId: job.runId,
        state: job.state,
        phase: job.phase,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        acceptedCount: job.acceptedCount,
        attemptCount: job.attemptCount,
        acceptedResults: cloneValue(job.acceptedResults),
        orphanedAcceptedResults: cloneValue(job.orphanedAcceptedResults),
        cancelRequested: job.cancelRequested,
        lastError: job.lastError,
        structuredError: cloneValue(job.structuredError),
        targetMessageIndex: job.targetMessageIndex,
        targetMessageVersion: job.targetMessageVersion,
        targetMessage: cloneValue(job.targetMessage),
        targetAcceptedCount: job.targetAcceptedCount,
        maxAttempts: job.maxAttempts,
        chatIdentity: cloneValue(job.chatIdentity),
        chatKey: job.chatKey,
        targetFingerprint: cloneValue(job.targetFingerprint),
        nativeState: job.nativeState,
        recoveryMode: job.recoveryMode,
        nativeResolutionCause: job.nativeResolutionCause,
        nativeFailureHintedAt: job.nativeFailureHintedAt,
        captureConfirmedAt: job.captureConfirmedAt,
        nativeGraceDeadline: job.nativeGraceDeadline,
        lastAcceptedAt: job.lastAcceptedAt,
        lastValidation: cloneValue(job.lastValidation),
        lastAcceptedMetrics: cloneValue(job.lastAcceptedMetrics),
        attemptLog: cloneValue(job.attemptLog),
        runConfig: cloneValue(job.runConfig),
        capturedRequest: cloneValue(job.capturedRequest),
        captureMeta: cloneValue(job.captureMeta),
        assistantMessageIndex: job.assistantMessageIndex,
        userContext: cloneValue(job.userContext),
        generationNumber: job.generationNumber,
        expectedPreviousGeneration: job.expectedPreviousGeneration,
        inspectionAttempts: job.inspectionAttempts,
        capturedChatIntegrity: job.capturedChatIntegrity,
        capturedChatLength: job.capturedChatLength,
        tokenizerDescriptor: cloneValue(job.tokenizerDescriptor),
        nativeGraceSeconds: job.nativeGraceSeconds,
        logTitle: job.logTitle,
        logUpdatedAt: job.logUpdatedAt,
        logEntryCount: job.logEntryCount,
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

    if (job.phase === 'partial_on_recovery') {
        return 'Partially recovered after backend restart';
    }

    if (job.phase === 'completed_on_recovery') {
        return 'Recovered completed run after backend restart';
    }

    if (job.phase === 'recovery_ambiguous') {
        return 'Recovery needs attention';
    }

    if (job.phase === 'native_confirming_persisted') {
        return 'Confirming the native turn in the saved chat';
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

    return 'Retry loop active';
}

function persistJobSnapshot(job) {
    if (!persistJobSnapshotHandler || job?.skipPersist) {
        return;
    }

    try {
        persistJobSnapshotHandler(snapshotJobForPersistence(job));
    } catch (error) {
        console.error('[retry-mobile:state] Failed to persist job snapshot:', error);
    }
}

function buildOrphanPreview(orphanedAcceptedResults) {
    const rows = Array.isArray(orphanedAcceptedResults) ? orphanedAcceptedResults : [];
    return {
        count: rows.length,
        items: rows.slice(0, ORPHAN_PREVIEW_LIMIT).map((row, index) => ({
            index,
            characterCount: Number(row?.characterCount) || 0,
            tokenCount: Number(row?.tokenCount) || 0,
            textPreview: String(row?.text || '').slice(0, ORPHAN_PREVIEW_TEXT_LIMIT),
        })),
    };
}

function cloneValue(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function getJobTimestamp(job) {
    const updatedAt = Date.parse(job?.updatedAt || '');
    if (Number.isFinite(updatedAt) && updatedAt > 0) {
        return updatedAt;
    }

    const createdAt = Date.parse(job?.createdAt || '');
    if (Number.isFinite(createdAt) && createdAt > 0) {
        return createdAt;
    }

    return 0;
}

module.exports = {
    buildChatKey,
    createJob,
    getJob,
    getJobByChat,
    getLatestJobByChat,
    jobs,
    appendAttemptLog,
    serializeJob,
    touchJob,
    updateJobLogState,
    setPersistenceHandler,
    snapshotJobForPersistence,
};
