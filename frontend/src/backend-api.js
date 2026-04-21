import { createStructuredError } from './retry-error.js';
import { BACKEND_PLUGIN_ID } from './constants.js';

const BASE_URL = `/api/plugins/${BACKEND_PLUGIN_ID}`;
let requestHeadersHelperPromise = null;

export async function startBackendJob(payload) {
    return requestJson(`${BASE_URL}/start`, {
        method: 'POST',
        body: JSON.stringify(payload),
    });
}

export async function confirmNativeJob(jobId, payload) {
    if (!jobId) {
        throw createStructuredError(
            'handoff_request_failed',
            'Retry Mobile could not confirm the native turn because no backend job is active.',
        );
    }

    return requestJson(`${BASE_URL}/confirm-native/${encodeURIComponent(jobId)}`, {
        method: 'POST',
        body: JSON.stringify(payload),
    });
}

export async function reportNativeFailure(jobId, payload) {
    if (!jobId) {
        throw createStructuredError(
            'handoff_request_failed',
            'Retry Mobile could not report the native wait outcome because no backend job is active.',
        );
    }

    return requestJson(`${BASE_URL}/native-failed/${encodeURIComponent(jobId)}`, {
        method: 'POST',
        body: JSON.stringify(payload),
    });
}

export async function reportFrontendPresence(jobId, payload) {
    if (!jobId) {
        throw createStructuredError(
            'handoff_request_failed',
            'Retry Mobile could not report frontend presence because no backend job is active.',
        );
    }

    return requestJson(`${BASE_URL}/frontend-presence/${encodeURIComponent(jobId)}`, {
        method: 'POST',
        body: JSON.stringify(payload),
    });
}

export async function cancelBackendJob(jobId) {
    if (!jobId) {
        return { ok: false };
    }

    return requestJson(`${BASE_URL}/cancel/${encodeURIComponent(jobId)}`, {
        method: 'POST',
    });
}

export async function fetchJobStatus(jobId) {
    if (!jobId) {
        return null;
    }

    return requestJson(`${BASE_URL}/status/${encodeURIComponent(jobId)}`, {
        method: 'GET',
    });
}

export async function fetchCapabilities() {
    try {
        return await requestJson(`${BASE_URL}/capabilities`, { method: 'GET' });
    } catch {
        return {
            protocolVersion: 0,
            minSupportedProtocolVersion: 0,
            nativeSaveSupport: false,
            nativeSaveCompatibilityDetail: '',
            compatibilityCheckedAt: null,
            userDirectorySupport: false,
            userDirectoryScanSupport: false,
            termux: false,
            termuxCheckedAt: null,
        };
    }
}

export async function fetchReleaseInfo() {
    return requestJson(`${BASE_URL}/release-info`, {
        method: 'GET',
    });
}

export async function fetchActiveJob(identity, options = {}) {
    const query = new URLSearchParams();
    if (identity?.chatId) {
        query.set('chatId', identity.chatId);
    }
    if (identity?.groupId) {
        query.set('groupId', identity.groupId);
    }
    if (options?.sessionId) {
        query.set('sessionId', String(options.sessionId));
    }
    if (options?.sameSessionOnly) {
        query.set('sameSessionOnly', 'true');
    }

    const suffix = query.toString() ? `?${query.toString()}` : '';
    return requestJson(`${BASE_URL}/active${suffix}`, {
        method: 'GET',
    });
}

export async function fetchLatestJob(identity) {
    const query = new URLSearchParams();
    if (identity?.chatId) {
        query.set('chatId', identity.chatId);
    }
    if (identity?.groupId) {
        query.set('groupId', identity.groupId);
    }

    const suffix = query.toString() ? `?${query.toString()}` : '';
    return requestJson(`${BASE_URL}/latest${suffix}`, {
        method: 'GET',
    });
}

export async function fetchChatState(identity) {
    const query = new URLSearchParams();
    if (identity?.chatId) {
        query.set('chatId', identity.chatId);
    }
    if (identity?.groupId) {
        query.set('groupId', identity.groupId);
    }

    const suffix = query.toString() ? `?${query.toString()}` : '';
    return requestJson(`${BASE_URL}/state${suffix}`, {
        method: 'GET',
    });
}

export async function fetchJobOrphans(jobId) {
    if (!jobId) {
        return null;
    }

    return requestJson(`${BASE_URL}/orphans/${encodeURIComponent(jobId)}`, {
        method: 'GET',
    });
}

export async function fetchJobLog(jobId) {
    if (!jobId) {
        return null;
    }

    return requestJson(`${BASE_URL}/log/${encodeURIComponent(jobId)}`, {
        method: 'GET',
    });
}

export async function postJobLogEvent(jobId, payload) {
    if (!jobId) {
        return { ok: false };
    }

    return requestJson(`${BASE_URL}/log-event/${encodeURIComponent(jobId)}`, {
        method: 'POST',
        body: JSON.stringify(payload || {}),
    });
}

async function requestJson(url, options) {
    const headers = await buildRequestHeaders(options?.headers);
    const response = await fetch(url, {
        credentials: 'same-origin',
        headers,
        ...options,
    });

    const text = await response.text();
    let data = null;

    try {
        data = text ? JSON.parse(text) : {};
    } catch {
        data = { raw: text };
    }

    if (!response.ok) {
        const error = new Error(data?.error || data?.structuredError?.message || `Request failed with status ${response.status}`);
        error.status = response.status;
        error.payload = data;
        error.code = data?.structuredError?.code || 'handoff_request_failed';
        error.detail = data?.structuredError?.detail || '';
        throw error;
    }

    return data;
}

async function buildRequestHeaders(extraHeaders) {
    const helper = await resolveRequestHeadersHelper();
    const baseHeaders = typeof helper === 'function'
        ? safeGetRequestHeaders(helper)
        : {
            'Content-Type': 'application/json',
        };

    return {
        ...baseHeaders,
        ...(extraHeaders || {}),
    };
}

async function resolveRequestHeadersHelper() {
    if (typeof globalThis.getRequestHeaders === 'function') {
        return globalThis.getRequestHeaders;
    }

    const contextHelper = globalThis.window?.SillyTavern?.getContext?.()?.getRequestHeaders;
    if (typeof contextHelper === 'function') {
        return contextHelper;
    }

    requestHeadersHelperPromise ??= loadStRequestHeadersHelper();
    return requestHeadersHelperPromise;
}

async function loadStRequestHeadersHelper() {
    try {
        const scriptModuleUrl = new URL('../../../../../script.js', import.meta.url);
        const scriptModule = await import(scriptModuleUrl);
        return typeof scriptModule?.getRequestHeaders === 'function'
            ? scriptModule.getRequestHeaders
            : null;
    } catch {
        return null;
    }
}

function safeGetRequestHeaders(helper) {
    try {
        const headers = helper();
        if (headers && typeof headers === 'object') {
            return headers;
        }
    } catch {
        // Fall back to JSON headers if SillyTavern's helper is unavailable.
    }

    return {
        'Content-Type': 'application/json',
    };
}

export function getStructuredErrorFromApi(error, fallbackMessage) {
    const payloadError = error?.payload?.structuredError;
    if (payloadError?.code && payloadError?.message) {
        return payloadError;
    }

    return createStructuredError(
        typeof error?.code === 'string' && error.code
            ? error.code
            : 'handoff_request_failed',
        error?.message || fallbackMessage || 'Retry Mobile could not reach the backend.',
        typeof error?.detail === 'string' ? error.detail : '',
    );
}

