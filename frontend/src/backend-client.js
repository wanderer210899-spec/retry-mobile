import {
    cancelBackendJob,
    confirmNativeJob,
    fetchActiveJob,
    fetchJobStatus,
    reportFrontendPresence as postFrontendPresence,
    reportNativeFailure as postNativeFailure,
    startBackendJob,
} from './backend-api.js';
import {
    POLL_INTERVAL_FAST_MS,
    POLL_INTERVAL_SLOW_MS,
    POLL_INTERVAL_STEADY_MS,
} from './constants.js';

export function createBackendPort() {
    const pollControllers = new Map();

    return {
        startJob,
        confirmNative,
        reportNativeFailure,
        reportFrontendPresence,
        pollStatus,
        startPolling,
        stopPolling,
        cancelJob,
        fetchActiveJob,
    };

    async function startJob(payload) {
        return startBackendJob(payload);
    }

    async function confirmNative(jobId, payload) {
        return confirmNativeJob(jobId, payload);
    }

    async function reportNativeFailure(jobId, payload) {
        return postNativeFailure(jobId, payload);
    }

    async function reportFrontendPresence(jobId, payload) {
        return postFrontendPresence(jobId, payload);
    }

    async function pollStatus(jobId) {
        return fetchJobStatus(jobId);
    }

    function startPolling(jobId, onStatus, onError) {
        if (!jobId) {
            return null;
        }

        const token = `${jobId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
        const controller = new AbortController();
        pollControllers.set(token, controller);

        void (async () => {
            const intervalMs = cadenceToMs('fast');
            while (!controller.signal.aborted) {
                if (intervalMs > 0) {
                    await delay(intervalMs, controller.signal);
                }
                if (controller.signal.aborted) {
                    return;
                }

                try {
                    const status = await fetchJobStatus(jobId);
                    if (controller.signal.aborted) {
                        return;
                    }
                    await onStatus?.(status);
                    if (isTerminalStatus(status)) {
                        stopPolling(token);
                        return;
                    }
                } catch (error) {
                    if (controller.signal.aborted) {
                        return;
                    }
                    await onError?.(error);
                    stopPolling(token);
                    return;
                }
            }
        })();

        return token;
    }

    function stopPolling(token) {
        const controller = pollControllers.get(token);
        if (!controller) {
            return false;
        }

        controller.abort();
        pollControllers.delete(token);
        return true;
    }

    async function cancelJob(jobId, payload = {}) {
        await cancelBackendJob(jobId, payload);
        return { ok: true };
    }
}

function isTerminalStatus(status) {
    return Boolean(status)
        && (status.state === 'completed'
            || status.state === 'failed'
            || status.state === 'cancelled');
}

function cadenceToMs(cadence) {
    switch (cadence) {
        case 'slow':
            return POLL_INTERVAL_SLOW_MS;
        case 'steady':
            return POLL_INTERVAL_STEADY_MS;
        default:
            return POLL_INTERVAL_FAST_MS;
    }
}

async function delay(ms, signal) {
    await new Promise((resolve) => {
        const handle = window.setTimeout(resolve, ms);
        signal?.addEventListener('abort', () => {
            window.clearTimeout(handle);
            resolve();
        }, { once: true });
    });
}
