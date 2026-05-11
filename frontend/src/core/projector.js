// core/projector.js
// Single owner of runtime field projection from FSM context snapshots. All
// runtime active-job writes flow through projectRuntime or writeStatusMirror.

import { clearActiveRunBinding, writeActiveRunBinding } from '../job/run-binding.js';
import { RetryState } from '../retry-fsm.js';
import { resolveCaptureSubscriptionChatIdentity } from '../app-recovery.js';

// Maps an FSM context snapshot onto the runtime object.
// Call once per FSM tick (or after any FSM transition).
export function projectRuntime(runtime, fsmContext) {
    const context = fsmContext;
    runtime.controlError = context.state === RetryState.RUNNING
        ? null
        : (context.terminalError || null);

    if (context.jobId) {
        runtime.activeJobId = context.jobId;
    } else if (context.lastTerminalResult?.jobId) {
        runtime.activeJobId = context.lastTerminalResult.jobId;
    } else {
        runtime.activeJobId = null;
    }

    // The runtime mirror caches the live backend status only. Pushing
    // lastTerminalResult.status back into activeJobStatus here would stomp
    // the freshly written poll status with a previous run's terminal snapshot
    // and re-fire its terminal toast on the next render. The terminal snapshot
    // stays addressable through context.lastTerminalResult for UI derivation.
    if (context.state !== RetryState.RUNNING
        && !contextOwnsRuntimeStatus(context, runtime.activeJobStatus)) {
        runtime.activeJobStatus = null;
    }

    syncActiveRunBinding(runtime, context);

    if (context.state !== RetryState.RUNNING) {
        runtime.pendingNativeOutcome = null;
    }
}

// Writes a backend status object directly into the runtime mirror.
// Called from the polling callback after observeBackendStatus accepts a status.
export function writeStatusMirror(runtime, status) {
    runtime.activeJobStatus = status;
    runtime.activeJobId = String(status.jobId || '').trim();
    runtime.activeJobStatusObservedAt = status.updatedAt || new Date().toISOString();
}

// Manages the session-storage active-run binding from FSM context.
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

export function buildActiveJobStatusRenderKey(status) {
    if (!status) {
        return '';
    }

    return JSON.stringify({
        jobId: String(status.jobId || ''),
        runId: String(status.runId || ''),
        revision: Number(status.revision || 0),
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
