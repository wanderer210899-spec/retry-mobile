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
        lastStatusRevision: numberOrNull(overrides.lastStatusRevision) || 0,
        lastKnownTargetMessageVersion: numberOrNull(overrides.lastKnownTargetMessageVersion) || 0,
        lastAppliedVersion: numberOrNull(overrides.lastAppliedVersion) || 0,
        pendingVisibleRender: clonePlain(overrides.pendingVisibleRender) || null,
        reloadAttempted: Boolean(overrides.reloadAttempted),
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
    logEvent = null,
} = {}) {
    const abortedCaptureRuns = new Map();
    let flushInFlight = false;
    let visibleApplyInFlight = false;
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
        adoptStatus,
        resume,
        userStop,
        observeBackendStatus,
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
            lastStatusRevision: 0,
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

        leaveCapturing(context, RetryState.RUNNING);

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
            lastStatusRevision: 0,
            lastKnownTargetMessageVersion: 0,
            lastAppliedVersion: 0,
            pendingVisibleRender: clonePlain(payload.pendingVisibleRender) || null,
            reloadAttempted: false,
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
            reloadAttempted: false,
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
            leaveCapturing(previous, RetryState.IDLE);
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
            reloadAttempted: false,
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
            leaveCapturing(previous, RetryState.RUNNING);
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
            lastStatusRevision: 0,
            lastKnownTargetMessageVersion: numberOrNull(payload.lastKnownTargetMessageVersion) || numberOrNull(status?.targetMessageVersion) || 0,
            lastAppliedVersion: 0,
            pendingVisibleRender: clonePlain(payload.pendingVisibleRender) || null,
            reloadAttempted: false,
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

    async function resume(payload = {}) {
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

        if (context.jobId) {
            backendPort.reportFrontendPresence?.(context.jobId, {
                reason: String(payload.reason || 'resume'),
                runId: context.runId,
                visibilityState: payload.isVisible === false ? 'hidden' : 'visible',
                chatIdentity: clonePlain(context.chatIdentity),
                target: clonePlain(context.target),
            });
        }

        if (context.pendingVisibleRender && payload.isVisible === true) {
            await flushPendingVisibleRender('page_visible');
        }

        return getContext();
    }

    async function adoptStatus(status) {
        if (!isState(context, RetryState.RUNNING)) {
            return getContext();
        }

        const statusJobId = stringOrNull(status?.jobId);
        if (statusJobId && statusJobId !== context.jobId) {
            return getContext();
        }

        await handlePollingStatus(status);
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
            leaveCapturing(previous, RetryState.IDLE);
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
        stPort.setLockdown?.(true);
        assertFrontEndContracts('capturing_entry');
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

    function leaveCapturing(previous = null, nextState = null) {
        if (nextState !== RetryState.RUNNING) {
            stPort.setLockdown?.(false);
        }
    }

    function enterRunning(nextContext) {
        if (context.pollingToken) {
            backendPort.stopPolling?.(context.pollingToken);
        }
        const nativeGraceSeconds = numberOrNull(nextContext.intent?.settings?.nativeGraceSeconds);
        const attemptTimeoutSeconds = numberOrNull(nextContext.intent?.settings?.attemptTimeoutSeconds);
        if (nextContext.captureFingerprint) {
            stPort.subscribeNativeObserver?.({
                runId: nextContext.runId,
                chatIdentity: clonePlain(nextContext.chatIdentity),
                target: clonePlain(nextContext.target),
                ...(nativeGraceSeconds != null ? { nativeGraceSeconds } : {}),
                ...(attemptTimeoutSeconds != null ? { attemptTimeoutSeconds } : {}),
                fingerprint: clonePlain(nextContext.captureFingerprint),
            });
        }

        const pollingToken = backendPort.startPolling?.(
            nextContext.jobId,
            (status) => handlePollingStatus(status),
            (error) => handlePollingError(error),
            () => resolvePollingCadence(context, stPort.isVisible?.()),
        ) || null;
        backendPort.stopAllExcept?.(pollingToken);

        backendPort.reportFrontendPresence?.(nextContext.jobId, {
            reason: 'running_entry',
            runId: nextContext.runId,
            visibilityState: stPort.isVisible?.() === false ? 'hidden' : 'visible',
            chatIdentity: clonePlain(nextContext.chatIdentity),
            target: clonePlain(nextContext.target),
        });

        stPort.setLockdown?.(true);
        assertFrontEndContracts('running_entry');
        stPort.setGeneratingIndicator?.(clonePlain(resolveTargetChatIdentity(nextContext)));
        return {
            pollingToken: stringOrNull(pollingToken),
            runError: null,
            terminalError: null,
            toastScope: normalizeToastScope(null, nextContext.jobId),
        };
    }

    function leaveRunning(previous) {
        assertFrontEndContracts('running_exit');
        if (previous.pollingToken) {
            backendPort.stopPolling?.(previous.pollingToken);
        }
        stPort.setLockdown?.(false);
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

    // Single render-strategy gate: called before any apply/queue decision.
    // Returns 'queue' when the output must be deferred, 'apply' otherwise.
    function decideRenderStrategy(ctx, port) {
        if (port.isVisible?.() === false) {
            return 'queue';
        }
        if (port.isStreaming?.() === true) {
            return 'queue';
        }
        return 'apply';
    }

    // Public entry point for all backend status updates. This is the only
    // place that may accept a backend job snapshot into frontend control
    // state; runtime mirrors are written by callers only after this returns
    // accepted:true.
    async function observeBackendStatus(status) {
        if (!status) {
            return { accepted: false, reason: 'no_status' };
        }

        const statusJobId = stringOrNull(status.jobId);
        if (!statusJobId) {
            logEvent?.('status_ingest_rejected', 'Status has no job ID.', { reason: 'missing_job_id' });
            return { accepted: false, reason: 'missing_job_id' };
        }

        const VALID_STATUS_STATES = new Set(['running', 'completed', 'failed', 'cancelled']);
        const state = String(status.state || '').trim();
        if (!VALID_STATUS_STATES.has(state)) {
            logEvent?.('status_ingest_rejected', `Invalid status state "${state}".`, { state, reason: 'invalid_state' });
            return { accepted: false, reason: 'invalid_state' };
        }

        if (!isState(context, RetryState.RUNNING)) {
            if (state === 'running') {
                logEvent?.('status_ingest_rejected', 'Running status arrived with no active frontend run.', { statusJobId, reason: 'no_active_run' });
                return { accepted: false, reason: 'no_active_run' };
            }
            return { accepted: true, reason: 'terminal_outside_running' };
        }

        if (statusJobId !== context.jobId) {
            logEvent?.('status_ingest_rejected', `Ignored status for job ${statusJobId}; active job is ${context.jobId}.`, { statusJobId, contextJobId: context.jobId, reason: 'job_id_mismatch' });
            return { accepted: false, reason: 'job_id_mismatch' };
        }

        const statusRunId = stringOrNull(status.runId);
        if (context.runId && statusRunId && statusRunId !== context.runId) {
            logEvent?.('status_ingest_rejected', `Ignored status for run ${statusRunId}; active run is ${context.runId}.`, { statusRunId, contextRunId: context.runId, reason: 'run_id_mismatch' });
            return { accepted: false, reason: 'run_id_mismatch' };
        }

        const statusRevision = getStatusRevision(status);
        const currentRevision = numberOrNull(context.lastStatusRevision) || 0;
        if (currentRevision > 0 && statusRevision <= 0) {
            logEvent?.('status_ingest_rejected', 'Status is missing a revision after revision tracking started.', { statusJobId, currentRevision, reason: 'missing_revision' });
            return { accepted: false, reason: 'missing_revision' };
        }

        if (statusRevision > 0 && currentRevision > 0 && statusRevision <= currentRevision) {
            logEvent?.('status_ingest_rejected', `Ignored out-of-order status revision ${statusRevision}; current revision is ${currentRevision}.`, { statusJobId, statusRevision, currentRevision, reason: 'out_of_order_revision' });
            return { accepted: false, reason: 'out_of_order_revision' };
        }

        if (statusRevision > 0) {
            context = createContextForState({
                ...context,
                lastStatusRevision: statusRevision,
            });
        }

        // Defensive lockdown lift: when backend confirms terminal state, clear
        // the lockdown immediately — do not wait for the FSM's jobCompleted
        // transition, which depends on the render path completing first.
        if (state !== 'running') {
            stPort.setLockdown?.(false);
        }

        await handlePollingStatus(status);
        return { accepted: true, reason: 'ok' };
    }

    async function handlePollingStatus(status) {
        if (!isState(context, RetryState.RUNNING)) {
            return;
        }

        const statusJobId = stringOrNull(status?.jobId);
        if (statusJobId && statusJobId !== context.jobId) {
            logEvent?.('polling_status_jobid_mismatch', `Ignored status for job ${statusJobId}; active job is ${context.jobId}.`, { statusJobId, contextJobId: context.jobId });
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

        // Streaming guard: if the tab is visible but native streaming is still mutating
        // the same assistant turn DOM, do not patch in-place. Queue a visible pending
        // render and flush it once streaming settles.
        if (context.pendingVisibleRender
            && stPort.isVisible?.() !== false
            && stPort.isStreaming?.() !== true) {
            await flushPendingVisibleRender('streaming_settled');
            return;
        }

        if (nextVersion <= Number(context.lastAppliedVersion || 0)) {
            return;
        }

        // resume() may already be processing pendingVisibleRender via flushPending.
        // Skip applyStatus to avoid a concurrent duplicate attempt that would race
        // the flush, both fail (stale in-memory chat), and cycle runError in the panel.
        if (context.pendingVisibleRender) {
            return;
        }

        const renderPayload = {
            kind: 'accepted_output',
            chatIdentity: clonePlain(context.chatIdentity),
            status: clonePlain(status),
        };
        const strategy = decideRenderStrategy(context, stPort);
        if (strategy === 'queue') {
            context = createContextForState({
                ...context,
                pendingVisibleRender: clonePlain(renderPayload),
                runError: null,
            });
            return;
        }

        if (visibleApplyInFlight) {
            const pendingVersion = numberOrNull(context.pendingVisibleRender?.status?.targetMessageVersion) || 0;
            context = createContextForState({
                ...context,
                pendingVisibleRender: nextVersion >= pendingVersion
                    ? clonePlain(renderPayload)
                    : context.pendingVisibleRender,
                runError: null,
            });
            return;
        }

        visibleApplyInFlight = true;
        logEvent?.('reconcile_apply_started', `Applying accepted output version ${nextVersion}.`, { targetMessageVersion: nextVersion });
        try {
            const result = await stPort.reconciler?.apply?.(renderPayload);
            if (!isState(context, RetryState.RUNNING)) {
                return;
            }
            if (result?.ok === false) {
                if (result?.recoveryRequired && context.jobId && !context.reloadAttempted) {
                    const jobId = context.jobId;
                    context = createContextForState({
                        ...context,
                        reloadAttempted: true,
                    });
                    logEvent?.('reconcile_apply_failed', `Apply failed [${result?.error?.code || 'unknown'}] — triggering chat reload.`, { errorCode: result?.error?.code, targetMessageVersion: nextVersion });
                    try {
                        await stPort.guardedReload?.();
                        logEvent?.('chat_reload_completed', 'Chat reload after apply failure completed.', null);
                        const fresh = await backendPort.pollStatus?.(jobId);
                        if (fresh && isState(context, RetryState.RUNNING)) {
                            await handlePollingStatus(fresh);
                        }
                    } catch {}
                    return;
                }
                logEvent?.('reconcile_apply_failed', `Apply failed [${result?.error?.code || 'unknown'}] — run error set.`, { errorCode: result?.error?.code, targetMessageVersion: nextVersion });
                handleVisibleApplyFailure(result?.error);
                return;
            }
            logEvent?.('reconcile_apply_succeeded', `Applied accepted output version ${nextVersion}.`, { targetMessageVersion: nextVersion });
            const queuedRender = clonePlain(context.pendingVisibleRender);
            const queuedVersion = numberOrNull(queuedRender?.status?.targetMessageVersion) || 0;
            context = createContextForState({
                ...context,
                lastKnownTargetMessageVersion: Math.max(Number(context.lastKnownTargetMessageVersion || 0), nextVersion),
                lastAppliedVersion: Math.max(Number(context.lastAppliedVersion || 0), nextVersion),
                pendingVisibleRender: queuedVersion > nextVersion ? queuedRender : null,
                runError: null,
            });
        } catch (error) {
            logEvent?.('reconcile_apply_failed', `Apply threw an exception — run error set.`, { errorCode: error?.code, targetMessageVersion: nextVersion });
            handleVisibleApplyFailure(error);
        } finally {
            visibleApplyInFlight = false;
            if (isState(context, RetryState.RUNNING)
                && context.pendingVisibleRender
                && stPort.isVisible?.() !== false
                && stPort.isStreaming?.() !== true) {
                await flushPendingVisibleRender('visible_apply_settled');
            }
        }
    }

    async function flushPendingVisibleRender(reason) {
        if (!isState(context, RetryState.RUNNING)) {
            return;
        }
        if (!context.pendingVisibleRender || flushInFlight) {
            return;
        }
        flushInFlight = true;
        const pendingRender = clonePlain(context.pendingVisibleRender);
        const pendingVersion = numberOrNull(pendingRender?.status?.targetMessageVersion) || 0;
        logEvent?.('reconcile_flush_started', `Flushing pending render version ${pendingVersion} (${reason}).`, { targetMessageVersion: pendingVersion });
        try {
            const result = await stPort.reconciler?.apply?.(pendingRender);
            if (!isState(context, RetryState.RUNNING)) {
                return;
            }
            if (result?.ok === false) {
                const willReload = !context.reloadAttempted;
                logEvent?.('reconcile_flush_failed', `Flush failed [${result?.error?.code || 'unknown'}]${willReload ? ' — triggering chat reload' : ''}.`, { errorCode: result?.error?.code, targetMessageVersion: pendingVersion });
                if (willReload) {
                    context = createContextForState({
                        ...context,
                        reloadAttempted: true,
                    });
                    try {
                        await stPort.guardedReload?.();
                        logEvent?.('chat_reload_completed', 'Chat reload after flush failure completed.', null);
                    } catch {}
                }
                handleVisibleApplyFailure(result?.error);
                return;
            }
            logEvent?.('reconcile_flush_succeeded', `Flush succeeded for version ${pendingVersion}.`, { targetMessageVersion: pendingVersion });
            context = createContextForState({
                ...context,
                lastAppliedVersion: Math.max(Number(context.lastAppliedVersion || 0), pendingVersion),
                pendingVisibleRender: null,
                runError: null,
            });
        } catch (error) {
            if (!isState(context, RetryState.RUNNING)) {
                return;
            }
            logEvent?.('reconcile_flush_failed', `Flush threw an exception${!context.reloadAttempted ? ' — triggering chat reload' : ''}.`, { errorCode: error?.code, targetMessageVersion: pendingVersion });
            if (!context.reloadAttempted) {
                context = createContextForState({
                    ...context,
                    reloadAttempted: true,
                });
                try {
                    await stPort.guardedReload?.();
                    logEvent?.('chat_reload_completed', 'Chat reload after flush exception completed.', null);
                } catch {}
            }
            handleVisibleApplyFailure(error);
        } finally {
            flushInFlight = false;
        }
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

        const strategy = decideRenderStrategy(context, stPort);
        if (strategy === 'queue') {
            if (stPort.isStreaming?.() === true) {
                logEvent?.('reconcile_terminal_deferred', `Terminal output version ${nextVersion} deferred — native still streaming.`, { targetMessageVersion: nextVersion });
            }
            context = createContextForState({
                ...context,
                lastKnownTargetMessageVersion: Math.max(Number(context.lastKnownTargetMessageVersion || 0), nextVersion),
                pendingVisibleRender: clonePlain(renderPayload),
            });
            return;
        }

        logEvent?.('reconcile_terminal_started', `Applying terminal output version ${nextVersion}.`, { targetMessageVersion: nextVersion });
        try {
            const result = await stPort.reconciler?.apply?.(renderPayload);
            if (!isState(context, RetryState.RUNNING)) {
                return;
            }
            if (result?.ok === false) {
                logEvent?.('reconcile_terminal_failed', `Terminal apply failed [${result?.error?.code || 'unknown'}] — triggering best-effort reload.`, { errorCode: result?.error?.code, targetMessageVersion: nextVersion });
                await completeAfterBestEffortReload(status);
                return;
            }
            logEvent?.('reconcile_terminal_succeeded', `Applied terminal output version ${nextVersion}.`, { targetMessageVersion: nextVersion });
            context = createContextForState({
                ...context,
                lastAppliedVersion: Math.max(Number(context.lastAppliedVersion || 0), nextVersion),
                pendingVisibleRender: null,
            });
            jobCompleted({ status });
        } catch {
            logEvent?.('reconcile_terminal_failed', 'Terminal apply threw an exception — triggering best-effort reload.', { targetMessageVersion: nextVersion });
            await completeAfterBestEffortReload(status);
        }
    }

    async function completeAfterBestEffortReload(status) {
        if (isState(context, RetryState.RUNNING) && !context.reloadAttempted) {
            context = createContextForState({
                ...context,
                reloadAttempted: true,
            });
            try {
                await stPort.guardedReload?.();
            } catch {}
        }
        if (isState(context, RetryState.RUNNING)) {
            jobCompleted({ status });
        }
    }

    function handlePollingError(error) {
        const normalizedError = normalizeStructuredError(
            error,
            'polling_transport_unavailable',
            'Retry Mobile temporarily lost contact with the backend retry job.',
        );
        logDeveloperError(logger, {
            transition: 'pollingError',
            state: context.state,
            jobId: context.jobId,
            error: normalizedError,
        });
        // Product requirement: frontend lifecycle and transient transport failures
        // must not be treated as terminal job failure. The backend is the truth
        // source and continues independently. Degrade UI + keep running; a future
        // successful poll will clear runError.
        if (isState(context, RetryState.RUNNING)) {
            context = createContextForState({
                ...context,
                runError: normalizedError,
            });
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

    function assertFrontEndContracts(stage) {
        const lockdownActive = stPort.lockdownActive?.();
        const reconcilerActive = stPort.reconciler?.isActive?.();
        if (lockdownActive === true && reconcilerActive === true) {
            return;
        }

        const detail = {
            transition: 'frontend_contract_violation',
            stage,
            state: context.state,
            lockdownActive: Boolean(lockdownActive),
            reconcilerActive: Boolean(reconcilerActive),
        };
        if (isDevMode()) {
            throw createStructuredError(
                'frontend_contract_violation',
                `Retry Mobile frontend contract violated during ${stage}.`,
                JSON.stringify(detail),
            );
        }
        logDeveloperError(logger, detail);
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
        lastStatusRevision: numberOrNull(nextContext.lastStatusRevision) || 0,
        lastAppliedVersion: numberOrNull(nextContext.lastAppliedVersion) || 0,
        lastKnownTargetMessageVersion: numberOrNull(nextContext.lastKnownTargetMessageVersion) || 0,
        pendingVisibleRender: clonePlain(nextContext.pendingVisibleRender) || null,
        reloadAttempted: Boolean(nextContext.reloadAttempted),
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
        lastStatusRevision: 0,
        lastKnownTargetMessageVersion: 0,
        lastAppliedVersion: 0,
        pendingVisibleRender: null,
        reloadAttempted: false,
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
        lastStatusRevision: 0,
        lastKnownTargetMessageVersion: 0,
        lastAppliedVersion: 0,
        pendingVisibleRender: null,
        reloadAttempted: false,
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
        lastStatusRevision: 0,
        lastKnownTargetMessageVersion: 0,
        lastAppliedVersion: 0,
        pendingVisibleRender: null,
        reloadAttempted: false,
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
        reloadAttempted: Boolean(nextContext.reloadAttempted),
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

// Fallback: derive kind locally when the server doesn't supply it.
// Prefer reading status.kind (added to serializeJob in server/state.js, B8).
function resolveTerminalKind(outcome, status) {
    if (outcome !== 'completed') {
        return String(outcome || 'completed');
    }
    const accepted = Number(status?.acceptedCount || 0);
    const version = Number(status?.targetMessageVersion || 0);
    if (accepted > 0 && version === 0) {
        return 'native_accepted';
    }
    return 'completed';
}

function createTerminalResult(outcome, payload, previous, error, now) {
    const status = payload?.status;
    const serverKind = typeof status?.kind === 'string' && status.kind ? status.kind : null;
    const kind = serverKind || resolveTerminalKind(outcome, status);
    return {
        outcome: String(outcome || 'completed'),
        kind,
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

function getStatusRevision(status) {
    const revision = Number(status?.revision);
    if (Number.isFinite(revision) && revision > 0) {
        return Math.floor(revision);
    }
    return 0;
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
