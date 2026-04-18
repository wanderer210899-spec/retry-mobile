import { createStructuredError } from './retry-error.js';
import { BACKEND_PLUGIN_ID } from './constants.js';

const BASE_URL = `/api/plugins/${BACKEND_PLUGIN_ID}`;

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

export async function fetchActiveJob(identity) {
    const query = new URLSearchParams();
    if (identity?.chatId) {
        query.set('chatId', identity.chatId);
    }
    if (identity?.groupId) {
        query.set('groupId', identity.groupId);
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

async function requestJson(url, options) {
    const response = await fetch(url, {
        credentials: 'same-origin',
        headers: {
            'Content-Type': 'application/json',
        },
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

