// st-bridge/reconciler.js
// Single owner of accepted-output apply / fallback reload reconciliation.
// Lifted from the former frontend/src/render/reconciler.js with no
// behavioural change. Public surface is exposed via stPort.reconciler.

import { cloneValue } from '../core/clone.js';
import { applyAcceptedOutput, reloadSessionUi } from './write.js';

export function createChatReconciler({
    applyAcceptedOutputFn = applyAcceptedOutput,
} = {}) {
    let active = false;

    return {
        setActive(nextActive) {
            active = Boolean(nextActive);
            return active;
        },
        isActive() {
            return active;
        },
        queue(renderPayload) {
            return cloneValue(renderPayload);
        },
        async applyStatus(renderPayload) {
            return applyAcceptedOutputFn?.(cloneValue(renderPayload));
        },
        async flushPending(renderPayload) {
            if (!renderPayload) {
                return { ok: false };
            }
            return applyAcceptedOutputFn?.(cloneValue(renderPayload));
        },
        async applyTerminal(renderPayload) {
            return applyAcceptedOutputFn?.(cloneValue(renderPayload));
        },
        async guardedReload(signal) {
            return reloadSessionUi(signal);
        },
        async reconcileAfterRestore(renderPayload) {
            if (!renderPayload) {
                return { ok: false };
            }

            // ST can fire several rapid CHAT_CHANGED events and take a few hundred
            // milliseconds to fully rebuild the in-memory chat array after a reload.
            // Retry with increasing delays so we patch once the chat has settled,
            // rather than after a single short wait or a forced reload.
            const retryDelaysMs = [0, 350, 750, 1400];
            let lastResult = null;
            for (const delayMs of retryDelaysMs) {
                if (delayMs > 0) {
                    await sleep(delayMs);
                }
                const result = await applyAcceptedOutputFn?.(cloneValue(renderPayload));
                lastResult = result;
                if (result?.ok !== false) {
                    return result;
                }
                // recoveryRequired === false means the user switched chat; stop retrying.
                if (result?.recoveryRequired === false) {
                    break;
                }
            }
            return lastResult ?? { ok: false };
        },
    };
}

function sleep(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, Math.max(0, Number(ms) || 0));
    });
}
