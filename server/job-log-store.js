const fs = require('node:fs');
const path = require('node:path');

const { updateJobLogState } = require('./state');

function getJobLogPath(handle, directories, jobId) {
    const paths = getRetryLogPaths(handle, directories);
    return path.join(paths.jobsDir, `${jobId}.log.jsonl`);
}

function ensureJobLog(job) {
    if (!job?.jobId || !job?.userContext?.handle) {
        return {
            title: buildJobLogTitle(job),
            updatedAt: job?.createdAt || new Date().toISOString(),
            entryCount: 0,
        };
    }

    const logPath = getJobLogPath(job.userContext.handle, job.userContext.directories, job.jobId);
    if (fs.existsSync(logPath)) {
        const hydrated = hydrateJobLogCursor(job, logPath);
        if (!job.logTitle || !job.logUpdatedAt || !Number.isFinite(Number(job.logEntryCount))) {
            updateJobLogState(job, hydrated);
        }
        return hydrated;
    }

    const title = buildJobLogTitle(job);
    const entry = buildLogEntry(job, {
        source: 'backend',
        event: 'log_initialized',
        summary: `Created backend retry log "${title}".`,
        detail: {
            title,
            jobId: job.jobId,
            runId: job.runId,
        },
        at: job.createdAt || new Date().toISOString(),
    });
    appendJsonLine(logPath, entry);
    const cursor = {
        title,
        updatedAt: entry.at,
        entryCount: 1,
    };
    updateJobLogState(job, {
        logTitle: cursor.title,
        logUpdatedAt: cursor.updatedAt,
        logEntryCount: cursor.entryCount,
    });
    return cursor;
}

function appendJobLog(job, entry = {}) {
    if (!job?.jobId || !job?.userContext?.handle) {
        return null;
    }

    ensureJobLog(job);
    const logPath = getJobLogPath(job.userContext.handle, job.userContext.directories, job.jobId);
    const payload = buildLogEntry(job, entry);
    appendJsonLine(logPath, payload);
    const nextCount = (Number(job.logEntryCount) || 0) + 1;
    updateJobLogState(job, {
        logTitle: job.logTitle || buildJobLogTitle(job),
        logUpdatedAt: payload.at,
        logEntryCount: nextCount,
    });
    return payload;
}

function readJobLogEntries(job) {
    if (!job?.jobId || !job?.userContext?.handle) {
        return [];
    }

    const logPath = getJobLogPath(job.userContext.handle, job.userContext.directories, job.jobId);
    if (!fs.existsSync(logPath)) {
        ensureJobLog(job);
    }
    return readJsonlFile(logPath);
}

function renderJobLog(job, options = {}) {
    const entries = readJobLogEntries(job);
    const title = job?.logTitle || buildJobLogTitle(job);
    const compatibility = options.compatibility || {};
    const latestAttempt = getLatestAttempt(job);
    const lines = [
        title,
        '',
        'Job Snapshot:',
        `jobId: ${job?.jobId || 'none'}`,
        `runId: ${job?.runId || 'none'}`,
        `createdAt: ${job?.createdAt || 'none'}`,
        `updatedAt: ${job?.updatedAt || 'none'}`,
        `revision: ${formatNumber(job?.revision, 'none')}`,
        `state: ${job?.state || 'unknown'}`,
        `phase: ${job?.phase || 'unknown'}`,
        `accepted: ${Number(job?.acceptedCount) || 0}/${Number(job?.targetAcceptedCount) || 0}`,
        `attempts: ${Number(job?.attemptCount) || 0}/${Number(job?.maxAttempts) || 0}`,
        `cancelRequested: ${job?.cancelRequested ? 'yes' : 'no'}`,
        `ownerSessionId: ${job?.ownerSessionId || 'none'}`,
        `validationMode: ${job?.runConfig?.validationMode || 'characters'}`,
        `validationThreshold: ${resolveValidationThreshold(job?.runConfig)}`,
        `allowHeuristicTokenFallback: ${job?.runConfig?.allowHeuristicTokenFallback === true ? 'yes' : 'no'}`,
        `tokenizerDescriptor: ${formatDetail(job?.tokenizerDescriptor || null)}`,
        `nativeState: ${job?.nativeState || 'unknown'}`,
        `recoveryMode: ${formatRecoveryMode(job?.recoveryMode)}`,
        `nativeResolutionCause: ${job?.nativeResolutionCause || 'none'}`,
        `nativeFailureHintedAt: ${job?.nativeFailureHintedAt || 'none'}`,
        `nativeGraceDeadline: ${job?.nativeGraceDeadline || 'none'}`,
        `frontendVisibilityState: ${job?.frontendVisibilityState || 'unknown'}`,
        `frontendHiddenSince: ${job?.frontendHiddenSince || 'none'}`,
        `lastFrontendSeenAt: ${job?.lastFrontendSeenAt || 'none'}`,
        `assistantMessageIndex: ${job?.assistantMessageIndex == null ? 'none' : Number(job.assistantMessageIndex)}`,
        `targetMessageVersion: ${Number(job?.targetMessageVersion) || 0}`,
        `lastError: ${job?.lastError || 'none'}`,
        `logUpdatedAt: ${job?.logUpdatedAt || 'none'}`,
        `logEntryCount: ${Number(job?.logEntryCount) || 0}`,
        '',
        'Runtime Compatibility:',
        `nativeSaveSupport: ${compatibility?.nativeSaveSupport ? 'yes' : 'no'}`,
        `nativeSaveCompatibilityDetail: ${compatibility?.detail || 'none'}`,
        `compatibilityCheckedAt: ${compatibility?.checkedAt || 'none'}`,
        `userDirectorySupport: ${compatibility?.userDirectorySupport == null ? 'unknown' : (compatibility.userDirectorySupport ? 'yes' : 'no')}`,
        `userDirectoryScanSupport: ${compatibility?.userDirectoryScanSupport == null ? 'unknown' : (compatibility.userDirectoryScanSupport ? 'yes' : 'no')}`,
        '',
        'Attempt Summary:',
    ];

    if (!latestAttempt) {
        lines.push('No attempts recorded yet.');
    } else {
        lines.push(
            `latestAttemptNumber: ${Number(latestAttempt.attemptNumber) || 0}`,
            `outcome: ${latestAttempt.outcome || 'unknown'}`,
            `reason: ${latestAttempt.reason || 'none'}`,
            `message: ${latestAttempt.message || 'none'}`,
            `phase: ${latestAttempt.phase || 'unknown'}`,
            `startedAt: ${latestAttempt.startedAt || 'none'}`,
            `finishedAt: ${latestAttempt.finishedAt || 'none'}`,
            `attemptDurationMs: ${formatAttemptDuration(latestAttempt)}`,
            `characterCount: ${latestAttempt.characterCount == null ? 'none' : latestAttempt.characterCount}`,
            `tokenCount: ${latestAttempt.tokenCount == null ? 'none' : latestAttempt.tokenCount}`,
            `tokenCountSource: ${latestAttempt.tokenCountSource || 'none'}`,
            `tokenCountModel: ${latestAttempt.tokenCountModel || 'none'}`,
            `tokenCountDetail: ${latestAttempt.tokenCountDetail || 'none'}`,
            `targetMessageVersion: ${latestAttempt.targetMessageVersion == null ? 'none' : latestAttempt.targetMessageVersion}`,
        );
    }

    lines.push('', 'Latest Frontend Snapshot:');
    const latestFrontendSnapshot = getLatestFrontendSnapshot(entries);
    if (!latestFrontendSnapshot) {
        lines.push('No frontend status snapshots recorded yet.');
    } else {
        lines.push(
            `event: ${latestFrontendSnapshot.event || 'frontend_event'}`,
            `at: ${latestFrontendSnapshot.at || 'unknown-time'}`,
            `fsm: ${formatFrontendFsmSnapshot(latestFrontendSnapshot.snapshot)}`,
            `runtimeMirror: ${formatFrontendRuntimeSnapshot(latestFrontendSnapshot.snapshot)}`,
            `render: ${formatFrontendRenderSnapshot(latestFrontendSnapshot.snapshot)}`,
            `browser: ${formatFrontendBrowserSnapshot(latestFrontendSnapshot.snapshot)}`,
        );
    }

    lines.push('', 'Attempt Timeline:');
    if (Array.isArray(job?.attemptLog) && job.attemptLog.length > 0) {
        job.attemptLog.forEach((entry) => {
            lines.push(formatAttemptEntry(entry));
        });
    } else {
        lines.push('No attempts recorded yet.');
    }

    lines.push('', 'Event Timeline:');
    if (entries.length > 0) {
        entries.forEach((entry) => {
            lines.push(formatEventEntry(entry));
        });
    } else {
        lines.push('No persisted log events recorded yet.');
    }

    lines.push('', 'Warnings:');
    const warnings = collectWarnings(job);
    if (warnings.length === 0) {
        lines.push('none');
    } else {
        warnings.forEach((warning) => lines.push(warning));
    }

    return lines.join('\n');
}

function deleteJobLog(jobId, handle, directories) {
    if (!jobId || !handle) {
        return;
    }

    const logPath = getJobLogPath(handle, directories, jobId);
    try {
        fs.rmSync(logPath, { force: true });
    } catch {}
}

function getRetryLogPaths(handle, directories = null) {
    const resolvedRoot = directories?.root;
    if (!resolvedRoot) {
        throw new Error(`Retry Mobile could not resolve a user data root for "${handle}".`);
    }

    const retryRoot = path.join(resolvedRoot, 'retry-mobile');
    return {
        retryRoot,
        jobsDir: path.join(retryRoot, 'jobs'),
    };
}

function hydrateJobLogCursor(job, logPath) {
    const entries = readJsonlFile(logPath);
    const lastEntry = entries[entries.length - 1] || null;
    const title = typeof job?.logTitle === 'string' && job.logTitle
        ? job.logTitle
        : extractTitleFromEntries(entries) || buildJobLogTitle(job);
    return {
        title,
        updatedAt: lastEntry?.at || job?.updatedAt || job?.createdAt || null,
        entryCount: entries.length,
    };
}

function extractTitleFromEntries(entries) {
    const metaEntry = Array.isArray(entries)
        ? entries.find((entry) => entry?.event === 'log_initialized' && entry?.detail?.title)
        : null;
    return metaEntry?.detail?.title || '';
}

function buildLogEntry(job, entry = {}) {
    const at = formatLogTimestamp(job, entry.at || new Date().toISOString());
    return {
        at,
        source: String(entry.source || 'backend'),
        event: String(entry.event || 'event'),
        summary: String(entry.summary || ''),
        detail: entry.detail ?? null,
        jobId: job?.jobId || null,
        runId: job?.runId || null,
        state: job?.state || 'unknown',
        phase: job?.phase || 'unknown',
        backendStatus: buildBackendStatusSnapshot(job),
        frontendStatus: normalizeFrontendStatusSnapshot(entry.frontendStatus),
    };
}

function appendJsonLine(filePath, payload) {
    const directory = path.dirname(filePath);
    fs.mkdirSync(directory, { recursive: true });
    const line = `${JSON.stringify(payload)}\n`;
    const fd = fs.openSync(filePath, 'a');
    try {
        fs.writeSync(fd, line, null, 'utf8');
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
}

function readJsonlFile(filePath) {
    try {
        const text = fs.readFileSync(filePath, 'utf8');
        return String(text || '')
            .split(/\r?\n/u)
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => {
                try {
                    return JSON.parse(line);
                } catch {
                    return null;
                }
            })
            .filter(Boolean);
    } catch {
        return [];
    }
}

function buildJobLogTitle(job) {
    const createdAt = job?.createdAt || new Date().toISOString();
    const stamp = formatTitleTimestamp(createdAt, job);
    const zoneLabel = formatTimestampZoneLabel(job, createdAt);
    const chatLabel = sanitizeTitlePart(buildChatLabel(job));
    const shortJobId = sanitizeTitlePart(String(job?.jobId || 'unknown').slice(0, 8));
    return `${stamp} ${zoneLabel} - ${chatLabel} - ${shortJobId}`;
}

function formatTitleTimestamp(value, job = null) {
    return formatTimestampParts(value, job).title;
}

function formatLogTimestamp(job, value) {
    return formatTimestampParts(value, job).iso;
}

function formatTimestampParts(value, job = null) {
    const parsed = Date.parse(value || '');
    const utcDate = Number.isFinite(parsed)
        ? new Date(parsed)
        : new Date();
    const offsetMinutes = resolveDisplayOffsetMinutes(job, utcDate);
    const localDate = new Date(utcDate.getTime() - (offsetMinutes * 60_000));
    const yyyy = String(localDate.getUTCFullYear()).padStart(4, '0');
    const mm = String(localDate.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(localDate.getUTCDate()).padStart(2, '0');
    const hh = String(localDate.getUTCHours()).padStart(2, '0');
    const mi = String(localDate.getUTCMinutes()).padStart(2, '0');
    const ss = String(localDate.getUTCSeconds()).padStart(2, '0');
    return {
        title: `${yyyy}-${mm}-${dd} ${hh}-${mi}-${ss}`,
        iso: `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}${formatOffsetSuffix(offsetMinutes)}`,
    };
}

function formatTimestampZoneLabel(job, value) {
    const parsed = Date.parse(value || '');
    const utcDate = Number.isFinite(parsed)
        ? new Date(parsed)
        : new Date();
    return `UTC${formatOffsetSuffix(resolveDisplayOffsetMinutes(job, utcDate))}`;
}

function resolveDisplayOffsetMinutes(job, date) {
    const clientOffset = Number(job?.captureMeta?.clientTimezoneOffsetMinutes);
    if (Number.isFinite(clientOffset) && Math.abs(clientOffset) <= 14 * 60) {
        return Math.trunc(clientOffset);
    }

    return date.getTimezoneOffset();
}

function formatOffsetSuffix(offsetMinutes) {
    const localOffsetMinutes = -Number(offsetMinutes || 0);
    const sign = localOffsetMinutes >= 0 ? '+' : '-';
    const absolute = Math.abs(localOffsetMinutes);
    const hours = String(Math.trunc(absolute / 60)).padStart(2, '0');
    const minutes = String(absolute % 60).padStart(2, '0');
    return `${sign}${hours}:${minutes}`;
}

function buildChatLabel(job) {
    const captureAssistant = String(job?.captureMeta?.assistantName || '').trim();
    if (captureAssistant) {
        return captureAssistant;
    }

    const chatId = String(job?.chatIdentity?.chatId || '').trim();
    if (chatId) {
        return chatId;
    }

    return 'chat';
}

function sanitizeTitlePart(value) {
    return String(value || '')
        .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, ' ')
        .replace(/\s+/gu, ' ')
        .trim() || 'unknown';
}

function getLatestAttempt(job) {
    const attempts = Array.isArray(job?.attemptLog) ? job.attemptLog : [];
    return attempts.length > 0 ? attempts[attempts.length - 1] : null;
}

function formatAttemptDuration(entry) {
    const started = Date.parse(entry?.startedAt || '');
    const finished = Date.parse(entry?.finishedAt || '');
    if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started) {
        return 'none';
    }

    return String(finished - started);
}

function formatAttemptEntry(entry) {
    const parts = [
        `#${Number(entry?.attemptNumber) || 0}`,
        entry?.outcome || 'unknown',
    ];

    if (entry?.phase) {
        parts.push(`phase=${entry.phase}`);
    }
    if (entry?.reason) {
        parts.push(`reason=${entry.reason}`);
    }
    if (entry?.characterCount != null) {
        parts.push(`chars=${entry.characterCount}`);
    }
    if (entry?.tokenCount != null) {
        parts.push(`tokens=${entry.tokenCount}`);
    }
    if (entry?.tokenCountSource) {
        parts.push(`tokenSource=${entry.tokenCountSource}`);
    }
    if (entry?.tokenCountModel) {
        parts.push(`tokenModel=${entry.tokenCountModel}`);
    }
    if (entry?.tokenCountDetail) {
        parts.push(`tokenDetail=${entry.tokenCountDetail}`);
    }
    if (entry?.targetMessageVersion != null) {
        parts.push(`version=${entry.targetMessageVersion}`);
    }
    if (entry?.targetMessageIndex != null) {
        parts.push(`index=${entry.targetMessageIndex}`);
    }
    if (entry?.startedAt) {
        parts.push(`started=${entry.startedAt}`);
    }
    if (entry?.finishedAt) {
        parts.push(`finished=${entry.finishedAt}`);
    }
    if (entry?.message) {
        parts.push(`message=${entry.message}`);
    }

    return parts.join(' | ');
}

function formatEventEntry(entry) {
    const parts = [
        entry?.at || 'unknown-time',
        entry?.source || 'backend',
        entry?.event || 'event',
    ];
    if (entry?.phase) {
        parts.push(`phase=${entry.phase}`);
    }
    if (entry?.backendStatus) {
        parts.push(`backend=${formatBackendStatusSnapshot(entry.backendStatus)}`);
    }
    if (entry?.frontendStatus) {
        parts.push(`frontend=${formatFrontendStatusSnapshot(entry.frontendStatus)}`);
    }
    if (entry?.summary) {
        parts.push(`summary=${entry.summary}`);
    }
    if (entry?.detail) {
        parts.push(`detail=${formatDetail(entry.detail)}`);
    }
    return parts.join(' | ');
}

function formatDetail(detail) {
    if (typeof detail === 'string') {
        return detail;
    }
    try {
        return JSON.stringify(detail);
    } catch {
        return String(detail);
    }
}

function buildBackendStatusSnapshot(job) {
    if (!job) {
        return null;
    }

    return compactObject({
        state: stringOrNull(job.state) || 'unknown',
        phase: stringOrNull(job.phase) || 'unknown',
        revision: finiteNumber(job.revision),
        acceptedCount: finiteNumber(job.acceptedCount) ?? 0,
        targetAcceptedCount: finiteNumber(job.targetAcceptedCount) ?? 0,
        attemptCount: finiteNumber(job.attemptCount) ?? 0,
        maxAttempts: finiteNumber(job.maxAttempts) ?? 0,
        nativeState: stringOrNull(job.nativeState) || 'unknown',
        recoveryMode: stringOrNull(job.recoveryMode),
        nativeResolutionCause: stringOrNull(job.nativeResolutionCause),
        targetMessageVersion: finiteNumber(job.targetMessageVersion) ?? 0,
        frontendVisibilityState: stringOrNull(job.frontendVisibilityState) || 'unknown',
        frontendHiddenSince: stringOrNull(job.frontendHiddenSince),
        lastFrontendSeenAt: stringOrNull(job.lastFrontendSeenAt),
        cancelRequested: Boolean(job.cancelRequested),
        lastError: stringOrNull(job.lastError),
        structuredErrorCode: stringOrNull(job.structuredError?.code),
    });
}

function normalizeFrontendStatusSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') {
        return null;
    }

    return compactObject({
        fsmState: stringOrNull(snapshot.fsmState),
        fsmJobId: stringOrNull(snapshot.fsmJobId),
        fsmRunId: stringOrNull(snapshot.fsmRunId),
        fsmLastStatusRevision: finiteNumber(snapshot.fsmLastStatusRevision),
        runtimeActiveJobId: stringOrNull(snapshot.runtimeActiveJobId),
        runtimeMirrorJobId: stringOrNull(snapshot.runtimeMirrorJobId),
        runtimeMirrorRunId: stringOrNull(snapshot.runtimeMirrorRunId),
        runtimeMirrorState: stringOrNull(snapshot.runtimeMirrorState),
        runtimeMirrorPhase: stringOrNull(snapshot.runtimeMirrorPhase),
        runtimeMirrorRevision: finiteNumber(snapshot.runtimeMirrorRevision),
        runtimeAcceptedCount: finiteNumber(snapshot.runtimeAcceptedCount),
        runtimeTargetAcceptedCount: finiteNumber(snapshot.runtimeTargetAcceptedCount),
        runtimeAttemptCount: finiteNumber(snapshot.runtimeAttemptCount),
        runtimeMaxAttempts: finiteNumber(snapshot.runtimeMaxAttempts),
        runtimeTargetMessageVersion: finiteNumber(snapshot.runtimeTargetMessageVersion),
        runtimeNativeState: stringOrNull(snapshot.runtimeNativeState),
        runtimeFrontendVisibilityState: stringOrNull(snapshot.runtimeFrontendVisibilityState),
        lastKnownTargetMessageVersion: finiteNumber(snapshot.lastKnownTargetMessageVersion),
        lastAppliedVersion: finiteNumber(snapshot.lastAppliedVersion),
        pendingVisibleRenderVersion: finiteNumber(snapshot.pendingVisibleRenderVersion),
        reloadAttempted: booleanOrNull(snapshot.reloadAttempted),
        runErrorCode: stringOrNull(snapshot.runErrorCode),
        terminalErrorCode: stringOrNull(snapshot.terminalErrorCode),
        browserVisibilityState: stringOrNull(snapshot.browserVisibilityState),
        browserOnline: booleanOrNull(snapshot.browserOnline),
        logJobId: stringOrNull(snapshot.logJobId),
        logEntryCount: finiteNumber(snapshot.logEntryCount),
        logUpdatedAt: stringOrNull(snapshot.logUpdatedAt),
    });
}

function getLatestFrontendSnapshot(entries) {
    for (let index = entries.length - 1; index >= 0; index--) {
        const entry = entries[index];
        if (entry?.source === 'frontend' && entry.frontendStatus) {
            return {
                at: entry.at,
                event: entry.event,
                snapshot: entry.frontendStatus,
            };
        }
    }
    return null;
}

function formatBackendStatusSnapshot(snapshot) {
    if (!snapshot) {
        return 'none';
    }

    const parts = [
        `state=${snapshot.state || 'unknown'}`,
        `phase=${snapshot.phase || 'unknown'}`,
        `rev=${formatNumber(snapshot.revision, 'none')}`,
        `accepted=${formatNumber(snapshot.acceptedCount, 0)}/${formatNumber(snapshot.targetAcceptedCount, 0)}`,
        `attempts=${formatNumber(snapshot.attemptCount, 0)}/${formatNumber(snapshot.maxAttempts, 0)}`,
        `native=${snapshot.nativeState || 'unknown'}`,
        `version=${formatNumber(snapshot.targetMessageVersion, 0)}`,
        `frontend=${snapshot.frontendVisibilityState || 'unknown'}`,
    ];

    if (snapshot.recoveryMode) {
        parts.push(`recovery=${snapshot.recoveryMode}`);
    }
    if (snapshot.nativeResolutionCause) {
        parts.push(`nativeCause=${snapshot.nativeResolutionCause}`);
    }
    if (snapshot.lastFrontendSeenAt) {
        parts.push(`lastSeen=${snapshot.lastFrontendSeenAt}`);
    }
    if (snapshot.cancelRequested) {
        parts.push('cancelRequested=yes');
    }
    if (snapshot.structuredErrorCode) {
        parts.push(`errorCode=${snapshot.structuredErrorCode}`);
    } else if (snapshot.lastError) {
        parts.push(`lastError=${snapshot.lastError}`);
    }

    return parts.join(' ');
}

function formatFrontendStatusSnapshot(snapshot) {
    if (!snapshot) {
        return 'none';
    }

    return [
        formatFrontendFsmSnapshot(snapshot),
        formatFrontendRuntimeSnapshot(snapshot),
        formatFrontendRenderSnapshot(snapshot),
        formatFrontendBrowserSnapshot(snapshot),
    ].filter(Boolean).join(' | ');
}

function formatFrontendFsmSnapshot(snapshot) {
    if (!snapshot) {
        return 'none';
    }

    return [
        `fsm=${snapshot.fsmState || 'unknown'}`,
        `job=${snapshot.fsmJobId || 'none'}`,
        `run=${snapshot.fsmRunId || 'none'}`,
        `rev=${formatNumber(snapshot.fsmLastStatusRevision, 0)}`,
    ].join(' ');
}

function formatFrontendRuntimeSnapshot(snapshot) {
    if (!snapshot) {
        return 'none';
    }

    return [
        `active=${snapshot.runtimeActiveJobId || 'none'}`,
        `mirror=${snapshot.runtimeMirrorState || 'none'}`,
        `mirrorJob=${snapshot.runtimeMirrorJobId || 'none'}`,
        `mirrorRun=${snapshot.runtimeMirrorRunId || 'none'}`,
        `mirrorRev=${formatNumber(snapshot.runtimeMirrorRevision, 0)}`,
        `accepted=${formatNumber(snapshot.runtimeAcceptedCount, 0)}/${formatNumber(snapshot.runtimeTargetAcceptedCount, 0)}`,
        `attempts=${formatNumber(snapshot.runtimeAttemptCount, 0)}/${formatNumber(snapshot.runtimeMaxAttempts, 0)}`,
        `version=${formatNumber(snapshot.runtimeTargetMessageVersion, 0)}`,
    ].join(' ');
}

function formatFrontendRenderSnapshot(snapshot) {
    if (!snapshot) {
        return 'none';
    }

    return [
        `known=${formatNumber(snapshot.lastKnownTargetMessageVersion, 0)}`,
        `applied=${formatNumber(snapshot.lastAppliedVersion, 0)}`,
        `pending=${formatNumber(snapshot.pendingVisibleRenderVersion, 'none')}`,
        `reload=${snapshot.reloadAttempted === true ? 'yes' : 'no'}`,
        snapshot.runErrorCode ? `runError=${snapshot.runErrorCode}` : '',
        snapshot.terminalErrorCode ? `terminalError=${snapshot.terminalErrorCode}` : '',
    ].filter(Boolean).join(' ');
}

function formatFrontendBrowserSnapshot(snapshot) {
    if (!snapshot) {
        return 'none';
    }

    return [
        `visibility=${snapshot.browserVisibilityState || 'unknown'}`,
        `online=${snapshot.browserOnline == null ? 'unknown' : (snapshot.browserOnline ? 'yes' : 'no')}`,
        `backendVisibility=${snapshot.runtimeFrontendVisibilityState || 'unknown'}`,
    ].join(' ');
}

function compactObject(input) {
    const output = {};
    for (const [key, value] of Object.entries(input || {})) {
        if (value === null || value === undefined || value === '') {
            continue;
        }
        output[key] = value;
    }
    return Object.keys(output).length > 0 ? output : null;
}

function stringOrNull(value) {
    return typeof value === 'string' && value.trim()
        ? value.trim()
        : null;
}

function finiteNumber(value) {
    const number = Number(value);
    return Number.isFinite(number)
        ? number
        : null;
}

function booleanOrNull(value) {
    return typeof value === 'boolean' ? value : null;
}

function formatNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? String(number) : String(fallback);
}

function formatRecoveryMode(mode) {
    switch (mode) {
        case 'top_up_existing':
            return 'Top up existing assistant turn';
        case 'reuse_empty_placeholder':
            return 'Reuse empty native placeholder';
        case 'create_missing_turn':
            return 'Create missing assistant turn';
        default:
            return 'none';
    }
}

function collectWarnings(job) {
    const warnings = [];
    const graceDeadlineMs = Date.parse(job?.nativeGraceDeadline || '');
    if (job?.nativeState === 'pending' && Number.isFinite(graceDeadlineMs) && graceDeadlineMs < Date.now()) {
        warnings.push('native grace deadline expired while native resolution is still pending.');
    }
    return warnings;
}

function resolveValidationThreshold(runConfig = {}) {
    if (runConfig?.validationMode === 'tokens') {
        return Number(runConfig?.minTokens) || 0;
    }

    return Number(runConfig?.minCharacters) || 0;
}

module.exports = {
    appendJobLog,
    buildJobLogTitle,
    deleteJobLog,
    ensureJobLog,
    getJobLogPath,
    readJobLogEntries,
    renderJobLog,
};
