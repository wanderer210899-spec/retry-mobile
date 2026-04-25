import { clearActiveRunBinding, writeActiveRunBinding } from './job/run-binding.js';
import { RetryState } from './retry-fsm.js';
import { resolveCaptureSubscriptionChatIdentity } from './app-recovery.js';

export function syncRuntimeFromFsm(runtime, fsm) {
    const context = fsm.getContext();
    const terminalStatus = context.lastTerminalResult?.status || null;
    runtime.controlError = context.state === RetryState.RUNNING
        ? null
        : (context.terminalError || null);

    if (context.jobId) {
        runtime.activeJobId = context.jobId;
    } else if (context.lastTerminalResult?.jobId) {
        runtime.activeJobId = context.lastTerminalResult.jobId;
    }

    if (terminalStatus) {
        runtime.activeJobStatus = terminalStatus;
    }

    syncActiveRunBinding(runtime, context);

    if (context.state !== RetryState.RUNNING) {
        runtime.pendingNativeOutcome = null;
    }
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
