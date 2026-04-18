import { fetchJobLog, postJobLogEvent } from '../backend-api.js';

const LOG_OUTBOX_PREFIX = 'retry-mobile-log-outbox:';

export function getRetryLogContext(runtime) {
    return {
        jobId: runtime.retryLogJobId || runtime.activeJobStatus?.jobId || '',
        title: runtime.retryLogTitle || '',
        text: runtime.retryLogText || '',
        updatedAt: runtime.retryLogUpdatedAt || null,
        entryCount: Number(runtime.retryLogEntryCount) || 0,
    };
}

export async function syncRetryLogForStatus(runtime, status, options = {}) {
    const jobId = String(status?.jobId || '').trim();
    if (!jobId) {
        if (options.clearWhenMissing !== false) {
            clearRetryLog(runtime);
        }
        return null;
    }

    const nextCursor = buildRetryLogCursor(status);
    const currentCursor = buildRetryLogCursor({
        jobId: runtime.retryLogJobId,
        updatedAt: runtime.retryLogUpdatedAt,
        logUpdatedAt: runtime.retryLogUpdatedAt,
        logEntryCount: runtime.retryLogEntryCount,
    });

    if (!options.force && runtime.retryLogJobId === jobId && currentCursor === nextCursor && runtime.retryLogText) {
        return getRetryLogContext(runtime);
    }

    const result = await fetchJobLog(jobId);
    if (!result) {
        return null;
    }

    runtime.retryLogJobId = jobId;
    runtime.retryLogTitle = String(result.title || '');
    runtime.retryLogText = String(result.text || '');
    runtime.retryLogUpdatedAt = result.updatedAt || status?.logUpdatedAt || status?.updatedAt || null;
    runtime.retryLogEntryCount = Number(result.entryCount) || 0;
    await flushRetryLogOutbox(jobId);
    return getRetryLogContext(runtime);
}

export function clearRetryLog(runtime) {
    runtime.retryLogJobId = '';
    runtime.retryLogTitle = '';
    runtime.retryLogText = '';
    runtime.retryLogUpdatedAt = null;
    runtime.retryLogEntryCount = 0;
}

export function buildRetryLogFileName(runtime) {
    const title = String(runtime.retryLogTitle || '').trim();
    if (!title) {
        return `retry-mobile-log-${sanitizeTimestamp(new Date().toISOString())}.txt`;
    }

    const safeTitle = title
        .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, ' ')
        .replace(/\s+/gu, ' ')
        .trim()
        .replaceAll(':', '-')
        .replaceAll(' ', '-');
    return `retry-mobile-log-${safeTitle}.txt`;
}

export async function sendFrontendLogEvent(runtime, event) {
    const jobId = String(runtime.activeJobId || runtime.activeJobStatus?.jobId || runtime.retryLogJobId || '').trim();
    if (!jobId) {
        return false;
    }

    const payload = {
        at: event?.at || new Date().toISOString(),
        event: typeof event?.event === 'string' && event.event ? event.event : 'frontend_event',
        summary: typeof event?.summary === 'string' && event.summary ? event.summary : 'Frontend reported a retry-log event.',
        detail: event?.detail ?? null,
    };

    try {
        await postJobLogEvent(jobId, payload);
        await flushRetryLogOutbox(jobId);
        return true;
    } catch {
        enqueueRetryLogOutbox(jobId, payload);
        return false;
    }
}

export async function flushRetryLogOutbox(jobId) {
    const pending = readRetryLogOutbox(jobId);
    if (pending.length === 0) {
        return;
    }

    const remaining = [];
    for (const entry of pending) {
        try {
            await postJobLogEvent(jobId, entry);
        } catch {
            remaining.push(entry);
        }
    }

    writeRetryLogOutbox(jobId, remaining);
}

function buildRetryLogCursor(status) {
    return [
        String(status?.jobId || ''),
        String(status?.updatedAt || ''),
        String(status?.logUpdatedAt || ''),
        String(Number(status?.logEntryCount) || 0),
    ].join('|');
}

function sanitizeTimestamp(value) {
    const parsed = Date.parse(value || '');
    const safeIso = Number.isFinite(parsed)
        ? new Date(parsed).toISOString()
        : new Date().toISOString();
    return safeIso.replaceAll(':', '-');
}

function getRetryLogOutboxKey(jobId) {
    return `${LOG_OUTBOX_PREFIX}${jobId}`;
}

function enqueueRetryLogOutbox(jobId, payload) {
    const current = readRetryLogOutbox(jobId);
    current.push(payload);
    writeRetryLogOutbox(jobId, current);
}

function readRetryLogOutbox(jobId) {
    try {
        const raw = globalThis.localStorage?.getItem(getRetryLogOutboxKey(jobId));
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function writeRetryLogOutbox(jobId, entries) {
    try {
        if (!entries || entries.length === 0) {
            globalThis.localStorage?.removeItem(getRetryLogOutboxKey(jobId));
            return;
        }
        globalThis.localStorage?.setItem(getRetryLogOutboxKey(jobId), JSON.stringify(entries));
    } catch {
        // Ignore localStorage failures; log ownership still lives on the backend.
    }
}
