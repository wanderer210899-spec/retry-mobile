// st-bridge/reconciler.js
// Single owner of accepted-output apply / fallback reload reconciliation.

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
        // Single entry point for all apply paths (status, terminal, flush).
        // Returns {ok} result from applyAcceptedOutput; null payload is a no-op.
        async apply(renderPayload) {
            if (!renderPayload) {
                return { ok: false };
            }
            return applyAcceptedOutputFn?.(cloneValue(renderPayload));
        },
        async guardedReload(signal) {
            return reloadSessionUi(signal);
        },
    };
}
