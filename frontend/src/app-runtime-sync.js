import { clearActiveRunBinding, writeActiveRunBinding } from './job/run-binding.js';
import { RetryState } from './retry-fsm.js';
import { resolveCaptureSubscriptionChatIdentity } from './app-recovery.js';

export function syncRuntimeFromFsm(runtime, fsm) {
    const context = fsm.getContext();
    runtime.controlError = context.state === RetryState.RUNNING
        ? null
        : (context.terminalError || null);

    if (context.jobId) {
        runtime.activeJobId = context.jobId;
    } else if (context.lastTerminalResult?.jobId) {
        runtime.activeJobId = context.lastTerminalResult.jobId;
    }

    // The runtime mirror caches the live backend status only. Pushing
    // `lastTerminalResult.status` back into `activeJobStatus` here would stomp
    // the freshly written start/poll status with a previous run's terminal
    // snapshot and re-fire its terminal toast on the next render. The terminal
    // snapshot stays addressable through `context.lastTerminalResult` for UI
    // derivation; it must not be confused with a live status.
    if (context.state !== RetryState.RUNNING
        && !contextOwnsRuntimeStatus(context, runtime.activeJobStatus)) {
        runtime.activeJobStatus = null;
    }

    syncActiveRunBinding(runtime, context);

    if (context.state !== RetryState.RUNNING) {
        runtime.pendingNativeOutcome = null;
    }
}

export function updateRuntimeActiveJob(runtime, status, fallbackJobId = '') {
    if (status) {
        const statusChanged = buildActiveJobStatusRenderKey(runtime.activeJobStatus)
            !== buildActiveJobStatusRenderKey(status);
        runtime.activeJobStatus = status;
        runtime.activeJobId = status.jobId || fallbackJobId || runtime.activeJobId || null;
        runtime.activeJobStatusObservedAt = status.updatedAt || new Date().toISOString();
        return statusChanged;
    }

    if (fallbackJobId) {
        runtime.activeJobId = fallbackJobId;
    }
    return false;
}

function contextOwnsRuntimeStatus(context, runtimeStatus) {
    if (!runtimeStatus) {
        return false;
    }
    const runtimeJobId = String(runtimeStatus.jobId || '').trim();
    if (!runtimeJobId) {
        return false;
    }
    const terminalJobId = String(context.lastTerminalResult?.jobId || '').trim();
    return Boolean(terminalJobId) && runtimeJobId === terminalJobId;
}

export function syncActiveRunBinding(runtime, context, {
    resolveBindingChatIdentity = resolveCaptureSubscriptionChatIdentity,
    writeBinding = writeActiveRunBinding,
    clearBinding = clearActiveRunBinding,
    now = () => new Date().toISOString(),
} = {}) {
    const bindingChatIdentity = resolveBindingChatIdentity(context);
    if (context.state === RetryState.RUNNING
        && context.jobId
        && context.runId
        && bindingChatIdentity
        && runtime.sessionId) {
        const nextBinding = {
            runId: context.runId,
            jobId: context.jobId,
            sessionId: runtime.sessionId,
            chatIdentity: cloneValue(bindingChatIdentity),
            lastKnownTargetMessageVersion: Number(runtime.activeJobStatus?.targetMessageVersion || 0),
            lastKnownState: String(runtime.activeJobStatus?.state || context.state || 'unknown'),
            updatedAt: runtime.activeJobStatus?.updatedAt || now(),
        };
        if (!hasMaterialBindingChange(runtime.activeRunBinding, nextBinding)) {
            return runtime.activeRunBinding;
        }

        runtime.activeRunBinding = writeBinding(nextBinding);
        return runtime.activeRunBinding;
    }

    const staleChatIdentity = runtime.activeRunBinding?.chatIdentity || bindingChatIdentity || null;
    if (staleChatIdentity) {
        clearBinding(staleChatIdentity);
    }
    runtime.activeRunBinding = null;
    return null;
}

function hasMaterialBindingChange(previous, nextBinding) {
    if (!previous) {
        return true;
    }

    return String(previous.runId || '') !== String(nextBinding.runId || '')
        || String(previous.jobId || '') !== String(nextBinding.jobId || '')
        || String(previous.sessionId || '') !== String(nextBinding.sessionId || '')
        || !sameBindingChatIdentity(previous.chatIdentity, nextBinding.chatIdentity)
        || Number(previous.lastKnownTargetMessageVersion || 0) !== Number(nextBinding.lastKnownTargetMessageVersion || 0);
}

function sameBindingChatIdentity(left, right) {
    return String(left?.kind || '') === String(right?.kind || '')
        && String(left?.chatId || '') === String(right?.chatId || '')
        && String(left?.groupId || '') === String(right?.groupId || '');
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

function buildActiveJobStatusRenderKey(status) {
    if (!status) {
        return '';
    }

    return JSON.stringify({
        jobId: String(status.jobId || ''),
        runId: String(status.runId || ''),
        state: String(status.state || ''),
        acceptedCount: Number(status.acceptedCount || 0),
        attemptCount: Number(status.attemptCount || 0),
        targetMessageVersion: Number(status.targetMessageVersion || 0),
        targetMessageIndex: Number(status.targetMessageIndex ?? -1),
        structuredError: status.structuredError
            ? {
                code: String(status.structuredError.code || ''),
                message: String(status.structuredError.message || ''),
                detail: String(status.structuredError.detail || ''),
            }
            : null,
    });
}
