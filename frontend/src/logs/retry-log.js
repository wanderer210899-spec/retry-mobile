import { fetchJobLog, postJobLogEvent } from '../backend-api.js';

const LOG_OUTBOX_PREFIX = 'retry-mobile-log-outbox:';

export function getRetryLogContext(runtime) {
    return {
        jobId: runtime.log.jobId || runtime.activeJobStatus?.jobId || '',
        title: runtime.log.title || '',
        text: runtime.log.text || '',
        updatedAt: runtime.log.updatedAt || null,
        entryCount: Number(runtime.log.entryCount) || 0,
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
        jobId: runtime.log.jobId,
        updatedAt: runtime.log.updatedAt,
        logUpdatedAt: runtime.log.updatedAt,
        logEntryCount: runtime.log.entryCount,
    });

    if (!options.force && runtime.log.jobId === jobId && currentCursor === nextCursor && runtime.log.text) {
        return getRetryLogContext(runtime);
    }

    const result = await fetchJobLog(jobId);
    if (!result) {
        return null;
    }

    runtime.log.jobId = jobId;
    runtime.log.title = String(result.title || '');
    runtime.log.text = String(result.text || '');
    runtime.log.updatedAt = result.updatedAt || status?.logUpdatedAt || status?.updatedAt || null;
    runtime.log.entryCount = Number(result.entryCount) || 0;
    await flushRetryLogOutbox(jobId);
    return getRetryLogContext(runtime);
}

export function clearRetryLog(runtime) {
    runtime.log.jobId = '';
    runtime.log.title = '';
    runtime.log.text = '';
    runtime.log.updatedAt = null;
    runtime.log.entryCount = 0;
}

export function buildRetryLogFileName(runtime) {
    const title = String(runtime.log.title || '').trim();
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
    const jobId = String(runtime.activeJobId || runtime.activeJobStatus?.jobId || runtime.log.jobId || '').trim();
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
