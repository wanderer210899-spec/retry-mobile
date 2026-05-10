import {
    cancelBackendJob,
    confirmNativeJob,
    fetchActiveJob,
    fetchLatestJob as fetchLatestJobApi,
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
        stopAllExcept,
        cancelJob,
        fetchActiveJob,
        fetchLatestJob,
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

    async function fetchLatestJob(identity) {
        return fetchLatestJobApi(identity);
    }

    function startPolling(jobId, onStatus, onError, selectCadence = null) {
        if (!jobId) {
            return null;
        }

        const token = `${jobId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
        const controller = new AbortController();
        pollControllers.set(token, controller);

        void (async () => {
            let consecutiveFailures = 0;
            while (!controller.signal.aborted) {
                const intervalMs = cadenceToMs(resolveCadence(selectCadence));
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
                    consecutiveFailures = 0;
                    await onStatus?.(status);
                    const terminalStates = ['completed', 'failed', 'cancelled'];
                    if (status && terminalStates.includes(status.state)) {
                        stopPolling(token);
                        return;
                    }
                } catch (error) {
                    if (controller.signal.aborted) {
                        return;
                    }
                    consecutiveFailures += 1;
                    await onError?.(error);
                    // Resilience requirement: the backend job must keep running even
                    // if the frontend temporarily loses polling (mobile suspend/offline).
                    // Keep polling with exponential backoff rather than failing closed.
                    await delay(computeFailureBackoffMs(consecutiveFailures), controller.signal);
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

    function stopAllExcept(activeToken) {
        for (const [token, controller] of pollControllers) {
            if (token !== activeToken) {
                controller.abort();
                pollControllers.delete(token);
            }
        }
    }

    async function cancelJob(jobId, payload = {}) {
        await cancelBackendJob(jobId, payload);
        return { ok: true };
    }
}

function computeFailureBackoffMs(consecutiveFailures) {
    const failures = Math.max(1, Number(consecutiveFailures) || 1);
    // 1s, 2s, 4s, 8s, 16s, 30s...
    return Math.min(30_000, 1_000 * (2 ** Math.min(4, failures - 1)));
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

function resolveCadence(selectCadence) {
    try {
        return String(selectCadence?.() || 'fast');
    } catch {
        return 'fast';
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
