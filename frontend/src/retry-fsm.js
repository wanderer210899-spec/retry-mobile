import { createStructuredError, normalizeStructuredError } from './retry-error.js';

export const RetryState = Object.freeze({
    IDLE: 'idle',
    ARMED: 'armed',
    CAPTURING: 'capturing',
    RUNNING: 'running',
});

export function createInitialRetryContext(overrides = {}) {
    const intent = normalizeIntent(overrides.intent);
    return normalizeContextForState({
        state: overrides.state || RetryState.IDLE,
        intent,
        chatIdentity: clonePlain(overrides.chatIdentity) || null,
        capturedRequest: clonePlain(overrides.capturedRequest) || null,
        target: clonePlain(overrides.target) || null,
        runId: stringOrNull(overrides.runId),
        jobId: stringOrNull(overrides.jobId),
        pollingToken: stringOrNull(overrides.pollingToken),
        pendingVisibleRender: clonePlain(overrides.pendingVisibleRender) || null,
        lastTerminalResult: clonePlain(overrides.lastTerminalResult) || null,
        error: clonePlain(overrides.error) || null,
    });
}

export function createRetryFsm({
    intentPort = {},
    stPort = {},
    backendPort = {},
    createRunId = defaultCreateRunId,
    now = defaultNow,
    logger = null,
} = {}) {
    const abortedCaptureRuns = new Map();
    let context = createInitialRetryContext({
        intent: readIntentSnapshot(intentPort, null),
    });

    return {
        getState,
        getContext,
        arm,
        capture,
        jobStarted,
        jobCompleted,
        jobFailed,
        resume,
        userStop,
    };

    function getState() {
        return context.state;
    }

    function getContext() {
        return clonePlain(context);
    }

    function arm(payload = {}) {
        if (!isState(context, RetryState.IDLE)) {
            return illegalTransition('arm', [RetryState.IDLE], payload);
        }

        const baseIntent = readIntentSnapshot(intentPort, context.intent);
        const requestedMode = normalizeIntentMode(payload.intent?.mode ?? baseIntent.mode);
        if (requestedMode === 'off') {
            return illegalTransition('arm', [RetryState.IDLE], {
                ...payload,
                reason: 'intent_mode_off',
            });
        }

        const nextIntent = engageIntent(payload.intent, payload.target);
        const nextTarget = nextIntent.mode === 'single'
            ? resolveSingleTarget(nextIntent, payload.target || context.target)
            : null;

        const nextContext = normalizeContextForState({
            ...context,
            state: RetryState.ARMED,
            intent: nextIntent,
            chatIdentity: clonePlain(payload.chatIdentity) || context.chatIdentity || null,
            capturedRequest: null,
            target: nextTarget,
            runId: createRunId(),
            jobId: null,
            pollingToken: null,
            pendingVisibleRender: null,
            error: null,
        });

        enterArmed(nextContext);
        context = nextContext;
        return getContext();
    }

    function capture(payload = {}) {
        if (!isState(context, RetryState.ARMED)) {
            return illegalTransition('capture', [RetryState.ARMED], payload);
        }

        const capturedRequest = clonePlain(payload.request ?? payload.capturedRequest);
        if (!capturedRequest) {
            return illegalTransition('capture', [RetryState.ARMED], {
                ...payload,
                reason: 'missing_request',
            });
        }

        leaveArmed(context);

        const nextContext = normalizeContextForState({
            ...context,
            state: RetryState.CAPTURING,
            chatIdentity: clonePlain(payload.chatIdentity) || context.chatIdentity || null,
            capturedRequest,
            target: clonePlain(payload.target) || context.target || null,
            error: null,
        });

        context = nextContext;
        enterCapturing(nextContext);
        return getContext();
    }

    function jobStarted(payload = {}) {
        if (!isState(context, RetryState.CAPTURING)) {
            cleanupAbortedCaptureStart(payload);
            return illegalTransition('jobStarted', [RetryState.CAPTURING], payload);
        }

        const jobId = stringOrNull(payload.jobId);
        if (!jobId) {
            return illegalTransition('jobStarted', [RetryState.CAPTURING], {
                ...payload,
                reason: 'missing_job_id',
            });
        }

        leaveCapturing(context);

        const runningContext = normalizeContextForState({
            ...context,
            state: RetryState.RUNNING,
            chatIdentity: clonePlain(payload.chatIdentity) || context.chatIdentity || null,
            capturedRequest: null,
            target: clonePlain(payload.target) || context.target || null,
            runId: stringOrNull(payload.runId) || context.runId || createRunId(),
            jobId,
            pollingToken: null,
            pendingVisibleRender: clonePlain(payload.pendingVisibleRender) || null,
            error: null,
        });

        const entryPatch = enterRunning(runningContext);
        context = normalizeContextForState({
            ...runningContext,
            ...entryPatch,
        });
        return getContext();
    }

    function jobCompleted(payload = {}) {
        if (!isState(context, RetryState.RUNNING)) {
            return illegalTransition('jobCompleted', [RetryState.RUNNING], payload);
        }

        const previous = context;
        leaveRunning(previous);

        const nextIntent = refreshIntent();
        const nextState = shouldRearm(nextIntent, previous.target)
            ? RetryState.ARMED
            : RetryState.IDLE;
        const nextTarget = nextState === RetryState.ARMED && nextIntent.mode === 'single'
            ? resolveSingleTarget(nextIntent, previous.target)
            : null;

        const nextContext = normalizeContextForState({
            ...previous,
            state: nextState,
            intent: nextIntent,
            chatIdentity: clonePlain(payload.chatIdentity) || previous.chatIdentity || null,
            capturedRequest: null,
            target: nextTarget,
            runId: nextState === RetryState.ARMED ? createRunId() : null,
            jobId: null,
            pollingToken: null,
            pendingVisibleRender: null,
            lastTerminalResult: createTerminalResult('completed', payload, previous, null, now),
            error: null,
        });

        if (nextState === RetryState.ARMED) {
            enterArmed(nextContext);
        }

        context = nextContext;
        return getContext();
    }

    function jobFailed(payload = {}) {
        if (!isState(context, RetryState.CAPTURING, RetryState.RUNNING)) {
            return illegalTransition('jobFailed', [RetryState.CAPTURING, RetryState.RUNNING], payload);
        }

        const previous = context;
        if (previous.state === RetryState.CAPTURING) {
            leaveCapturing(previous);
        } else {
            leaveRunning(previous);
        }

        const nextIntent = refreshIntent();
        const nextState = shouldRearm(nextIntent, previous.target)
            ? RetryState.ARMED
            : RetryState.IDLE;
        const normalizedError = normalizeStructuredError(
            payload.error,
            'retry_job_failed',
            'Retry Mobile failed.',
        );
        const nextTarget = nextState === RetryState.ARMED && nextIntent.mode === 'single'
            ? resolveSingleTarget(nextIntent, previous.target)
            : null;

        const nextContext = normalizeContextForState({
            ...previous,
            state: nextState,
            intent: nextIntent,
            chatIdentity: clonePlain(payload.chatIdentity) || previous.chatIdentity || null,
            capturedRequest: null,
            target: nextTarget,
            runId: nextState === RetryState.ARMED ? createRunId() : null,
            jobId: null,
            pollingToken: null,
            pendingVisibleRender: null,
            lastTerminalResult: createTerminalResult('failed', payload, previous, normalizedError, now),
            error: normalizedError,
        });

        if (nextState === RetryState.ARMED) {
            enterArmed(nextContext);
        }

        context = nextContext;
        return getContext();
    }

    function resume(payload = {}) {
        if (!isState(context, RetryState.RUNNING)) {
            return illegalTransition('resume', [RetryState.RUNNING], payload);
        }

        const nextContext = normalizeContextForState({
            ...context,
            chatIdentity: clonePlain(payload.chatIdentity) || context.chatIdentity || null,
            target: clonePlain(payload.target) || context.target || null,
            pendingVisibleRender: payload.pendingVisibleRender === undefined
                ? context.pendingVisibleRender
                : clonePlain(payload.pendingVisibleRender),
            error: null,
        });

        context = nextContext;

        if (context.pendingVisibleRender && payload.isVisible === true) {
            stPort.flushPendingVisibleRender?.(clonePlain(context.pendingVisibleRender));
            context = normalizeContextForState({
                ...context,
                pendingVisibleRender: null,
            });
        }

        if (context.jobId) {
            backendPort.reportFrontendPresence?.(context.jobId, {
                reason: String(payload.reason || 'resume'),
                chatIdentity: clonePlain(context.chatIdentity),
                target: clonePlain(context.target),
            });
        }

        return getContext();
    }

    function userStop(payload = {}) {
        if (!isState(context, RetryState.ARMED, RetryState.CAPTURING, RetryState.RUNNING)) {
            return illegalTransition('userStop', [RetryState.ARMED, RetryState.CAPTURING, RetryState.RUNNING], payload);
        }

        const previous = context;
        if (previous.state === RetryState.ARMED) {
            leaveArmed(previous);
        } else if (previous.state === RetryState.CAPTURING) {
            // `/start` may still resolve after Stop. Track the aborted run so a late
            // `jobStarted()` can cancel the orphaned backend job without reopening state.
            if (previous.runId) {
                abortedCaptureRuns.set(previous.runId, {
                    runId: previous.runId,
                    chatIdentity: clonePlain(previous.chatIdentity),
                    target: clonePlain(previous.target),
                });
            }
            leaveCapturing(previous);
        } else {
            leaveRunning(previous);
            if (previous.jobId) {
                backendPort.cancelJob?.(previous.jobId, {
                    runId: previous.runId,
                    chatIdentity: clonePlain(previous.chatIdentity),
                    target: clonePlain(previous.target),
                });
            }
        }

        const nextIntent = disengageIntent();
        context = normalizeContextForState({
            ...previous,
            state: RetryState.IDLE,
            intent: nextIntent,
            capturedRequest: null,
            target: null,
            runId: null,
            jobId: null,
            pollingToken: null,
            pendingVisibleRender: null,
            lastTerminalResult: createTerminalResult('cancelled', payload, previous, null, now),
            error: null,
        });
        return getContext();
    }

    function enterArmed(nextContext) {
        stPort.subscribeCapture?.({
            runId: nextContext.runId,
            chatIdentity: clonePlain(nextContext.chatIdentity),
            target: clonePlain(nextContext.target),
        });
    }

    function leaveArmed(previous) {
        stPort.unsubscribeCapture?.({
            runId: previous.runId,
            chatIdentity: clonePlain(previous.chatIdentity),
        });
    }

    function enterCapturing(nextContext) {
        backendPort.startJob?.({
            runId: nextContext.runId,
            chatIdentity: clonePlain(nextContext.chatIdentity),
            capturedRequest: clonePlain(nextContext.capturedRequest),
            target: clonePlain(nextContext.target),
            intent: clonePlain(nextContext.intent),
            settings: clonePlain(nextContext.intent.settings),
        });
        stPort.subscribeNativeObserver?.({
            runId: nextContext.runId,
            chatIdentity: clonePlain(nextContext.chatIdentity),
            target: clonePlain(nextContext.target),
        });
    }

    function leaveCapturing(previous) {
        stPort.unsubscribeNativeObserver?.({
            runId: previous.runId,
            chatIdentity: clonePlain(previous.chatIdentity),
            target: clonePlain(previous.target),
        });
    }

    function enterRunning(nextContext) {
        const pollingToken = backendPort.startPolling?.(nextContext.jobId, {
            runId: nextContext.runId,
            chatIdentity: clonePlain(nextContext.chatIdentity),
            target: clonePlain(nextContext.target),
        }) || null;

        backendPort.reportFrontendPresence?.(nextContext.jobId, {
            reason: 'running_entry',
            chatIdentity: clonePlain(nextContext.chatIdentity),
            target: clonePlain(nextContext.target),
        });

        stPort.setGeneratingIndicator?.(clonePlain(resolveTargetChatIdentity(nextContext)));
        return {
            pollingToken: stringOrNull(pollingToken),
        };
    }

    function leaveRunning(previous) {
        if (previous.pollingToken) {
            backendPort.stopPolling?.(previous.pollingToken);
        }
        stPort.clearGeneratingIndicator?.(clonePlain(resolveTargetChatIdentity(previous)));
    }

    function refreshIntent() {
        const nextIntent = readIntentSnapshot(intentPort, context.intent);
        context = normalizeContextForState({
            ...context,
            intent: nextIntent,
        });
        return nextIntent;
    }

    function engageIntent(intentPatch, target) {
        const baseIntent = readIntentSnapshot(intentPort, context.intent);
        const patch = isPlainObject(intentPatch) ? intentPatch : {};
        const nextSingleTarget = (patch.mode || baseIntent.mode) === 'single'
            ? (target ?? baseIntent.singleTarget ?? null)
            : (baseIntent.singleTarget ?? null);

        const mergedIntent = normalizeIntent({
            ...baseIntent,
            ...patch,
            settings: {
                ...(baseIntent.settings || {}),
                ...(isPlainObject(patch.settings) ? patch.settings : {}),
            },
            engaged: true,
            singleTarget: nextSingleTarget,
        });

        writeIntentSnapshot(intentPort, mergedIntent);
        if (mergedIntent.mode === 'single' && target && typeof intentPort.saveSingleTarget === 'function') {
            intentPort.saveSingleTarget(clonePlain(target));
        }

        return readIntentSnapshot(intentPort, mergedIntent);
    }

    function disengageIntent() {
        const baseIntent = readIntentSnapshot(intentPort, context.intent);
        const nextIntent = normalizeIntent({
            ...baseIntent,
            engaged: false,
        });
        writeIntentSnapshot(intentPort, nextIntent);
        return readIntentSnapshot(intentPort, nextIntent);
    }

    function illegalTransition(name, allowedStates, payload) {
        const detail = {
            transition: name,
            state: context.state,
            allowedStates: [...allowedStates],
            payload: clonePlain(payload),
            error: createStructuredError(
                'illegal_transition',
                `Retry Mobile cannot run ${name} while the FSM is ${context.state}.`,
                `Allowed states: ${allowedStates.join(', ')}`,
            ),
        };
        logDeveloperError(logger, detail);
        return getContext();
    }

    function cleanupAbortedCaptureStart(payload) {
        const jobId = stringOrNull(payload.jobId);
        if (!jobId) {
            return;
        }

        const abortedRunId = stringOrNull(payload.runId);
        if (!abortedRunId || !abortedCaptureRuns.has(abortedRunId)) {
            return;
        }

        const aborted = abortedCaptureRuns.get(abortedRunId);
        abortedCaptureRuns.delete(abortedRunId);
        backendPort.cancelJob?.(jobId, {
            runId: aborted.runId,
            chatIdentity: clonePlain(aborted.chatIdentity),
            target: clonePlain(aborted.target),
            reason: 'capture_aborted_before_job_started',
        });
    }
}

function normalizeContextForState(nextContext) {
    const normalized = {
        ...nextContext,
        intent: normalizeIntent(nextContext.intent),
        chatIdentity: clonePlain(nextContext.chatIdentity) || null,
        capturedRequest: clonePlain(nextContext.capturedRequest) || null,
        target: clonePlain(nextContext.target) || null,
        runId: stringOrNull(nextContext.runId),
        jobId: stringOrNull(nextContext.jobId),
        pollingToken: stringOrNull(nextContext.pollingToken),
        pendingVisibleRender: clonePlain(nextContext.pendingVisibleRender) || null,
        lastTerminalResult: clonePlain(nextContext.lastTerminalResult) || null,
        error: clonePlain(nextContext.error) || null,
    };

    switch (normalized.state) {
        case RetryState.IDLE:
            return {
                ...normalized,
                capturedRequest: null,
                target: null,
                runId: null,
                jobId: null,
                pollingToken: null,
                pendingVisibleRender: null,
            };
        case RetryState.ARMED:
            return {
                ...normalized,
                capturedRequest: null,
                jobId: null,
                pollingToken: null,
                pendingVisibleRender: null,
            };
        case RetryState.CAPTURING:
            return {
                ...normalized,
                jobId: null,
                pollingToken: null,
                pendingVisibleRender: null,
            };
        case RetryState.RUNNING:
        default:
            return {
                ...normalized,
                capturedRequest: null,
            };
    }
}

function normalizeIntent(intent = {}) {
    const next = isPlainObject(intent) ? intent : {};
    return {
        mode: normalizeIntentMode(next.mode),
        engaged: Boolean(next.engaged),
        singleTarget: clonePlain(next.singleTarget) || null,
        settings: isPlainObject(next.settings) ? { ...next.settings } : {},
    };
}

function normalizeIntentMode(mode) {
    if (mode === 'single' || mode === 'toggle') {
        return mode;
    }
    return 'off';
}

function readIntentSnapshot(intentPort, fallback) {
    const fallbackIntent = normalizeIntent(fallback);
    const rawIntent = typeof intentPort.readIntent === 'function'
        ? intentPort.readIntent()
        : fallbackIntent;
    const normalized = normalizeIntent({
        ...fallbackIntent,
        ...(isPlainObject(rawIntent) ? rawIntent : {}),
        settings: {
            ...(fallbackIntent.settings || {}),
            ...(isPlainObject(rawIntent?.settings) ? rawIntent.settings : {}),
        },
    });

    const singleTarget = typeof intentPort.getSingleTarget === 'function'
        ? intentPort.getSingleTarget()
        : normalized.singleTarget;

    return normalizeIntent({
        ...normalized,
        singleTarget: singleTarget ?? normalized.singleTarget ?? null,
    });
}

function writeIntentSnapshot(intentPort, nextIntent) {
    if (typeof intentPort.writeIntent === 'function') {
        intentPort.writeIntent(clonePlain(nextIntent));
    }
}

function resolveSingleTarget(intent, fallbackTarget) {
    return clonePlain(intent.singleTarget) || clonePlain(fallbackTarget) || null;
}

function shouldRearm(intent, completedTarget) {
    if (!intent.engaged) {
        return false;
    }

    if (intent.mode === 'toggle') {
        return true;
    }

    if (intent.mode !== 'single') {
        return false;
    }

    const savedTarget = resolveSingleTarget(intent, completedTarget);
    if (!savedTarget || !completedTarget) {
        return false;
    }

    return sameMessageTarget(savedTarget, completedTarget);
}

function sameMessageTarget(left, right) {
    const leftKey = buildTargetKey(left);
    const rightKey = buildTargetKey(right);
    return Boolean(leftKey) && leftKey === rightKey;
}

function buildTargetKey(target) {
    if (!isPlainObject(target)) {
        return null;
    }

    const anchorId = stringOrNull(
        target.assistantAnchorId
        || target.retryMobileAssistantAnchorId
        || target.assistantMessageId
        || target.messageId,
    );
    if (anchorId) {
        return `anchor:${anchorId}`;
    }

    const chatKey = buildChatIdentityKey(target.chatIdentity || null);
    const assistantIndex = numberOrNull(
        target.assistantMessageIndex
        ?? target.messageIndex
        ?? target.index,
    );
    if (chatKey && assistantIndex != null) {
        return `${chatKey}#${assistantIndex}`;
    }

    return null;
}

function buildChatIdentityKey(chatIdentity) {
    if (!isPlainObject(chatIdentity)) {
        return null;
    }

    const kind = stringOrNull(chatIdentity.kind) || 'chat';
    const chatId = stringOrNull(chatIdentity.chatId);
    const groupId = stringOrNull(chatIdentity.groupId) || '';
    if (!chatId && !groupId) {
        return null;
    }

    return `${kind}:${chatId || ''}:${groupId}`;
}

function resolveTargetChatIdentity(context) {
    if (isPlainObject(context?.target?.chatIdentity)) {
        return context.target.chatIdentity;
    }
    return context?.chatIdentity || null;
}

function createTerminalResult(outcome, payload, previous, error, now) {
    return {
        outcome: String(outcome || 'completed'),
        at: typeof now === 'function' ? now() : defaultNow(),
        runId: previous?.runId || null,
        jobId: stringOrNull(payload?.jobId) || previous?.jobId || null,
        status: clonePlain(payload?.status) || null,
        reason: stringOrNull(payload?.reason) || '',
        error: clonePlain(error) || null,
    };
}

function logDeveloperError(logger, detail) {
    if (!logger) {
        return;
    }

    if (typeof logger === 'function') {
        logger(detail);
        return;
    }

    logger.error?.(detail);
}

function clonePlain(value) {
    if (value == null) {
        return value ?? null;
    }

    if (typeof globalThis.structuredClone === 'function') {
        return globalThis.structuredClone(value);
    }

    return JSON.parse(JSON.stringify(value));
}

function isState(context, ...states) {
    return Boolean(context) && states.includes(context.state);
}

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringOrNull(value) {
    if (typeof value !== 'string') {
        return null;
    }

    const trimmed = value.trim();
    return trimmed ? trimmed : null;
}

function numberOrNull(value) {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }
    return null;
}

function defaultCreateRunId() {
    if (globalThis.crypto?.randomUUID) {
        return globalThis.crypto.randomUUID();
    }

    return `rm-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function defaultNow() {
    return new Date().toISOString();
}
