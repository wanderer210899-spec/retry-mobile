import { createStructuredError } from './retry-error.js';
import { BACKEND_PLUGIN_ID } from './constants.js';

const BASE_URL = `/api/plugins/${BACKEND_PLUGIN_ID}`;
let requestHeadersHelperPromise = null;

export async function startBackendJob(payload) {
    const controller = new AbortController();
    const timeoutHandle = globalThis.setTimeout(() => {
        controller.abort(createStructuredError(
            'handoff_request_failed',
            'Retry Mobile backend start timed out after 45 seconds.',
        ));
    }, 45_000);

    try {
        return await requestJson(`${BASE_URL}/start`, {
            method: 'POST',
            body: JSON.stringify(payload),
            signal: controller.signal,
        });
    } finally {
        globalThis.clearTimeout(timeoutHandle);
    }
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
            uiLanguage: 'en',
            supportedUiLanguages: ['en', 'zh'],
        };
    }
}

export async function fetchReleaseInfo() {
    return requestJson(`${BASE_URL}/release-info`, {
        method: 'GET',
    });
}

export async function fetchI18nCatalog() {
    return requestJson(`${BASE_URL}/i18n-catalog`, {
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
    const requestHeaders = await buildRequestHeaders(options?.headers);
    const requestOptions = { ...(options || {}) };
    delete requestOptions.headers;
    const method = String(requestOptions.method || 'GET').toUpperCase();
    if (!('cache' in requestOptions) && method === 'GET') {
        requestOptions.cache = 'no-store';
    }
    const response = await fetch(url, {
        credentials: 'same-origin',
        ...requestOptions,
        headers: requestHeaders.headers,
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
        error.detail = data?.structuredError?.detail || buildRequestFailureDetail({
            url,
            method: options?.method,
            status: response.status,
            requestHeaders,
            payload: data,
        });
        logRequestFailure({
            url,
            method: options?.method,
            status: response.status,
            requestHeaders,
            payload: data,
        });
        throw error;
    }

    return data;
}

async function buildRequestHeaders(extraHeaders) {
    const baseHeaders = await resolveRequestHeaders();

    return {
        ...baseHeaders,
        headers: {
            ...(baseHeaders.headers || {}),
            ...(extraHeaders || {}),
        },
    };
}

async function resolveRequestHeaders() {
    const helpers = await collectRequestHeaderHelpers();
    for (const candidate of helpers) {
        const resolved = safeGetRequestHeaders(candidate.helper, candidate.source);
        if (resolved.ok) {
            return resolved;
        }
    }

    return {
        ok: true,
        source: 'fallback_json',
        headers: {
            'Content-Type': 'application/json',
        },
        hasCsrfToken: false,
    };
}

async function collectRequestHeaderHelpers() {
    const candidates = [];
    pushRequestHeaderHelper(candidates, 'global_this', globalThis.getRequestHeaders);
    pushRequestHeaderHelper(candidates, 'window_global', globalThis.window?.getRequestHeaders);
    pushRequestHeaderHelper(candidates, 'st_context', globalThis.window?.SillyTavern?.getContext?.()?.getRequestHeaders);

    requestHeadersHelperPromise ??= loadStRequestHeadersHelper();
    pushRequestHeaderHelper(candidates, 'script_import', await requestHeadersHelperPromise);

    return candidates;
}

function pushRequestHeaderHelper(candidates, source, helper) {
    if (typeof helper !== 'function') {
        return;
    }

    if (candidates.some((entry) => entry.helper === helper)) {
        return;
    }

    candidates.push({ source, helper });
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

function safeGetRequestHeaders(helper, source) {
    try {
        const headers = helper();
        if (headers && typeof headers === 'object') {
            const plainHeaders = headers instanceof Headers
                ? Object.fromEntries(headers.entries())
                : { ...headers };
            if (Object.keys(plainHeaders).length > 0) {
                return {
                    ok: true,
                    source,
                    headers: plainHeaders,
                    hasCsrfToken: typeof plainHeaders['X-CSRF-Token'] === 'string' && plainHeaders['X-CSRF-Token'].trim().length > 0,
                };
            }
        }
    } catch (error) {
        return {
            ok: false,
            source,
            headers: null,
            hasCsrfToken: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }

    return {
        ok: false,
        source,
        headers: null,
        hasCsrfToken: false,
        error: 'Request headers helper returned an empty or invalid result.',
    };
}

function buildRequestFailureDetail({ url, method, status, requestHeaders, payload }) {
    const structuredDetail = typeof payload?.structuredError?.detail === 'string'
        ? payload.structuredError.detail.trim()
        : '';
    const raw = typeof payload?.raw === 'string'
        ? payload.raw.trim()
        : '';
    const summary = [
        `request=${String(method || 'GET').toUpperCase()} ${url}`,
        `status=${status}`,
        `header_source=${requestHeaders?.source || 'unknown'}`,
        `csrf=${requestHeaders?.hasCsrfToken ? 'present' : 'missing'}`,
    ];

    if (structuredDetail) {
        summary.push(`server_detail=${structuredDetail}`);
    } else if (raw) {
        summary.push(`raw=${raw}`);
    }

    return summary.join(' | ');
}

function logRequestFailure({ url, method, status, requestHeaders, payload }) {
    if (status < 400) {
        return;
    }

    console.warn('[retry-mobile:frontend-request]', {
        request: `${String(method || 'GET').toUpperCase()} ${url}`,
        status,
        headerSource: requestHeaders?.source || 'unknown',
        hasCsrfToken: Boolean(requestHeaders?.hasCsrfToken),
        payload,
    });
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

