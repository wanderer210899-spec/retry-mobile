import { createStructuredError, normalizeStructuredError } from './retry-error.js';

export const RetryState = Object.freeze({
    IDLE: 'idle',
    ARMED: 'armed',
    CAPTURING: 'capturing',
    RUNNING: 'running',
});

export function resolvePollingCadence(context, isVisible) {
    if (String(context?.state || '') !== RetryState.RUNNING) {
        return 'fast';
    }

    const lastKnownTargetMessageVersion = numberOrNull(context?.lastKnownTargetMessageVersion) || 0;
    const lastAppliedVersion = numberOrNull(context?.lastAppliedVersion) || 0;
    if (lastKnownTargetMessageVersion === 0 || lastAppliedVersion < lastKnownTargetMessageVersion) {
        return 'fast';
    }

    if (isVisible === false && !context?.pendingVisibleRender) {
        return 'slow';
    }

    return 'steady';
}

export function createInitialRetryContext(overrides = {}) {
    const intent = normalizeIntent(overrides.intent);
    return createContextForState({
        state: overrides.state || RetryState.IDLE,
        intent,
        chatIdentity: clonePlain(overrides.chatIdentity) || null,
        capturedRequest: clonePlain(overrides.capturedRequest) || null,
        captureFingerprint: clonePlain(overrides.captureFingerprint) || null,
        target: clonePlain(overrides.target) || null,
        runId: stringOrNull(overrides.runId),
        jobId: stringOrNull(overrides.jobId),
        pollingToken: stringOrNull(overrides.pollingToken),
        lastKnownTargetMessageVersion: numberOrNull(overrides.lastKnownTargetMessageVersion) || 0,
        lastAppliedVersion: numberOrNull(overrides.lastAppliedVersion) || 0,
        pendingVisibleRender: clonePlain(overrides.pendingVisibleRender) || null,
        lastTerminalResult: clonePlain(overrides.lastTerminalResult) || null,
        runError: clonePlain(overrides.runError) || null,
        terminalError: clonePlain(overrides.terminalError) || null,
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
        getToastScope,
        setToastScope,
        arm,
        capture,
        jobStarted,
        jobCompleted,
        jobFailed,
        restoreRunning,
        resume,
        userStop,
    };

    function getState() {
        return context.state;
    }

    function getContext() {
        return clonePlain(context);
    }

    function getToastScope() {
        return clonePlain(context.toastScope) || null;
    }

    function setToastScope(nextToastScope) {
        context = createContextForState({
            ...context,
            toastScope: normalizeToastScope(nextToastScope, context.jobId),
        });
        return getContext();
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

        const nextContext = createContextForState({
            ...context,
            state: RetryState.ARMED,
            intent: nextIntent,
            chatIdentity: clonePlain(payload.chatIdentity) || context.chatIdentity || null,
            capturedRequest: null,
            captureFingerprint: null,
            target: nextTarget,
            runId: createRunId(),
            jobId: null,
            pollingToken: null,
            lastAppliedVersion: 0,
            pendingVisibleRender: null,
            // Manual arm starts a fresh user-facing run. The previous terminal
            // result must not bleed into the new armed phase via the toast or
            // stats projection — it is "history" once Start is pressed.
            lastTerminalResult: null,
            toastScope: null,
            terminalError: null,
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

        const nextContext = createContextForState({
            ...context,
            state: RetryState.CAPTURING,
            chatIdentity: clonePlain(payload.chatIdentity) || context.chatIdentity || null,
            capturedRequest,
            captureFingerprint: clonePlain(payload.fingerprint ?? payload.captureFingerprint) || null,
            target: clonePlain(payload.target) || context.target || null,
            terminalError: null,
        });

        context = nextContext;
        enterCapturing(nextContext);
        return getContext();
    }

    function jobStarted(payload = {}) {
        if (!isState(context, RetryState.CAPTURING)) {
            if (cleanupAbortedCaptureStart(payload)) {
                return getContext();
            }
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

        const runningContext = {
            ...context,
            state: RetryState.RUNNING,
            chatIdentity: clonePlain(payload.chatIdentity) || context.chatIdentity || null,
            capturedRequest: null,
            captureFingerprint: clonePlain(context.captureFingerprint) || null,
            target: clonePlain(payload.target) || context.target || null,
            runId: stringOrNull(payload.runId) || context.runId || createRunId(),
            jobId,
            pollingToken: null,
            lastKnownTargetMessageVersion: 0,
            lastAppliedVersion: 0,
            pendingVisibleRender: clonePlain(payload.pendingVisibleRender) || null,
            // A new RUNNING phase must never inherit the previous job's terminal
            // snapshot. If we kept it, `deriveUiState` (which falls back to
            // `lastTerminalResult.status` when `activeJobStatus` is missing) and
            // any future `syncRuntime` mirror would re-fire the prior terminal
            // toast against this run's freshly reset toast scope — exactly the
            // "Generating native… 2/2 turn completed" race observed on first
            // capture after a completed retry.
            lastTerminalResult: null,
            runError: null,
            terminalError: null,
        };

        const entryPatch = enterRunning(runningContext);
        context = createContextForState({
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

        const nextContext = createTerminalContext({
            ...previous,
            state: nextState,
            intent: nextIntent,
            chatIdentity: clonePlain(payload.chatIdentity) || previous.chatIdentity || null,
            capturedRequest: null,
            captureFingerprint: null,
            target: nextTarget,
            runId: nextState === RetryState.ARMED ? createRunId() : null,
            jobId: null,
            pollingToken: null,
            lastKnownTargetMessageVersion: 0,
            lastAppliedVersion: 0,
            pendingVisibleRender: null,
            runError: null,
            lastTerminalResult: createTerminalResult('completed', payload, previous, null, now),
            terminalError: null,
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

        const nextContext = createTerminalContext({
            ...previous,
            state: nextState,
            intent: nextIntent,
            chatIdentity: clonePlain(payload.chatIdentity) || previous.chatIdentity || null,
            capturedRequest: null,
            captureFingerprint: null,
            target: nextTarget,
            runId: nextState === RetryState.ARMED ? createRunId() : null,
            jobId: null,
            pollingToken: null,
            lastKnownTargetMessageVersion: 0,
            lastAppliedVersion: 0,
            pendingVisibleRender: null,
            runError: null,
            lastTerminalResult: createTerminalResult('failed', payload, previous, normalizedError, now),
            // On auto-rearm (toggle/single mode pulls us back to ARMED) the
            // failure has already been narrated through the terminal toast and
            // is preserved on `lastTerminalResult.error` for diagnostics. Carry
            // it over as a panel `terminalError` only when the FSM lands in
            // IDLE (no auto-rearm) so the user knows why the run ended; ARMED
            // is a fresh "ready for next request" state and must not surface a
            // leftover error box.
            terminalError: nextState === RetryState.ARMED ? null : normalizedError,
        });

        if (nextState === RetryState.ARMED) {
            enterArmed(nextContext);
        }

        context = nextContext;
        return getContext();
    }

    function restoreRunning(payload = {}) {
        if (!isState(context, RetryState.IDLE, RetryState.ARMED, RetryState.CAPTURING)) {
            return illegalTransition('restoreRunning', [RetryState.IDLE, RetryState.ARMED, RetryState.CAPTURING], payload);
        }

        const previous = context;
        if (previous.state === RetryState.ARMED) {
            leaveArmed(previous);
        } else if (previous.state === RetryState.CAPTURING) {
            leaveCapturing(previous);
        }

        const status = clonePlain(payload.status) || null;
        const jobId = stringOrNull(payload.jobId) || stringOrNull(status?.jobId);
        if (!jobId) {
            return illegalTransition('restoreRunning', [RetryState.IDLE, RetryState.ARMED, RetryState.CAPTURING], {
                ...payload,
                reason: 'missing_job_id',
            });
        }

        const runningContext = {
            ...previous,
            state: RetryState.RUNNING,
            intent: readIntentSnapshot(intentPort, previous.intent),
            chatIdentity: clonePlain(payload.chatIdentity)
                || clonePlain(status?.chatIdentity)
                || previous.chatIdentity
                || null,
            capturedRequest: null,
            captureFingerprint: null,
            target: clonePlain(payload.target) || clonePlain(previous.target) || null,
            runId: stringOrNull(payload.runId) || stringOrNull(status?.runId) || previous.runId || createRunId(),
            jobId,
            pollingToken: null,
            lastKnownTargetMessageVersion: numberOrNull(payload.lastKnownTargetMessageVersion) || numberOrNull(status?.targetMessageVersion) || 0,
            lastAppliedVersion: 0,
            pendingVisibleRender: clonePlain(payload.pendingVisibleRender) || null,
            lastTerminalResult: null,
            runError: null,
            terminalError: null,
        };

        const entryPatch = enterRunning(runningContext);
        context = createContextForState({
            ...runningContext,
            ...entryPatch,
        });
        return getContext();
    }

    function resume(payload = {}) {
        if (!isState(context, RetryState.RUNNING)) {
            return illegalTransition('resume', [RetryState.RUNNING], payload);
        }

        const nextContext = createContextForState({
            ...context,
            chatIdentity: clonePlain(payload.chatIdentity) || context.chatIdentity || null,
            target: clonePlain(payload.target) || context.target || null,
            pendingVisibleRender: payload.pendingVisibleRender === undefined
                ? context.pendingVisibleRender
                : clonePlain(payload.pendingVisibleRender),
            runError: null,
        });

        context = nextContext;

        if (context.pendingVisibleRender && payload.isVisible === true) {
            const pendingRender = clonePlain(context.pendingVisibleRender);
            const pendingVersion = numberOrNull(pendingRender?.status?.targetMessageVersion) || 0;
            Promise.resolve(stPort.flushPendingVisibleRender?.(pendingRender))
                .then(async (result) => {
                    if (!isState(context, RetryState.RUNNING)) {
                        return;
                    }
                    if (result?.ok === false) {
                        try {
                            await stPort.guardedReload?.();
                        } catch {}
                        context = createContextForState({
                            ...context,
                            pendingVisibleRender: null,
                        });
                        return;
                    }
                    context = createContextForState({
                        ...context,
                        lastAppliedVersion: Math.max(Number(context.lastAppliedVersion || 0), pendingVersion),
                        pendingVisibleRender: null,
                    });
                    if (String(pendingRender?.status?.state || '').trim() === 'completed') {
                        // Never trust a queued "completed" snapshot blindly after a hidden-tab window.
                        // Re-check backend truth; otherwise a cached/stale terminal snapshot could
                        // incorrectly transition the frontend to done while the backend keeps running.
                        try {
                            const fresh = await backendPort.pollStatus?.(context.jobId);
                            if (fresh?.state === 'completed') {
                                jobCompleted({ status: fresh });
                            }
                        } catch {
                            // If we cannot re-check right now, stay running and let polling resolve.
                        }
                    }
                })
                .catch(async () => {
                    if (!isState(context, RetryState.RUNNING)) {
                        return;
                    }
                    try {
                        await stPort.guardedReload?.();
                    } catch {}
                    if (String(pendingRender?.status?.state || '').trim() === 'completed' && isState(context, RetryState.RUNNING)) {
                        try {
                            const fresh = await backendPort.pollStatus?.(context.jobId);
                            if (fresh?.state === 'completed') {
                                jobCompleted({ status: fresh });
                            }
                        } catch {
                            // Defer to the ongoing polling loop.
                        }
                    }
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
                if (abortedCaptureRuns.size > 20) {
                    const oldest = abortedCaptureRuns.keys().next().value;
                    abortedCaptureRuns.delete(oldest);
                }
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
        context = createTerminalContext({
            ...previous,
            state: RetryState.IDLE,
            intent: nextIntent,
            capturedRequest: null,
            captureFingerprint: null,
            target: null,
            runId: null,
            jobId: null,
            pollingToken: null,
            lastKnownTargetMessageVersion: 0,
            lastAppliedVersion: 0,
            pendingVisibleRender: null,
            runError: null,
            lastTerminalResult: createTerminalResult('cancelled', payload, previous, null, now),
            terminalError: null,
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
        const nativeGraceSeconds = numberOrNull(nextContext.intent?.settings?.nativeGraceSeconds);
        const startPayload = {
            runId: nextContext.runId,
            chatIdentity: clonePlain(nextContext.chatIdentity),
            capturedRequest: clonePlain(nextContext.capturedRequest),
            target: clonePlain(nextContext.target),
            intent: clonePlain(nextContext.intent),
            runConfig: clonePlain(nextContext.intent.settings),
            settings: clonePlain(nextContext.intent.settings),
            ...(nativeGraceSeconds != null ? { nativeGraceSeconds } : {}),
            ...(nextContext.captureFingerprint ? {
                targetFingerprint: clonePlain(nextContext.captureFingerprint),
            } : {}),
        };
        backendPort.startJob?.(startPayload);

    }

    function leaveCapturing() {}

    function enterRunning(nextContext) {
        const nativeGraceSeconds = numberOrNull(nextContext.intent?.settings?.nativeGraceSeconds);
        if (nextContext.captureFingerprint) {
            stPort.subscribeNativeObserver?.({
                runId: nextContext.runId,
                chatIdentity: clonePlain(nextContext.chatIdentity),
                target: clonePlain(nextContext.target),
                ...(nativeGraceSeconds != null ? { nativeGraceSeconds } : {}),
                fingerprint: clonePlain(nextContext.captureFingerprint),
            });
        }

        const pollingToken = backendPort.startPolling?.(
            nextContext.jobId,
            (status) => handlePollingStatus(status),
            (error) => handlePollingError(error),
            () => resolvePollingCadence(context, stPort.isVisible?.()),
        ) || null;

        backendPort.reportFrontendPresence?.(nextContext.jobId, {
            reason: 'running_entry',
            chatIdentity: clonePlain(nextContext.chatIdentity),
            target: clonePlain(nextContext.target),
        });

        stPort.enableInteractionGuard?.();
        stPort.setGeneratingIndicator?.(clonePlain(resolveTargetChatIdentity(nextContext)));
        return {
            pollingToken: stringOrNull(pollingToken),
            runError: null,
            terminalError: null,
            toastScope: normalizeToastScope(null, nextContext.jobId),
        };
    }

    function leaveRunning(previous) {
        if (previous.pollingToken) {
            backendPort.stopPolling?.(previous.pollingToken);
        }
        stPort.disableInteractionGuard?.();
        stPort.unsubscribeNativeObserver?.({
            runId: previous.runId,
            chatIdentity: clonePlain(previous.chatIdentity),
            target: clonePlain(previous.target),
        });
        stPort.clearGeneratingIndicator?.(clonePlain(resolveTargetChatIdentity(previous)));
    }

    function refreshIntent() {
        const nextIntent = readIntentSnapshot(intentPort, context.intent);
        context = createContextForState({
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
            return false;
        }

        const abortedRunId = stringOrNull(payload.runId);
        if (!abortedRunId || !abortedCaptureRuns.has(abortedRunId)) {
            return false;
        }

        const aborted = abortedCaptureRuns.get(abortedRunId);
        abortedCaptureRuns.delete(abortedRunId);
        backendPort.cancelJob?.(jobId, {
            runId: aborted.runId,
            chatIdentity: clonePlain(aborted.chatIdentity),
            target: clonePlain(aborted.target),
            reason: 'capture_aborted_before_job_started',
        });
        return true;
    }

    async function handlePollingStatus(status) {
        if (!isState(context, RetryState.RUNNING)) {
            return;
        }

        const statusState = stringOrNull(status?.state);
        if (!statusState) {
            return;
        }

        if (statusState === 'completed') {
            await completeAfterFinalAcceptedOutput(status);
            return;
        }

        if (statusState === 'failed' || statusState === 'cancelled') {
            const fallbackMessage = statusState === 'cancelled'
                ? 'Retry Mobile backend job was cancelled.'
                : 'Retry Mobile backend job failed.';
            jobFailed({
                status,
                error: normalizeStructuredError(
                    status?.structuredError || status?.error,
                    statusState === 'cancelled' ? 'retry_job_cancelled' : 'retry_job_failed',
                    fallbackMessage,
                ),
            });
            return;
        }

        if (statusState !== 'running') {
            return;
        }

        const nextVersion = numberOrNull(status?.targetMessageVersion) || 0;
        context = createContextForState({
            ...context,
            lastKnownTargetMessageVersion: Math.max(Number(context.lastKnownTargetMessageVersion || 0), nextVersion),
            runError: null,
        });
        if (nextVersion <= Number(context.lastAppliedVersion || 0)) {
            return;
        }

        const renderPayload = {
            kind: 'accepted_output',
            chatIdentity: clonePlain(context.chatIdentity),
            status: clonePlain(status),
        };
        if (stPort.isVisible?.() === false) {
            const queued = stPort.queueVisibleRender?.(renderPayload) || renderPayload;
            context = createContextForState({
                ...context,
                pendingVisibleRender: clonePlain(queued),
                runError: null,
            });
            return;
        }

        Promise.resolve(stPort.applyAcceptedOutput?.(renderPayload))
            .then((result) => {
                if (!isState(context, RetryState.RUNNING)) {
                    return;
                }
                if (result?.ok === false) {
                    handleVisibleApplyFailure(result?.error);
                    return;
                }
                context = createContextForState({
                    ...context,
                    lastKnownTargetMessageVersion: Math.max(Number(context.lastKnownTargetMessageVersion || 0), nextVersion),
                    lastAppliedVersion: Math.max(Number(context.lastAppliedVersion || 0), nextVersion),
                    pendingVisibleRender: null,
                    runError: null,
                });
            })
            .catch((error) => {
                handleVisibleApplyFailure(error);
            });
    }

    async function completeAfterFinalAcceptedOutput(status) {
        const nextVersion = numberOrNull(status?.targetMessageVersion) || 0;
        if (nextVersion <= Number(context.lastAppliedVersion || 0)) {
            jobCompleted({ status });
            return;
        }

        const renderPayload = {
            kind: 'accepted_output',
            chatIdentity: clonePlain(context.chatIdentity),
            status: clonePlain(status),
        };

        if (stPort.isVisible?.() === false) {
            const queued = stPort.queueVisibleRender?.(renderPayload) || renderPayload;
            context = createContextForState({
                ...context,
                pendingVisibleRender: clonePlain(queued),
            });
            return;
        }

        try {
            const result = await stPort.applyAcceptedOutput?.(renderPayload);
            if (!isState(context, RetryState.RUNNING)) {
                return;
            }
            if (result?.ok === false) {
                await completeAfterBestEffortReload(status);
                return;
            }
            context = createContextForState({
                ...context,
                lastAppliedVersion: Math.max(Number(context.lastAppliedVersion || 0), nextVersion),
                pendingVisibleRender: null,
            });
            jobCompleted({ status });
        } catch {
            await completeAfterBestEffortReload(status);
        }
    }

    async function completeAfterBestEffortReload(status) {
        try {
            await stPort.guardedReload?.();
        } finally {
            if (isState(context, RetryState.RUNNING)) {
                jobCompleted({ status });
            }
        }
    }

    function handlePollingError(error) {
        const normalizedError = normalizeStructuredError(
            error,
            'handoff_request_failed',
            'Retry Mobile backend polling failed.',
        );
        logDeveloperError(logger, {
            transition: 'pollingError',
            state: context.state,
            jobId: context.jobId,
            error: normalizedError,
        });
        if (isState(context, RetryState.RUNNING)) {
            jobFailed({ error: normalizedError });
        }
    }

    function handleVisibleApplyFailure(error) {
        if (!isState(context, RetryState.RUNNING)) {
            return;
        }

        context = createContextForState({
            ...context,
            runError: toRenderApplyError(error),
        });
        stPort.clearGeneratingIndicator?.(clonePlain(resolveTargetChatIdentity(context)));
    }
}

function toRenderApplyError(error) {
    const fallbackMessage = 'Retry Mobile could not apply the accepted output to the visible chat.';
    const normalized = normalizeStructuredError(error, 'render_apply_failed', fallbackMessage);
    const detail = [
        normalized.code && normalized.code !== 'render_apply_failed'
            ? `[${normalized.code}]`
            : '',
        normalized.message && normalized.message !== fallbackMessage
            ? normalized.message
            : '',
        normalized.detail || '',
    ].filter(Boolean).join(' | ');

    return createStructuredError(
        'render_apply_failed',
        fallbackMessage,
        detail,
    );
}

function createContextForState(nextContext) {
    const normalized = normalizeBaseContext(nextContext);
    switch (normalized.state) {
        case RetryState.IDLE:
            return createIdleContext(normalized);
        case RetryState.ARMED:
            return createArmedContext(normalized);
        case RetryState.CAPTURING:
            return createCapturingContext(normalized);
        case RetryState.RUNNING:
        default:
            return createRunningContext(normalized);
    }
}

function normalizeBaseContext(nextContext) {
    return {
        ...nextContext,
        intent: normalizeIntent(nextContext.intent),
        chatIdentity: clonePlain(nextContext.chatIdentity) || null,
        capturedRequest: clonePlain(nextContext.capturedRequest) || null,
        captureFingerprint: clonePlain(nextContext.captureFingerprint) || null,
        target: clonePlain(nextContext.target) || null,
        runId: stringOrNull(nextContext.runId),
        jobId: stringOrNull(nextContext.jobId),
        pollingToken: stringOrNull(nextContext.pollingToken),
        lastAppliedVersion: numberOrNull(nextContext.lastAppliedVersion) || 0,
        lastKnownTargetMessageVersion: numberOrNull(nextContext.lastKnownTargetMessageVersion) || 0,
        pendingVisibleRender: clonePlain(nextContext.pendingVisibleRender) || null,
        lastTerminalResult: clonePlain(nextContext.lastTerminalResult) || null,
        toastScope: normalizeToastScope(nextContext.toastScope, nextContext.jobId),
        runError: clonePlain(nextContext.runError) || null,
        terminalError: clonePlain(nextContext.terminalError) || null,
    };
}

export function createIdleContext(nextContext) {
    const { runError: _ignoredRunError, ...rest } = nextContext;
    return lockContextShape({
        ...rest,
        state: RetryState.IDLE,
        capturedRequest: null,
        captureFingerprint: null,
        target: null,
        runId: null,
        jobId: null,
        pollingToken: null,
        lastKnownTargetMessageVersion: 0,
        lastAppliedVersion: 0,
        pendingVisibleRender: null,
        toastScope: normalizeToastScope(nextContext.toastScope, nextContext.jobId),
        terminalError: clonePlain(nextContext.terminalError) || null,
    });
}

export function createArmedContext(nextContext) {
    const { runError: _ignoredRunError, ...rest } = nextContext;
    return lockContextShape({
        ...rest,
        state: RetryState.ARMED,
        capturedRequest: null,
        captureFingerprint: null,
        jobId: null,
        pollingToken: null,
        lastKnownTargetMessageVersion: 0,
        lastAppliedVersion: 0,
        pendingVisibleRender: null,
        toastScope: normalizeToastScope(nextContext.toastScope, nextContext.jobId),
        terminalError: clonePlain(nextContext.terminalError) || null,
    });
}

export function createCapturingContext(nextContext) {
    const { runError: _ignoredRunError, ...rest } = nextContext;
    return lockContextShape({
        ...rest,
        state: RetryState.CAPTURING,
        jobId: null,
        pollingToken: null,
        lastKnownTargetMessageVersion: 0,
        lastAppliedVersion: 0,
        pendingVisibleRender: null,
        toastScope: normalizeToastScope(nextContext.toastScope, nextContext.jobId),
        terminalError: clonePlain(nextContext.terminalError) || null,
    });
}

export function createRunningContext(nextContext) {
    const { terminalError: _ignoredTerminalError, ...rest } = nextContext;
    return lockContextShape({
        ...rest,
        state: RetryState.RUNNING,
        capturedRequest: null,
        captureFingerprint: null,
        toastScope: normalizeToastScope(nextContext.toastScope, nextContext.jobId),
        runError: clonePlain(nextContext.runError) || null,
    });
}

export function createTerminalContext(nextContext) {
    const normalized = {
        ...nextContext,
        runError: null,
        toastScope: null,
    };
    switch (normalized.state) {
        case RetryState.ARMED:
            return createArmedContext(normalized);
        case RetryState.CAPTURING:
            return createCapturingContext(normalized);
        case RetryState.IDLE:
        default:
            return createIdleContext(normalized);
    }
}

function lockContextShape(contextValue) {
    const sealed = Object.preventExtensions(contextValue);
    if (isDevMode()) {
        return Object.freeze(sealed);
    }
    return sealed;
}

function isDevMode() {
    return Boolean(globalThis?.__RM_DEV__);
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

    const userAnchorId = stringOrNull(
        target.userAnchorId
        || target.targetUserAnchorId
        || target.userMessageId,
    );
    if (userAnchorId) {
        return `user-anchor:${userAnchorId}`;
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

    const userMessageIndex = numberOrNull(
        target.userMessageIndex
        ?? target.userIndexAtCapture,
    );
    if (chatKey && userMessageIndex != null) {
        return `${chatKey}@user#${userMessageIndex}`;
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

function normalizeToastScope(scope, jobId) {
    const normalizedJobId = stringOrNull(jobId) || stringOrNull(scope?.jobId) || null;
    if (!scope && !normalizedJobId) {
        return null;
    }
    return {
        jobId: normalizedJobId,
        lastAttemptCount: numberOrNull(scope?.lastAttemptCount),
        lastAcceptedCount: numberOrNull(scope?.lastAcceptedCount),
        lastTerminalState: stringOrNull(scope?.lastTerminalState) || null,
        lastNativePendingToast: Boolean(scope?.lastNativePendingToast),
        lastRunErrorKey: stringOrNull(scope?.lastRunErrorKey) || null,
    };
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
