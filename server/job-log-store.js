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
        `state: ${job?.state || 'unknown'}`,
        `phase: ${job?.phase || 'unknown'}`,
        `accepted: ${Number(job?.acceptedCount) || 0}/${Number(job?.targetAcceptedCount) || 0}`,
        `attempts: ${Number(job?.attemptCount) || 0}/${Number(job?.maxAttempts) || 0}`,
        `nativeState: ${job?.nativeState || 'unknown'}`,
        `recoveryMode: ${formatRecoveryMode(job?.recoveryMode)}`,
        `nativeResolutionCause: ${job?.nativeResolutionCause || 'none'}`,
        `nativeFailureHintedAt: ${job?.nativeFailureHintedAt || 'none'}`,
        `nativeGraceDeadline: ${job?.nativeGraceDeadline || 'none'}`,
        `assistantMessageIndex: ${job?.assistantMessageIndex == null ? 'none' : Number(job.assistantMessageIndex)}`,
        `targetMessageVersion: ${Number(job?.targetMessageVersion) || 0}`,
        `lastError: ${job?.lastError || 'none'}`,
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
            `targetMessageVersion: ${latestAttempt.targetMessageVersion == null ? 'none' : latestAttempt.targetMessageVersion}`,
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
    return {
        at: entry.at || new Date().toISOString(),
        source: String(entry.source || 'backend'),
        event: String(entry.event || 'event'),
        summary: String(entry.summary || ''),
        detail: entry.detail ?? null,
        jobId: job?.jobId || null,
        runId: job?.runId || null,
        state: job?.state || 'unknown',
        phase: job?.phase || 'unknown',
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
    const stamp = formatTitleTimestamp(job?.createdAt || new Date().toISOString());
    const chatLabel = sanitizeTitlePart(buildChatLabel(job));
    const shortJobId = sanitizeTitlePart(String(job?.jobId || 'unknown').slice(0, 8));
    return `${stamp} UTC - ${chatLabel} - ${shortJobId}`;
}

function formatTitleTimestamp(value) {
    const parsed = Date.parse(value || '');
    const safeIso = Number.isFinite(parsed)
        ? new Date(parsed).toISOString()
        : new Date().toISOString();
    const compact = safeIso.slice(0, 19).replace('T', ' ');
    return compact.replaceAll(':', '-');
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

module.exports = {
    appendJobLog,
    buildJobLogTitle,
    deleteJobLog,
    ensureJobLog,
    getJobLogPath,
    readJobLogEntries,
    renderJobLog,
};
