import { RENDER_MESSAGE_RETRY_WAIT_MS } from '../constants.js';
import { applyAcceptedOutput, reloadSessionUi } from './st-operations.js';

export function createChatReconciler({
    applyAcceptedOutputFn = applyAcceptedOutput,
    reloadSessionUiFn = reloadSessionUi,
    waitMs = RENDER_MESSAGE_RETRY_WAIT_MS,
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
            const result = await applyAcceptedOutputFn?.(cloneValue(renderPayload));
            if (result?.ok === false) {
                await reloadSessionUiFn?.();
            }
            return result;
        },
        async reconcileAfterRestore(renderPayload) {
            if (!renderPayload) {
                return { ok: false };
            }

            const first = await applyAcceptedOutputFn?.(cloneValue(renderPayload));
            if (first?.ok !== false) {
                return first;
            }

            await sleep(waitMs);
            const second = await applyAcceptedOutputFn?.(cloneValue(renderPayload));
            if (second?.ok === false) {
                await reloadSessionUiFn?.();
            }
            return second;
        },
    };
}

function cloneValue(value) {
    if (value == null) {
        return value ?? null;
    }

    if (typeof globalThis.structuredClone === 'function') {
        return globalThis.structuredClone(value);
    }

    return JSON.parse(JSON.stringify(value));
}

function sleep(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, Math.max(0, Number(ms) || 0));
    });
}
