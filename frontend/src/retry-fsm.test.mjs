import test from 'node:test';
import assert from 'node:assert/strict';

import {
    RetryState,
    createRunningContext,
    createInitialRetryContext,
    createRetryFsm,
    resolvePollingCadence,
} from './retry-fsm.js';

function createHarness({
    initialIntent = {
        mode: 'toggle',
        engaged: false,
        singleTarget: null,
        settings: {
            targetAcceptedCount: 2,
            nativeGraceSeconds: 30,
        },
    },
    lockdownActive = true,
    reconcilerActive = true,
} = {}) {
    const calls = [];
    const logger = {
        errors: [],
        error(detail) {
            this.errors.push(detail);
            calls.push({ port: 'logger', method: 'error', args: [detail] });
        },
    };

    let runCounter = 0;
    let pollStatusHandler = null;
    let pollErrorHandler = null;
    let pollStatusResult = null;
    let visible = true;
    let streaming = false;
    let applyAcceptedOutputResult = { ok: true };
    let applyAcceptedOutputError = null;
    let intentState = {
        mode: initialIntent.mode || 'off',
        engaged: Boolean(initialIntent.engaged),
        singleTarget: initialIntent.singleTarget || null,
        settings: {
            ...(initialIntent.settings || {}),
        },
    };

    const intentPort = {
        readIntent() {
            calls.push({ port: 'intent', method: 'readIntent', args: [] });
            return {
                mode: intentState.mode,
                engaged: intentState.engaged,
                settings: {
                    ...intentState.settings,
                },
            };
        },
        writeIntent(nextIntent) {
            calls.push({ port: 'intent', method: 'writeIntent', args: [nextIntent] });
            intentState = {
                ...intentState,
                ...nextIntent,
                settings: {
                    ...intentState.settings,
                    ...(nextIntent.settings || {}),
                },
            };
        },
        getSingleTarget() {
            calls.push({ port: 'intent', method: 'getSingleTarget', args: [] });
            return intentState.singleTarget;
        },
        saveSingleTarget(target) {
            calls.push({ port: 'intent', method: 'saveSingleTarget', args: [target] });
            intentState = {
                ...intentState,
                singleTarget: target,
            };
        },
        clearSingleTarget() {
            calls.push({ port: 'intent', method: 'clearSingleTarget', args: [] });
            intentState = {
                ...intentState,
                singleTarget: null,
            };
        },
    };

    const stPort = {
        subscribeCapture(payload) {
            calls.push({ port: 'st', method: 'subscribeCapture', args: [payload] });
        },
        unsubscribeCapture(payload) {
            calls.push({ port: 'st', method: 'unsubscribeCapture', args: [payload] });
        },
        subscribeNativeObserver(payload) {
            calls.push({ port: 'st', method: 'subscribeNativeObserver', args: [payload] });
        },
        unsubscribeNativeObserver(payload) {
            calls.push({ port: 'st', method: 'unsubscribeNativeObserver', args: [payload] });
        },
        setLockdown(active) {
            calls.push({ port: 'st', method: 'setLockdown', args: [active] });
        },
        lockdownActive() {
            calls.push({ port: 'st', method: 'lockdownActive', args: [] });
            return lockdownActive;
        },
        setGeneratingIndicator(payload) {
            calls.push({ port: 'st', method: 'setGeneratingIndicator', args: [payload] });
        },
        clearGeneratingIndicator(payload) {
            calls.push({ port: 'st', method: 'clearGeneratingIndicator', args: [payload] });
        },
        guardedReload() {
            calls.push({ port: 'st', method: 'guardedReload', args: [] });
            return Promise.resolve(true);
        },
        isVisible() {
            calls.push({ port: 'st', method: 'isVisible', args: [] });
            return visible;
        },
        isStreaming() {
            calls.push({ port: 'st', method: 'isStreaming', args: [] });
            return streaming;
        },
        reconciler: {
            isActive() {
                calls.push({ port: 'st', method: 'reconciler.isActive', args: [] });
                return reconcilerActive;
            },
            apply(payload) {
                calls.push({ port: 'st', method: 'applyAcceptedOutput', args: [payload] });
                if (applyAcceptedOutputError) {
                    return Promise.reject(applyAcceptedOutputError);
                }
                return Promise.resolve(applyAcceptedOutputResult);
            },
        },
    };

    const backendPort = {
        startJob(payload) {
            calls.push({ port: 'backend', method: 'startJob', args: [payload] });
        },
        pollStatus(jobId) {
            calls.push({ port: 'backend', method: 'pollStatus', args: [jobId] });
            return Promise.resolve(pollStatusResult);
        },
        startPolling(jobId, onStatus, onError, selectCadence) {
            pollStatusHandler = onStatus;
            pollErrorHandler = onError;
            calls.push({ port: 'backend', method: 'startPolling', args: [jobId, onStatus, onError, selectCadence] });
            return `poll:${jobId}`;
        },
        stopPolling(pollingToken) {
            calls.push({ port: 'backend', method: 'stopPolling', args: [pollingToken] });
        },
        stopAllExcept(activeToken) {
            calls.push({ port: 'backend', method: 'stopAllExcept', args: [activeToken] });
        },
        reportFrontendPresence(jobId, payload) {
            calls.push({ port: 'backend', method: 'reportFrontendPresence', args: [jobId, payload] });
        },
        cancelJob(jobId, payload) {
            calls.push({ port: 'backend', method: 'cancelJob', args: [jobId, payload] });
        },
    };

    const fsm = createRetryFsm({
        intentPort,
        stPort,
        backendPort,
        createRunId() {
            runCounter += 1;
            return `run-${runCounter}`;
        },
        now() {
            return '2026-04-21T12:00:00.000Z';
        },
        logger,
    });

    return {
        fsm,
        calls,
        logger,
        getIntent() {
            return {
                mode: intentState.mode,
                engaged: intentState.engaged,
                singleTarget: intentState.singleTarget,
                settings: {
                    ...intentState.settings,
                },
            };
        },
        async emitPolledStatus(status) {
            await pollStatusHandler?.(status);
        },
        async emitPollError(error) {
            await pollErrorHandler?.(error);
        },
        setVisible(nextVisible) {
            visible = Boolean(nextVisible);
        },
        setStreaming(nextStreaming) {
            streaming = Boolean(nextStreaming);
        },
        setApplyAcceptedOutputResult(nextResult) {
            applyAcceptedOutputResult = nextResult;
        },
        setApplyAcceptedOutputError(nextError) {
            applyAcceptedOutputError = nextError;
        },
        setFlushPendingVisibleRenderResult(nextResult) {
            applyAcceptedOutputResult = nextResult;
        },
        setFlushPendingVisibleRenderError(nextError) {
            applyAcceptedOutputError = nextError;
        },
        setPollStatusResult(nextResult) {
            pollStatusResult = nextResult;
        },
    };
}

function lastCall(calls, method) {
    return [...calls].reverse().find((entry) => entry.method === method) || null;
}

test('createInitialRetryContext exposes the explicit FSM context shape', () => {
    const context = createInitialRetryContext();

    assert.deepEqual(context, {
        state: RetryState.IDLE,
        intent: {
            mode: 'off',
            engaged: false,
            singleTarget: null,
            settings: {},
        },
        chatIdentity: null,
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
        lastTerminalResult: null,
        terminalError: null,
        toastScope: null,
    });
});

test('resolvePollingCadence keeps the initial and lagging path fast, settles visible runs to steady, and hidden idle runs to slow', () => {
    assert.equal(resolvePollingCadence({
        state: RetryState.RUNNING,
        lastKnownTargetMessageVersion: 0,
        lastAppliedVersion: 0,
        pendingVisibleRender: null,
    }, true), 'fast');
    assert.equal(resolvePollingCadence({
        state: RetryState.RUNNING,
        lastKnownTargetMessageVersion: 3,
        lastAppliedVersion: 1,
        pendingVisibleRender: null,
    }, true), 'fast');
    assert.equal(resolvePollingCadence({
        state: RetryState.RUNNING,
        lastKnownTargetMessageVersion: 3,
        lastAppliedVersion: 3,
        pendingVisibleRender: null,
    }, true), 'steady');
    assert.equal(resolvePollingCadence({
        state: RetryState.RUNNING,
        lastKnownTargetMessageVersion: 3,
        lastAppliedVersion: 3,
        pendingVisibleRender: null,
    }, false), 'slow');
});

test('arm enters ARMED, engages intent, and subscribes capture through the ST port', () => {
    const { fsm, calls, getIntent } = createHarness({
        initialIntent: {
            mode: 'single',
            engaged: false,
            singleTarget: null,
            settings: {
                validationMode: 'tokens',
            },
        },
    });

    const target = {
        chatIdentity: {
            kind: 'character',
            chatId: 'chat-1',
            groupId: null,
        },
        assistantAnchorId: 'assistant-anchor-1',
    };

    const armed = fsm.arm({
        chatIdentity: target.chatIdentity,
        target,
    });

    assert.equal(armed.state, RetryState.ARMED);
    assert.equal(armed.runId, 'run-1');
    assert.deepEqual(armed.target, target);
    assert.equal(getIntent().engaged, true);
    assert.deepEqual(getIntent().singleTarget, target);
    assert.deepEqual(lastCall(calls, 'subscribeCapture')?.args[0], {
        runId: 'run-1',
        chatIdentity: target.chatIdentity,
        target,
    });
});

test('arm with mode off leaves the FSM idle and does not persist engaged intent', () => {
    const { fsm, calls, getIntent, logger } = createHarness({
        initialIntent: {
            mode: 'off',
            engaged: false,
            singleTarget: null,
            settings: {},
        },
    });

    const beforeWrites = calls.filter((entry) => entry.method === 'writeIntent').length;
    const result = fsm.arm({
        chatIdentity: {
            kind: 'character',
            chatId: 'chat-1',
            groupId: null,
        },
    });

    assert.equal(result.state, RetryState.IDLE);
    assert.equal(getIntent().engaged, false);
    assert.equal(calls.filter((entry) => entry.method === 'writeIntent').length, beforeWrites);
    assert.equal(logger.errors.at(-1)?.error.code, 'illegal_transition');
});

test('capture leaves ARMED, enters CAPTURING, and starts backend handoff through injected ports', () => {
    const { fsm, calls } = createHarness();
    const chatIdentity = {
        kind: 'character',
        chatId: 'chat-1',
        groupId: null,
    };
    const target = {
        chatIdentity,
        assistantAnchorId: 'assistant-anchor-1',
    };
    const fingerprint = {
        chatIdentity,
        userMessageText: 'hello',
    };

    fsm.arm({
        chatIdentity,
        intent: {
            mode: 'toggle',
        },
        target,
    });

    const captured = fsm.capture({
        request: {
            messages: ['hello'],
        },
        fingerprint,
        target,
    });

    assert.equal(captured.state, RetryState.CAPTURING);
    assert.deepEqual(lastCall(calls, 'unsubscribeCapture')?.args[0], {
        runId: 'run-1',
        chatIdentity,
    });
    assert.deepEqual(lastCall(calls, 'startJob')?.args[0], {
        runId: 'run-1',
        chatIdentity,
        capturedRequest: {
            messages: ['hello'],
        },
        target,
        intent: {
            mode: 'toggle',
            engaged: true,
            singleTarget: null,
            settings: {
                targetAcceptedCount: 2,
                nativeGraceSeconds: 30,
            },
        },
        runConfig: {
            targetAcceptedCount: 2,
            nativeGraceSeconds: 30,
        },
        settings: {
            targetAcceptedCount: 2,
            nativeGraceSeconds: 30,
        },
        nativeGraceSeconds: 30,
        targetFingerprint: fingerprint,
    });
    assert.equal(lastCall(calls, 'subscribeNativeObserver'), null);
});

test('illegal transitions no-op and log a structured developer error', () => {
    const { fsm, logger } = createHarness();
    const before = fsm.getContext();

    const after = fsm.capture({
        request: {
            messages: ['should be ignored'],
        },
    });

    assert.deepEqual(after, before);
    assert.equal(logger.errors.length, 1);
    assert.equal(logger.errors[0].error.code, 'illegal_transition');
    assert.equal(logger.errors[0].transition, 'capture');
    assert.equal(logger.errors[0].state, RetryState.IDLE);
});

test('jobStarted enters RUNNING, starts callback-driven polling, and applies the generating indicator', () => {
    const { fsm, calls } = createHarness();
    const chatIdentity = {
        kind: 'character',
        chatId: 'chat-1',
        groupId: null,
    };
    const target = {
        chatIdentity,
        assistantAnchorId: 'assistant-anchor-1',
    };

    fsm.arm({
        chatIdentity,
        intent: {
            mode: 'toggle',
        },
        target,
    });
    fsm.capture({
        request: {
            messages: ['hello'],
        },
        fingerprint: {
            chatIdentity,
            userMessageText: 'hello',
        },
        target,
    });

    const running = fsm.jobStarted({
        jobId: 'job-1',
        target,
    });

    assert.equal(running.state, RetryState.RUNNING);
    assert.equal(running.jobId, 'job-1');
    assert.equal(running.pollingToken, 'poll:job-1');
    assert.deepEqual(lastCall(calls, 'subscribeNativeObserver')?.args[0], {
        runId: 'run-1',
        chatIdentity,
        target,
        nativeGraceSeconds: 30,
        fingerprint: {
            chatIdentity,
            userMessageText: 'hello',
        },
    });
    assert.deepEqual(lastCall(calls, 'startPolling')?.args, [
        'job-1',
        lastCall(calls, 'startPolling')?.args[1],
        lastCall(calls, 'startPolling')?.args[2],
        lastCall(calls, 'startPolling')?.args[3],
    ]);
    assert.equal(typeof lastCall(calls, 'startPolling')?.args[1], 'function');
    assert.equal(typeof lastCall(calls, 'startPolling')?.args[2], 'function');
    assert.equal(typeof lastCall(calls, 'startPolling')?.args[3], 'function');
    assert.deepEqual(lastCall(calls, 'setGeneratingIndicator')?.args[0], chatIdentity);
    assert.equal(
        calls.filter((entry) => entry.method === 'setLockdown' && entry.args[0] === true).length >= 2,
        true,
    );
});

test('jobStarted reports hidden visibility when the tab backgrounds before start returns', () => {
    const { fsm, calls, setVisible } = createHarness();
    const chatIdentity = { kind: 'character', chatId: 'chat-hidden-start', groupId: null };
    const target = { chatIdentity, assistantAnchorId: 'assistant-anchor-hidden' };

    fsm.arm({ chatIdentity, intent: { mode: 'toggle' }, target });
    fsm.capture({
        request: { messages: ['hello'] },
        fingerprint: { chatIdentity, userMessageText: 'hello' },
        target,
    });
    setVisible(false);
    fsm.jobStarted({ jobId: 'job-hidden-start', target });

    const presenceCall = calls.find((entry) => entry.method === 'reportFrontendPresence');
    assert.deepEqual(presenceCall?.args, [
        'job-hidden-start',
        {
            reason: 'running_entry',
            runId: 'run-1',
            visibilityState: 'hidden',
            chatIdentity,
            target,
        },
    ]);
});

test('lockdown remains active across CAPTURING to RUNNING and clears on user stop', () => {
    const { fsm, calls } = createHarness();
    const chatIdentity = {
        kind: 'character',
        chatId: 'chat-1',
        groupId: null,
    };

    fsm.arm({
        chatIdentity,
        intent: {
            mode: 'toggle',
        },
    });
    fsm.capture({
        request: {
            messages: ['hello'],
        },
    });
    fsm.jobStarted({
        jobId: 'job-1',
    });
    fsm.userStop();

    const lockdownCalls = calls.filter((entry) => entry.method === 'setLockdown').map((entry) => entry.args[0]);
    assert.deepEqual(lockdownCalls, [true, true, false]);
});

test('dev mode throws when frontend lockdown/reconciler contracts are violated', () => {
    const previousDev = globalThis.__RM_DEV__;
    globalThis.__RM_DEV__ = true;
    try {
        const { fsm } = createHarness({
            lockdownActive: false,
            reconcilerActive: false,
        });
        const chatIdentity = {
            kind: 'character',
            chatId: 'chat-1',
            groupId: null,
        };
        fsm.arm({
            chatIdentity,
            intent: {
                mode: 'toggle',
            },
        });
        assert.throws(() => {
            fsm.capture({
                request: {
                    messages: ['hello'],
                },
            });
        }, /frontend_contract_violation/);
    } finally {
        globalThis.__RM_DEV__ = previousDev;
    }
});

test('jobStarted provides a cadence selector that tracks lagging, caught-up, and hidden steady-state running', async () => {
    const { fsm, calls, emitPolledStatus, setVisible } = createHarness();
    const chatIdentity = { kind: 'character', chatId: 'chat-1', groupId: null };
    const target = { chatIdentity, assistantAnchorId: 'assistant-anchor-1' };

    fsm.arm({ chatIdentity, intent: { mode: 'toggle' }, target });
    fsm.capture({
        request: { messages: ['hello'] },
        fingerprint: { chatIdentity, userMessageText: 'hello' },
        target,
    });
    fsm.jobStarted({ jobId: 'job-1', target });

    const selectCadence = lastCall(calls, 'startPolling')?.args[3];
    assert.equal(selectCadence(), 'fast');

    await emitPolledStatus({ jobId: 'job-1', state: 'running', targetMessageVersion: 1 });
    await Promise.resolve();
    assert.equal(selectCadence(), 'steady');

    setVisible(false);
    assert.equal(selectCadence(), 'slow');
});

test('terminal poll status re-enters the FSM through the polling callbacks', async () => {
    const { fsm, emitPolledStatus } = createHarness();
    const chatIdentity = {
        kind: 'character',
        chatId: 'chat-1',
        groupId: null,
    };
    const target = {
        chatIdentity,
        assistantAnchorId: 'assistant-anchor-1',
    };

    fsm.arm({
        chatIdentity,
        intent: {
            mode: 'toggle',
        },
        target,
    });
    fsm.capture({
        request: {
            messages: ['hello'],
        },
        fingerprint: {
            chatIdentity,
            userMessageText: 'hello',
        },
        target,
    });
    fsm.jobStarted({
        jobId: 'job-1',
        target,
    });

    await emitPolledStatus({
        jobId: 'job-1',
        state: 'completed',
    });
    await Promise.resolve();

    const state = fsm.getContext();
    assert.equal(state.state, RetryState.ARMED);
    assert.equal(state.jobId, null);
    assert.equal(state.runId, 'run-2');
});

test('terminal completed status applies final accepted output before re-arming', async () => {
    const { fsm, calls, emitPolledStatus } = createHarness();
    const chatIdentity = { kind: 'character', chatId: 'chat-1', groupId: null };
    const target = { chatIdentity, assistantAnchorId: 'assistant-anchor-1' };

    fsm.arm({ chatIdentity, intent: { mode: 'toggle' }, target });
    fsm.capture({
        request: { messages: ['hello'] },
        fingerprint: { chatIdentity, userMessageText: 'hello' },
        target,
    });
    fsm.jobStarted({ jobId: 'job-1', target });

    await emitPolledStatus({
        jobId: 'job-1',
        state: 'completed',
        targetMessageVersion: 1,
        targetMessage: {
            mes: 'Native reply',
            swipes: ['Native reply', 'Accepted retry'],
        },
    });
    await Promise.resolve();

    const applyCall = calls.find((entry) => entry.method === 'applyAcceptedOutput');
    assert.ok(applyCall, 'expected terminal completion to patch the accepted output');
    assert.equal(Object.prototype.hasOwnProperty.call(applyCall.args[0], 'terminalOutcome'), false);
    assert.equal(applyCall.args[0].status.targetMessageVersion, 1);
    assert.equal(fsm.getContext().state, RetryState.ARMED);
});

test('running poll status applies accepted output once per version when visible', async () => {
    const { fsm, calls, emitPolledStatus } = createHarness();
    const chatIdentity = { kind: 'character', chatId: 'chat-1', groupId: null };
    const target = { chatIdentity, assistantAnchorId: 'assistant-anchor-1' };

    fsm.arm({ chatIdentity, intent: { mode: 'toggle' }, target });
    fsm.capture({
        request: { messages: ['hello'] },
        fingerprint: { chatIdentity, userMessageText: 'hello' },
        target,
    });
    fsm.jobStarted({ jobId: 'job-1', target });

    await emitPolledStatus({ jobId: 'job-1', state: 'running', targetMessageVersion: 1 });
    await Promise.resolve();
    await emitPolledStatus({ jobId: 'job-1', state: 'running', targetMessageVersion: 1 });

    assert.equal(calls.filter((entry) => entry.method === 'applyAcceptedOutput').length, 1);
    assert.equal(fsm.getContext().lastAppliedVersion, 1);
});

test('streaming guard queues a visible pending render and flushes it once streaming settles', async () => {
    const { fsm, calls, emitPolledStatus, setStreaming } = createHarness();
    const chatIdentity = { kind: 'character', chatId: 'chat-1', groupId: null };
    const target = { chatIdentity, assistantAnchorId: 'assistant-anchor-1' };

    fsm.arm({ chatIdentity, intent: { mode: 'toggle' }, target });
    fsm.capture({
        request: { messages: ['hello'] },
        fingerprint: { chatIdentity, userMessageText: 'hello' },
        target,
    });
    fsm.jobStarted({ jobId: 'job-1', target });

    setStreaming(true);
    await emitPolledStatus({ jobId: 'job-1', state: 'running', targetMessageVersion: 2 });
    await Promise.resolve();

    assert.equal(Boolean(fsm.getContext().pendingVisibleRender), true);
    assert.equal(calls.filter((entry) => entry.method === 'applyAcceptedOutput').length, 0);

    setStreaming(false);
    await emitPolledStatus({ jobId: 'job-1', state: 'running', targetMessageVersion: 2 });
    // allow flush promise chain to run
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(calls.filter((entry) => entry.method === 'applyAcceptedOutput').length >= 1, true);
    assert.equal(fsm.getContext().pendingVisibleRender, null);
    assert.equal(fsm.getContext().lastAppliedVersion >= 2, true);
});

test('running poll status does not advance applied version when applyAcceptedOutput fails', async () => {
    const { fsm, calls, emitPolledStatus, setApplyAcceptedOutputResult } = createHarness();
    const chatIdentity = { kind: 'character', chatId: 'chat-1', groupId: null };
    const target = { chatIdentity, assistantAnchorId: 'assistant-anchor-1' };

    fsm.arm({ chatIdentity, intent: { mode: 'toggle' }, target });
    fsm.capture({
        request: { messages: ['hello'] },
        fingerprint: { chatIdentity, userMessageText: 'hello' },
        target,
    });
    fsm.jobStarted({ jobId: 'job-1', target });

    setApplyAcceptedOutputResult({ ok: false });
    await emitPolledStatus({ jobId: 'job-1', state: 'running', targetMessageVersion: 2 });
    await Promise.resolve();
    await emitPolledStatus({ jobId: 'job-1', state: 'running', targetMessageVersion: 2 });

    assert.equal(calls.filter((entry) => entry.method === 'applyAcceptedOutput').length, 2);
    assert.equal(fsm.getContext().lastAppliedVersion, 0);
    assert.equal(fsm.getContext().state, RetryState.RUNNING);
    assert.equal(fsm.getContext().runError?.code, 'render_apply_failed');
    assert.deepEqual(lastCall(calls, 'clearGeneratingIndicator')?.args[0], chatIdentity);
});

test('running poll status coalesces duplicate visible apply while the first patch is in flight', async () => {
    const { fsm, calls, emitPolledStatus, setApplyAcceptedOutputResult } = createHarness();
    const chatIdentity = { kind: 'character', chatId: 'chat-1', groupId: null };
    const target = { chatIdentity, assistantAnchorId: 'assistant-anchor-1' };
    let resolveApply;
    const slowApply = new Promise((resolve) => {
        resolveApply = resolve;
    });

    fsm.arm({ chatIdentity, intent: { mode: 'toggle' }, target });
    fsm.capture({
        request: { messages: ['hello'] },
        fingerprint: { chatIdentity, userMessageText: 'hello' },
        target,
    });
    fsm.jobStarted({ jobId: 'job-1', target });

    setApplyAcceptedOutputResult(slowApply);
    const firstPoll = emitPolledStatus({ jobId: 'job-1', state: 'running', targetMessageVersion: 2 });
    await Promise.resolve();
    const duplicatePoll = emitPolledStatus({ jobId: 'job-1', state: 'running', targetMessageVersion: 2 });
    await Promise.resolve();

    assert.equal(calls.filter((entry) => entry.method === 'applyAcceptedOutput').length, 1);

    resolveApply({ ok: true });
    await firstPoll;
    await duplicatePoll;

    assert.equal(calls.filter((entry) => entry.method === 'applyAcceptedOutput').length, 1);
    assert.equal(fsm.getContext().lastAppliedVersion, 2);
    assert.equal(fsm.getContext().pendingVisibleRender, null);
});

test('running poll status triggers a single guarded reload on recoveryRequired apply failure (browser-resume disk mismatch)', async () => {
    const { fsm, calls, emitPolledStatus, setApplyAcceptedOutputResult, setPollStatusResult } = createHarness();
    const chatIdentity = { kind: 'character', chatId: 'chat-1', groupId: null };
    const target = { chatIdentity, assistantAnchorId: 'assistant-anchor-1' };

    fsm.arm({ chatIdentity, intent: { mode: 'toggle' }, target });
    fsm.capture({
        request: { messages: ['hello'] },
        fingerprint: { chatIdentity, userMessageText: 'hello' },
        target,
    });
    fsm.jobStarted({ jobId: 'job-1', target });

    setApplyAcceptedOutputResult({ ok: false, recoveryRequired: true, error: { message: 'mismatch' } });
    setPollStatusResult({ jobId: 'job-1', state: 'running', targetMessageVersion: 2 });

    await emitPolledStatus({ jobId: 'job-1', state: 'running', targetMessageVersion: 2 });
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(calls.filter((entry) => entry.method === 'guardedReload').length, 1);

    // A second failed apply in the same job should not trigger another reload.
    await emitPolledStatus({ jobId: 'job-1', state: 'running', targetMessageVersion: 2 });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(calls.filter((entry) => entry.method === 'guardedReload').length, 1);
});

test('indicator stays cleared after render_apply_failed even if the next apply succeeds', async () => {
    const { fsm, calls, emitPolledStatus, setApplyAcceptedOutputResult } = createHarness();
    const chatIdentity = { kind: 'character', chatId: 'chat-1', groupId: null };
    const target = { chatIdentity, assistantAnchorId: 'assistant-anchor-1' };

    fsm.arm({ chatIdentity, intent: { mode: 'toggle' }, target });
    fsm.capture({
        request: { messages: ['hello'] },
        fingerprint: { chatIdentity, userMessageText: 'hello' },
        target,
    });
    fsm.jobStarted({ jobId: 'job-1', target });

    const indicatorSetsBefore = calls.filter((entry) => entry.method === 'setGeneratingIndicator').length;

    setApplyAcceptedOutputResult({ ok: false });
    await emitPolledStatus({ jobId: 'job-1', state: 'running', targetMessageVersion: 2 });
    await Promise.resolve();

    assert.equal(calls.filter((entry) => entry.method === 'clearGeneratingIndicator').length, 1);

    setApplyAcceptedOutputResult({ ok: true });
    await emitPolledStatus({ jobId: 'job-1', state: 'running', targetMessageVersion: 3 });
    await Promise.resolve();

    assert.equal(
        calls.filter((entry) => entry.method === 'setGeneratingIndicator').length,
        indicatorSetsBefore,
        'setGeneratingIndicator must not be re-applied after a render_apply_failed event',
    );
    assert.equal(fsm.getContext().lastAppliedVersion, 3);
});

test('running poll status surfaces a structured error and clears the indicator when applyAcceptedOutput rejects', async () => {
    const { fsm, calls, emitPolledStatus, setApplyAcceptedOutputError } = createHarness();
    const chatIdentity = { kind: 'character', chatId: 'chat-1', groupId: null };
    const target = { chatIdentity, assistantAnchorId: 'assistant-anchor-1' };

    fsm.arm({ chatIdentity, intent: { mode: 'toggle' }, target });
    fsm.capture({
        request: { messages: ['hello'] },
        fingerprint: { chatIdentity, userMessageText: 'hello' },
        target,
    });
    fsm.jobStarted({ jobId: 'job-1', target });

    setApplyAcceptedOutputError(new Error('message patch failed'));
    await emitPolledStatus({ jobId: 'job-1', state: 'running', targetMessageVersion: 2 });
    await Promise.resolve();

    assert.equal(fsm.getContext().state, RetryState.RUNNING);
    assert.equal(fsm.getContext().lastAppliedVersion, 0);
    assert.equal(fsm.getContext().runError?.code, 'render_apply_failed');
    assert.match(fsm.getContext().runError?.detail || '', /message patch failed/);
    assert.deepEqual(lastCall(calls, 'clearGeneratingIndicator')?.args[0], chatIdentity);
});

test('resume is an internal RUNNING self-transition that does not churn polling or indicator entry actions', async () => {
    const { fsm, calls } = createHarness();
    const chatIdentity = {
        kind: 'character',
        chatId: 'chat-1',
        groupId: null,
    };
    const target = {
        chatIdentity,
        assistantAnchorId: 'assistant-anchor-1',
    };

    fsm.arm({
        chatIdentity,
        intent: {
            mode: 'toggle',
        },
        target,
    });
    fsm.capture({
        request: {
            messages: ['hello'],
        },
        target,
    });
    fsm.jobStarted({
        jobId: 'job-1',
        target,
    });

    const pollingStartsBeforeResume = calls.filter((entry) => entry.method === 'startPolling').length;
    const indicatorSetsBeforeResume = calls.filter((entry) => entry.method === 'setGeneratingIndicator').length;

    const resumed = await fsm.resume({
        reason: 'window.focused',
        isVisible: true,
        pendingVisibleRender: {
            targetVersion: 3,
        },
    });

    assert.equal(resumed.state, RetryState.RUNNING);
    assert.equal(fsm.getContext().pendingVisibleRender, null);
    assert.equal(calls.filter((entry) => entry.method === 'startPolling').length, pollingStartsBeforeResume);
    assert.equal(calls.filter((entry) => entry.method === 'setGeneratingIndicator').length, indicatorSetsBeforeResume);
    assert.deepEqual(lastCall(calls, 'applyAcceptedOutput')?.args[0], {
        targetVersion: 3,
    });
    assert.deepEqual(lastCall(calls, 'reportFrontendPresence')?.args, [
        'job-1',
        {
            reason: 'window.focused',
            runId: 'run-1',
            visibilityState: 'visible',
            chatIdentity,
            target,
        },
    ]);
});

test('resume keeps the pending render queued and triggers guarded reload when the visible flush rejects', async () => {
    const { fsm, calls, setFlushPendingVisibleRenderError } = createHarness();
    const chatIdentity = { kind: 'character', chatId: 'chat-1', groupId: null };
    const target = { chatIdentity, assistantAnchorId: 'assistant-anchor-1' };
    const pendingVisibleRender = {
        kind: 'accepted_output',
        chatIdentity,
        status: {
            jobId: 'job-1',
            state: 'running',
            targetMessageVersion: 4,
        },
    };

    fsm.arm({ chatIdentity, intent: { mode: 'toggle' }, target });
    fsm.capture({
        request: { messages: ['hello'] },
        target,
    });
    fsm.jobStarted({
        jobId: 'job-1',
        target,
        pendingVisibleRender,
    });

    setFlushPendingVisibleRenderError(new Error('flush failed'));
    const resumed = await fsm.resume({
        reason: 'window.focused',
        isVisible: true,
        pendingVisibleRender,
    });

    assert.equal(resumed.state, RetryState.RUNNING);
    assert.deepEqual(fsm.getContext().pendingVisibleRender, pendingVisibleRender);
    assert.equal(fsm.getContext().lastAppliedVersion, 0);
    assert.equal(calls.filter((entry) => entry.method === 'guardedReload').length, 1);
});

test('resume flush with result.ok === false keeps pendingVisibleRender until recovery verifies it', async () => {
    const { fsm, calls, setFlushPendingVisibleRenderResult } = createHarness();
    const chatIdentity = { kind: 'character', chatId: 'chat-1', groupId: null };
    const target = { chatIdentity, assistantAnchorId: 'assistant-anchor-1' };
    const pendingVisibleRender = {
        kind: 'accepted_output',
        chatIdentity,
        status: {
            jobId: 'job-1',
            state: 'running',
            targetMessageVersion: 4,
        },
    };

    fsm.arm({ chatIdentity, intent: { mode: 'toggle' }, target });
    fsm.capture({
        request: { messages: ['hello'] },
        target,
    });
    fsm.jobStarted({
        jobId: 'job-1',
        target,
        pendingVisibleRender,
    });

    setFlushPendingVisibleRenderResult({ ok: false });
    const resumed = await fsm.resume({
        reason: 'window.focused',
        isVisible: true,
        pendingVisibleRender,
    });

    assert.equal(resumed.state, RetryState.RUNNING);
    assert.equal(calls.filter((entry) => entry.method === 'guardedReload').length, 1);
    assert.deepEqual(fsm.getContext().pendingVisibleRender, pendingVisibleRender);
    assert.equal(fsm.getContext().lastAppliedVersion, 0);
    assert.equal(fsm.getContext().runError?.code, 'render_apply_failed');
});

test('resume keeps pending renders queued while the tab is still hidden', async () => {
    const { fsm, calls } = createHarness();
    const chatIdentity = {
        kind: 'character',
        chatId: 'chat-1',
        groupId: null,
    };
    const target = {
        chatIdentity,
        assistantAnchorId: 'assistant-anchor-1',
    };

    fsm.arm({
        chatIdentity,
        intent: {
            mode: 'toggle',
        },
        target,
    });
    fsm.capture({
        request: {
            messages: ['hello'],
        },
        target,
    });
    fsm.jobStarted({
        jobId: 'job-1',
        target,
    });

    const resumed = await fsm.resume({
        reason: 'network.online',
        isVisible: false,
        pendingVisibleRender: {
            targetVersion: 4,
        },
    });

    assert.equal(resumed.state, RetryState.RUNNING);
    assert.deepEqual(resumed.pendingVisibleRender, {
        targetVersion: 4,
    });
    assert.equal(calls.some((entry) => entry.method === 'applyAcceptedOutput'), false);
});

test('resume leaves return polling to the resume coordinator when no pendingVisibleRender is queued', async () => {
    const { fsm, calls, setPollStatusResult } = createHarness();
    const chatIdentity = { kind: 'character', chatId: 'chat-1', groupId: null };
    const target = { chatIdentity, assistantAnchorId: 'assistant-anchor-1' };

    fsm.arm({ chatIdentity, intent: { mode: 'toggle' }, target });
    fsm.capture({ request: { messages: ['hello'] }, target });
    fsm.jobStarted({ jobId: 'job-1', target });

    setPollStatusResult({ state: 'running', jobId: 'job-1', targetMessageVersion: 0 });

    await fsm.resume({
        reason: 'page.visible',
        isVisible: true,
        pendingVisibleRender: null,
    });

    assert.equal(
        calls.filter((entry) => entry.port === 'backend' && entry.method === 'pollStatus').length,
        0,
        'resume() must not poll directly; app-resume-coordinator owns the single return poll',
    );
});

test('resume does NOT trigger immediate pollStatus when pendingVisibleRender is already set', async () => {
    const { fsm, calls, setPollStatusResult } = createHarness();
    const chatIdentity = { kind: 'character', chatId: 'chat-1', groupId: null };
    const target = { chatIdentity, assistantAnchorId: 'assistant-anchor-1' };
    const pendingVisibleRender = {
        kind: 'accepted_output',
        chatIdentity,
        status: { jobId: 'job-1', state: 'running', targetMessageVersion: 2 },
    };

    fsm.arm({ chatIdentity, intent: { mode: 'toggle' }, target });
    fsm.capture({ request: { messages: ['hello'] }, target });
    fsm.jobStarted({ jobId: 'job-1', target, pendingVisibleRender });

    setPollStatusResult({ state: 'completed', jobId: 'job-1', targetMessageVersion: 2 });

    await fsm.resume({
        reason: 'page.visible',
        isVisible: true,
        pendingVisibleRender,
    });

    assert.equal(
        calls.filter((entry) => entry.port === 'backend' && entry.method === 'pollStatus').length,
        0,
        'should not fire an extra immediate poll when a pending render is already queued',
    );
});

test('resume does NOT trigger immediate pollStatus when not visible', async () => {
    const { fsm, calls, setPollStatusResult } = createHarness();
    const chatIdentity = { kind: 'character', chatId: 'chat-1', groupId: null };
    const target = { chatIdentity, assistantAnchorId: 'assistant-anchor-1' };

    fsm.arm({ chatIdentity, intent: { mode: 'toggle' }, target });
    fsm.capture({ request: { messages: ['hello'] }, target });
    fsm.jobStarted({ jobId: 'job-1', target });

    setPollStatusResult({ state: 'running', jobId: 'job-1', targetMessageVersion: 0 });

    await fsm.resume({
        reason: 'network.online',
        isVisible: false,
        pendingVisibleRender: null,
    });

    assert.equal(
        calls.filter((entry) => entry.port === 'backend' && entry.method === 'pollStatus').length,
        0,
        'should not fire an immediate poll when the page is still hidden',
    );
});

test('jobCompleted re-arms toggle mode without a same-chat restriction', () => {
    const { fsm } = createHarness({
        initialIntent: {
            mode: 'toggle',
            engaged: false,
            singleTarget: null,
            settings: {},
        },
    });

    const originalChat = {
        kind: 'character',
        chatId: 'chat-1',
        groupId: null,
    };
    const laterVisibleChat = {
        kind: 'character',
        chatId: 'chat-2',
        groupId: null,
    };
    const target = {
        chatIdentity: originalChat,
        assistantAnchorId: 'assistant-anchor-1',
    };

    fsm.arm({
        chatIdentity: originalChat,
        intent: {
            mode: 'toggle',
        },
        target,
    });
    fsm.capture({
        request: {
            messages: ['hello'],
        },
        target,
    });
    fsm.jobStarted({
        jobId: 'job-1',
        target,
    });

    const rearmed = fsm.jobCompleted({
        chatIdentity: laterVisibleChat,
        status: {
            state: 'completed',
        },
    });

    assert.equal(rearmed.state, RetryState.ARMED);
    assert.equal(rearmed.runId, 'run-2');
    assert.equal(rearmed.target, null);
    assert.deepEqual(rearmed.chatIdentity, laterVisibleChat);
});

test('jobCompleted in single mode only re-arms when the durable target identity still matches', () => {
    const singleTarget = {
        chatIdentity: {
            kind: 'character',
            chatId: 'chat-1',
            groupId: null,
        },
        assistantAnchorId: 'assistant-anchor-1',
    };
    const { fsm } = createHarness({
        initialIntent: {
            mode: 'single',
            engaged: false,
            singleTarget: null,
            settings: {},
        },
    });

    fsm.arm({
        chatIdentity: singleTarget.chatIdentity,
        target: singleTarget,
    });
    fsm.capture({
        request: {
            messages: ['hello'],
        },
        target: singleTarget,
    });
    fsm.jobStarted({
        jobId: 'job-1',
        target: singleTarget,
    });

    const rearmed = fsm.jobCompleted({
        status: {
            state: 'completed',
        },
    });

    assert.equal(rearmed.state, RetryState.ARMED);
    assert.deepEqual(rearmed.target, singleTarget);
});

test('jobCompleted in single mode re-arms when the saved user-turn target still matches', () => {
    const singleTarget = {
        chatIdentity: {
            kind: 'character',
            chatId: 'chat-1',
            groupId: null,
        },
        userMessageIndex: 4,
    };
    const { fsm } = createHarness({
        initialIntent: {
            mode: 'single',
            engaged: false,
            singleTarget: null,
            settings: {},
        },
    });

    fsm.arm({
        chatIdentity: singleTarget.chatIdentity,
        target: singleTarget,
    });
    fsm.capture({
        request: {
            messages: ['hello'],
        },
        target: singleTarget,
    });
    fsm.jobStarted({
        jobId: 'job-1',
        target: singleTarget,
    });

    const rearmed = fsm.jobCompleted({
        status: {
            state: 'completed',
        },
    });

    assert.equal(rearmed.state, RetryState.ARMED);
    assert.deepEqual(rearmed.target, singleTarget);
});

test('jobFailed from CAPTURING keeps durable intent armed instead of silently dropping the feature', () => {
    const { fsm } = createHarness({
        initialIntent: {
            mode: 'toggle',
            engaged: false,
            singleTarget: null,
            settings: {},
        },
    });

    fsm.arm({
        chatIdentity: {
            kind: 'character',
            chatId: 'chat-1',
            groupId: null,
        },
        intent: {
            mode: 'toggle',
        },
    });
    fsm.capture({
        request: {
            messages: ['hello'],
        },
    });

    const failed = fsm.jobFailed({
        error: new Error('backend handoff failed'),
    });

    assert.equal(failed.state, RetryState.ARMED);
    assert.equal(failed.runId, 'run-2');
    // Auto-rearm into ARMED must not surface the prior failure as a panel
    // error box. The terminal toast still fires from `lastTerminalResult` and
    // the error itself is preserved on `lastTerminalResult.error` for logs,
    // but the new ARMED phase is a fresh "ready for next request" state.
    assert.equal(failed.terminalError, null);
    assert.equal(failed.lastTerminalResult.outcome, 'failed');
    assert.equal(failed.lastTerminalResult.error?.code, 'retry_job_failed');
});

test('late jobStarted after stop during CAPTURING cancels the orphaned backend job without logging an illegal transition', () => {
    const { fsm, calls, logger } = createHarness();
    const chatIdentity = {
        kind: 'character',
        chatId: 'chat-1',
        groupId: null,
    };
    const target = {
        chatIdentity,
        assistantAnchorId: 'assistant-anchor-1',
    };

    fsm.arm({
        chatIdentity,
        intent: {
            mode: 'toggle',
        },
        target,
    });
    fsm.capture({
        request: {
            messages: ['hello'],
        },
        target,
    });
    fsm.userStop();

    const lateStart = fsm.jobStarted({
        runId: 'run-1',
        jobId: 'job-late',
        target,
    });

    assert.equal(lateStart.state, RetryState.IDLE);
    assert.deepEqual(lastCall(calls, 'cancelJob')?.args, [
        'job-late',
        {
            runId: 'run-1',
            chatIdentity,
            target,
            reason: 'capture_aborted_before_job_started',
        },
    ]);
    assert.equal(logger.errors.length, 0);
});

test('restoreRunning resumes an active backend job directly into RUNNING on boot', () => {
    const { fsm, calls } = createHarness({
        initialIntent: {
            mode: 'toggle',
            engaged: true,
            singleTarget: null,
            settings: {
                nativeGraceSeconds: 30,
            },
        },
    });

    const chatIdentity = {
        kind: 'character',
        chatId: 'chat-1',
        groupId: null,
    };

    const running = fsm.restoreRunning({
        status: {
            jobId: 'job-1',
            runId: 'run-restore',
            state: 'running',
            chatIdentity,
        },
    });

    assert.equal(running.state, RetryState.RUNNING);
    assert.equal(running.jobId, 'job-1');
    assert.equal(running.runId, 'run-restore');
    assert.equal(running.pollingToken, 'poll:job-1');
    assert.deepEqual(lastCall(calls, 'startPolling')?.args, [
        'job-1',
        lastCall(calls, 'startPolling')?.args[1],
        lastCall(calls, 'startPolling')?.args[2],
        lastCall(calls, 'startPolling')?.args[3],
    ]);
    assert.equal(typeof lastCall(calls, 'startPolling')?.args[3], 'function');
    assert.deepEqual(lastCall(calls, 'setGeneratingIndicator')?.args[0], chatIdentity);
});

test('restoreRunning from CAPTURING adopts an attached running job without cancellation cleanup', () => {
    const { fsm, calls } = createHarness();
    const chatIdentity = {
        kind: 'character',
        chatId: 'chat-1',
        groupId: null,
    };
    const target = {
        chatIdentity,
        assistantAnchorId: 'assistant-anchor-1',
    };

    fsm.arm({
        chatIdentity,
        intent: {
            mode: 'toggle',
        },
        target,
    });
    fsm.capture({
        request: {
            messages: ['hello'],
        },
        target,
    });

    const running = fsm.restoreRunning({
        status: {
            jobId: 'job-attach',
            runId: 'run-1',
            state: 'running',
            chatIdentity,
        },
        target,
    });

    assert.equal(running.state, RetryState.RUNNING);
    assert.equal(running.jobId, 'job-attach');
    assert.equal(lastCall(calls, 'unsubscribeNativeObserver'), null);
    assert.equal(lastCall(calls, 'cancelJob'), null);
});

test('userStop from RUNNING cancels the backend job, disengages intent, and returns to IDLE', () => {
    const { fsm, calls, getIntent } = createHarness();
    const chatIdentity = {
        kind: 'character',
        chatId: 'chat-1',
        groupId: null,
    };
    const target = {
        chatIdentity,
        assistantAnchorId: 'assistant-anchor-1',
    };

    fsm.arm({
        chatIdentity,
        intent: {
            mode: 'toggle',
        },
        target,
    });
    fsm.capture({
        request: {
            messages: ['hello'],
        },
        target,
    });
    fsm.jobStarted({
        jobId: 'job-1',
        target,
    });

    const stopped = fsm.userStop();

    assert.equal(stopped.state, RetryState.IDLE);
    assert.equal(getIntent().engaged, false);
    assert.equal(stopped.jobId, null);
    assert.equal(stopped.runId, null);
    assert.equal(stopped.lastTerminalResult.outcome, 'cancelled');
    assert.deepEqual(lastCall(calls, 'stopPolling')?.args, ['poll:job-1']);
    assert.deepEqual(lastCall(calls, 'clearGeneratingIndicator')?.args[0], chatIdentity);
    assert.deepEqual(lastCall(calls, 'cancelJob')?.args, [
        'job-1',
        {
            runId: 'run-1',
            chatIdentity,
            target,
        },
    ]);
});

test('running context shape excludes terminalError key', () => {
    const ctx = createRunningContext({
        state: RetryState.RUNNING,
        intent: { mode: 'toggle', engaged: true, singleTarget: null, settings: {} },
        chatIdentity: null,
        runId: 'run-1',
        jobId: 'job-1',
        pollingToken: null,
    });
    assert.equal(Object.prototype.hasOwnProperty.call(ctx, 'terminalError'), false);
});

test('running context rejects terminalError writes in dev mode', () => {
    const previousDev = globalThis.__RM_DEV__;
    globalThis.__RM_DEV__ = true;
    try {
        const ctx = createRunningContext({
            state: RetryState.RUNNING,
            intent: { mode: 'toggle', engaged: true, singleTarget: null, settings: {} },
            chatIdentity: null,
            runId: 'run-1',
            jobId: 'job-1',
            pollingToken: null,
        });
        assert.throws(() => {
            ctx.terminalError = { code: 'retry_job_failed', message: 'bad', detail: '' };
        });
    } finally {
        globalThis.__RM_DEV__ = previousDev;
    }
});

test('healthy running polls clear runError even with no version bump', async () => {
    const { fsm, emitPolledStatus, setApplyAcceptedOutputResult } = createHarness();
    const chatIdentity = { kind: 'character', chatId: 'chat-1', groupId: null };
    const target = { chatIdentity, assistantAnchorId: 'assistant-anchor-1' };
    fsm.arm({ chatIdentity, intent: { mode: 'toggle' }, target });
    fsm.capture({
        request: { messages: ['hello'] },
        fingerprint: { chatIdentity, userMessageText: 'hello' },
        target,
    });
    fsm.jobStarted({ jobId: 'job-1', target });
    setApplyAcceptedOutputResult({ ok: false });
    await emitPolledStatus({ jobId: 'job-1', state: 'running', targetMessageVersion: 2 });
    await Promise.resolve();
    assert.equal(fsm.getContext().runError?.code, 'render_apply_failed');

    setApplyAcceptedOutputResult({ ok: true });
    await emitPolledStatus({ jobId: 'job-1', state: 'running', targetMessageVersion: 2 });
    await Promise.resolve();
    assert.equal(fsm.getContext().runError, null);
});

test('running apply-success branch clears existing runError', async () => {
    const { fsm, emitPolledStatus, setApplyAcceptedOutputResult } = createHarness();
    const chatIdentity = { kind: 'character', chatId: 'chat-1', groupId: null };
    const target = { chatIdentity, assistantAnchorId: 'assistant-anchor-1' };
    fsm.arm({ chatIdentity, intent: { mode: 'toggle' }, target });
    fsm.capture({
        request: { messages: ['hello'] },
        fingerprint: { chatIdentity, userMessageText: 'hello' },
        target,
    });
    fsm.jobStarted({ jobId: 'job-1', target });
    setApplyAcceptedOutputResult({ ok: false });
    await emitPolledStatus({ jobId: 'job-1', state: 'running', targetMessageVersion: 2 });
    await Promise.resolve();
    assert.equal(fsm.getContext().runError?.code, 'render_apply_failed');

    setApplyAcceptedOutputResult({ ok: true });
    await emitPolledStatus({ jobId: 'job-1', state: 'running', targetMessageVersion: 3 });
    await Promise.resolve();
    assert.equal(fsm.getContext().runError, null);
});

test('running hidden-tab queue branch clears runError while deferring render', async () => {
    const { fsm, emitPolledStatus, setApplyAcceptedOutputResult, setVisible } = createHarness();
    const chatIdentity = { kind: 'character', chatId: 'chat-1', groupId: null };
    const target = { chatIdentity, assistantAnchorId: 'assistant-anchor-1' };
    fsm.arm({ chatIdentity, intent: { mode: 'toggle' }, target });
    fsm.capture({
        request: { messages: ['hello'] },
        fingerprint: { chatIdentity, userMessageText: 'hello' },
        target,
    });
    fsm.jobStarted({ jobId: 'job-1', target });
    setApplyAcceptedOutputResult({ ok: false });
    await emitPolledStatus({ jobId: 'job-1', state: 'running', targetMessageVersion: 2 });
    await Promise.resolve();
    assert.equal(fsm.getContext().runError?.code, 'render_apply_failed');

    setVisible(false);
    await emitPolledStatus({ jobId: 'job-1', state: 'running', targetMessageVersion: 3 });
    await Promise.resolve();
    assert.equal(fsm.getContext().runError, null);
    assert.equal(Boolean(fsm.getContext().pendingVisibleRender), true);
});

test('queued final render payload does not carry terminalOutcome', async () => {
    const { fsm, emitPolledStatus, calls, setVisible } = createHarness();
    const chatIdentity = { kind: 'character', chatId: 'chat-1', groupId: null };
    const target = { chatIdentity, assistantAnchorId: 'assistant-anchor-1' };
    fsm.arm({ chatIdentity, intent: { mode: 'toggle' }, target });
    fsm.capture({
        request: { messages: ['hello'] },
        fingerprint: { chatIdentity, userMessageText: 'hello' },
        target,
    });
    fsm.jobStarted({ jobId: 'job-1', target });
    setVisible(false);
    await emitPolledStatus({
        jobId: 'job-1',
        state: 'completed',
        targetMessageVersion: 1,
        status: 'done',
    });
    const queuedRender = fsm.getContext().pendingVisibleRender;
    assert.equal(Boolean(queuedRender), true);
    assert.equal(Object.prototype.hasOwnProperty.call(queuedRender, 'terminalOutcome'), false);
});

test('toast scope lifecycle resets at running entry and clears on terminal transition', () => {
    const { fsm } = createHarness();
    const chatIdentity = { kind: 'character', chatId: 'chat-1', groupId: null };
    const target = { chatIdentity, assistantAnchorId: 'assistant-anchor-1' };

    fsm.arm({ chatIdentity, intent: { mode: 'toggle' }, target });
    fsm.capture({
        request: { messages: ['hello'] },
        fingerprint: { chatIdentity, userMessageText: 'hello' },
        target,
    });
    fsm.jobStarted({ jobId: 'job-1', target });
    assert.equal(fsm.getToastScope()?.jobId, 'job-1');

    fsm.jobCompleted({
        status: { state: 'completed', jobId: 'job-1' },
    });
    assert.equal(fsm.getToastScope(), null);
});

test('jobStarted clears the previous run lastTerminalResult so its terminal status cannot leak into the new RUNNING context', async () => {
    const { fsm, emitPolledStatus } = createHarness({
        initialIntent: {
            mode: 'toggle',
            engaged: true,
            singleTarget: null,
            settings: { targetAcceptedCount: 2, nativeGraceSeconds: 30 },
        },
    });
    const chatIdentity = { kind: 'character', chatId: 'chat-1', groupId: null };
    const target = { chatIdentity, assistantAnchorId: 'assistant-anchor-1' };

    fsm.arm({ chatIdentity, intent: { mode: 'toggle' }, target });
    fsm.capture({
        request: { messages: ['hi'] },
        fingerprint: { chatIdentity, userMessageText: 'hi' },
        target,
    });
    fsm.jobStarted({ jobId: 'job-1', target });
    await emitPolledStatus({
        jobId: 'job-1',
        state: 'completed',
        acceptedCount: 2,
        targetAcceptedCount: 2,
    });

    const armedCtx = fsm.getContext();
    assert.equal(armedCtx.state, RetryState.ARMED);
    assert.equal(armedCtx.lastTerminalResult?.outcome, 'completed');

    fsm.capture({
        request: { messages: ['next'] },
        fingerprint: { chatIdentity, userMessageText: 'next' },
        target,
    });
    fsm.jobStarted({ jobId: 'job-2', target });

    const runningCtx = fsm.getContext();
    assert.equal(runningCtx.state, RetryState.RUNNING);
    assert.equal(runningCtx.jobId, 'job-2');
    // The new RUNNING context must not inherit the previous run's terminal
    // snapshot. Otherwise `deriveUiState` would fall back to it and re-fire
    // the old "Completed N/T" toast against the freshly reset toast scope —
    // exactly the symptom on first capture after a completed retry.
    assert.equal(runningCtx.lastTerminalResult, null);
});

test('manual arm clears the previous run lastTerminalResult so stats refresh on Start', () => {
    const { fsm } = createHarness();
    const chatIdentity = { kind: 'character', chatId: 'chat-1', groupId: null };
    const target = { chatIdentity, assistantAnchorId: 'assistant-anchor-1' };

    fsm.arm({ chatIdentity, intent: { mode: 'toggle' }, target });
    fsm.capture({
        request: { messages: ['hi'] },
        fingerprint: { chatIdentity, userMessageText: 'hi' },
        target,
    });
    fsm.jobStarted({ jobId: 'job-1', target });
    fsm.userStop();
    const idleCtx = fsm.getContext();
    assert.equal(idleCtx.state, RetryState.IDLE);
    assert.equal(idleCtx.lastTerminalResult?.outcome, 'cancelled');

    fsm.arm({ chatIdentity, intent: { mode: 'toggle' }, target });
    const armedCtx = fsm.getContext();
    assert.equal(armedCtx.state, RetryState.ARMED);
    // A manual Start press must produce a clean armed phase so the panel
    // does not surface the previous run's stats or terminal toast.
    assert.equal(armedCtx.lastTerminalResult, null);
    assert.equal(armedCtx.terminalError, null);
});

test('jobFailed auto-rearm into ARMED clears terminalError so the panel error box is not lit by the previous failure', () => {
    const { fsm } = createHarness({
        initialIntent: {
            mode: 'toggle',
            engaged: false,
            singleTarget: null,
            settings: {},
        },
    });
    const chatIdentity = { kind: 'character', chatId: 'chat-1', groupId: null };

    fsm.arm({ chatIdentity, intent: { mode: 'toggle' } });
    fsm.capture({ request: { messages: ['hello'] } });
    const failed = fsm.jobFailed({ error: new Error('backend handoff failed') });

    assert.equal(failed.state, RetryState.ARMED);
    // The error info is preserved on `lastTerminalResult.error` for diagnostics
    // and the terminal toast still fires. The panel `terminalError` slot must
    // be empty so `selectUiError` does not light the error box for the next
    // armed phase.
    assert.equal(failed.terminalError, null);
    assert.equal(failed.lastTerminalResult?.outcome, 'failed');
    assert.equal(failed.lastTerminalResult?.error?.code, 'retry_job_failed');
});

test('jobFailed without auto-rearm into IDLE keeps terminalError so the user sees what went wrong', () => {
    const { fsm } = createHarness({
        initialIntent: {
            mode: 'single',
            engaged: false,
            singleTarget: null,
            settings: {},
        },
    });
    const chatIdentity = { kind: 'character', chatId: 'chat-1', groupId: null };

    fsm.arm({ chatIdentity, intent: { mode: 'single' } });
    fsm.capture({ request: { messages: ['hello'] } });
    const failed = fsm.jobFailed({ error: new Error('backend handoff failed') });

    assert.equal(failed.state, RetryState.IDLE);
    assert.equal(failed.terminalError?.code, 'retry_job_failed');
    assert.equal(failed.lastTerminalResult?.outcome, 'failed');
});

// E8: Toggle mode is global and persistent across chat switches.
// After a job completes in chat A, the FSM re-arms into ARMED. When a generation
// fires in chat B (different chatId), the FSM accepts the capture with the new
// chat identity and intent.engaged remains true throughout.
test('toggle mode: after job completes in chat A, capture in chat B starts a fresh job with engaged intent (E8)', async () => {
    const { fsm, emitPolledStatus, getIntent } = createHarness({
        initialIntent: {
            mode: 'toggle',
            engaged: true,
            singleTarget: null,
            settings: { targetAcceptedCount: 1, nativeGraceSeconds: 30 },
        },
    });

    const chatA = { kind: 'character', chatId: 'chat-A', groupId: null };
    const chatB = { kind: 'character', chatId: 'chat-B', groupId: null };
    const targetA = { chatIdentity: chatA, assistantAnchorId: 'anchor-A' };
    const targetB = { chatIdentity: chatB, assistantAnchorId: 'anchor-B' };

    // Run a full job in chat A.
    fsm.arm({ chatIdentity: chatA, intent: { mode: 'toggle' }, target: targetA });
    assert.equal(fsm.getContext().state, RetryState.ARMED);

    fsm.capture({ request: { messages: ['hi'] }, fingerprint: { chatIdentity: chatA, userMessageText: 'hi' }, target: targetA });
    fsm.jobStarted({ jobId: 'job-A', target: targetA });
    assert.equal(fsm.getContext().state, RetryState.RUNNING);

    // Complete the job — FSM should re-arm in toggle mode.
    await emitPolledStatus({ jobId: 'job-A', state: 'completed', targetMessageVersion: 1 });
    await Promise.resolve();
    assert.equal(fsm.getContext().state, RetryState.ARMED, 'toggle mode must re-arm after job completion');

    // Intent must still be engaged after the job completes and re-arms.
    assert.equal(getIntent().engaged, true, 'intent.engaged must remain true across the re-arm');
    assert.equal(getIntent().mode, 'toggle');

    // User switches to chat B and triggers a generation there.
    // In real usage, the capture subscriber passes chatIdentity from the live ST context.
    fsm.capture({ chatIdentity: chatB, request: { messages: ['hello'] }, fingerprint: { chatIdentity: chatB, userMessageText: 'hello' }, target: targetB });
    assert.equal(fsm.getContext().state, RetryState.CAPTURING, 'FSM must enter CAPTURING in chat B');

    // Job starts in chat B.
    fsm.jobStarted({ jobId: 'job-B', chatIdentity: chatB, target: targetB });
    const runningCtx = fsm.getContext();
    assert.equal(runningCtx.state, RetryState.RUNNING);
    assert.equal(runningCtx.chatIdentity?.chatId, 'chat-B', 'RUNNING job must be bound to chat B');
    assert.equal(runningCtx.jobId, 'job-B');

    // Intent stays engaged throughout.
    assert.equal(getIntent().engaged, true, 'intent.engaged must remain true in chat B run');
    assert.equal(getIntent().mode, 'toggle');
});

test('handlePollingStatus ignores a completed status whose jobId does not match the active job', async () => {
    const { fsm, emitPolledStatus } = createHarness();
    const chatIdentity = { kind: 'character', chatId: 'chat-1', groupId: null };
    const target = { chatIdentity, assistantAnchorId: 'anchor-1' };

    fsm.arm({ chatIdentity, intent: { mode: 'toggle' }, target });
    fsm.capture({ request: { messages: ['hello'] }, fingerprint: { chatIdentity, userMessageText: 'hello' }, target });
    fsm.jobStarted({ jobId: 'job-1', target });
    assert.equal(fsm.getContext().state, RetryState.RUNNING);
    assert.equal(fsm.getContext().jobId, 'job-1');

    await emitPolledStatus({ jobId: 'job-STALE', state: 'completed', targetMessageVersion: 0 });
    await Promise.resolve();

    assert.equal(fsm.getContext().state, RetryState.RUNNING, 'mismatched jobId must not transition FSM to terminal');
    assert.equal(fsm.getContext().jobId, 'job-1');
});

test('stale completed status from a prior job does not affect a newly started job', async () => {
    const { fsm, emitPolledStatus } = createHarness({
        initialIntent: { mode: 'toggle', engaged: true, settings: { targetAcceptedCount: 2, nativeGraceSeconds: 30 } },
    });
    const chatIdentity = { kind: 'character', chatId: 'chat-1', groupId: null };
    const target = { chatIdentity, assistantAnchorId: 'anchor-1' };

    fsm.arm({ chatIdentity, intent: { mode: 'toggle' }, target });
    fsm.capture({ request: { messages: ['hi'] }, fingerprint: { chatIdentity, userMessageText: 'hi' }, target });
    fsm.jobStarted({ jobId: 'job-A', target });
    assert.equal(fsm.getContext().state, RetryState.RUNNING);

    await emitPolledStatus({ jobId: 'job-A', state: 'completed', targetMessageVersion: 1 });
    await Promise.resolve();
    assert.equal(fsm.getContext().state, RetryState.ARMED, 'toggle mode must re-arm after job-A completes');

    fsm.capture({ request: { messages: ['hello'] }, fingerprint: { chatIdentity, userMessageText: 'hello' }, target });
    fsm.jobStarted({ jobId: 'job-B', target });
    assert.equal(fsm.getContext().state, RetryState.RUNNING);
    assert.equal(fsm.getContext().jobId, 'job-B');

    await emitPolledStatus({ jobId: 'job-A', state: 'completed', targetMessageVersion: 0 });
    await Promise.resolve();

    assert.equal(fsm.getContext().state, RetryState.RUNNING, 'stale job-A completed poll must not terminate job-B');
    assert.equal(fsm.getContext().jobId, 'job-B');
});

test('observeBackendStatus rejects out-of-order revisions without applying stale output', async () => {
    const { fsm, calls } = createHarness();
    const chatIdentity = { kind: 'character', chatId: 'chat-1', groupId: null };
    const target = { chatIdentity, assistantAnchorId: 'anchor-1' };

    fsm.arm({ chatIdentity, intent: { mode: 'toggle' }, target });
    fsm.capture({ request: { messages: ['hi'] }, fingerprint: { chatIdentity, userMessageText: 'hi' }, target });
    fsm.jobStarted({ jobId: 'job-1', target });

    const runId = fsm.getContext().runId;
    const accepted = await fsm.observeBackendStatus({
        jobId: 'job-1',
        runId,
        state: 'running',
        revision: 2,
        targetMessageVersion: 1,
    });
    const stale = await fsm.observeBackendStatus({
        jobId: 'job-1',
        runId,
        state: 'running',
        revision: 1,
        targetMessageVersion: 2,
    });

    assert.equal(accepted.accepted, true);
    assert.equal(stale.accepted, false);
    assert.equal(stale.reason, 'out_of_order_revision');
    assert.equal(fsm.getContext().lastAppliedVersion, 1);
    assert.equal(calls.filter((entry) => entry.method === 'applyAcceptedOutput').length, 1);
});

test('observeBackendStatus rejects stale terminal revisions after newer running status', async () => {
    const { fsm } = createHarness();
    const chatIdentity = { kind: 'character', chatId: 'chat-1', groupId: null };
    const target = { chatIdentity, assistantAnchorId: 'anchor-1' };

    fsm.arm({ chatIdentity, intent: { mode: 'toggle' }, target });
    fsm.capture({ request: { messages: ['hi'] }, fingerprint: { chatIdentity, userMessageText: 'hi' }, target });
    fsm.jobStarted({ jobId: 'job-1', target });

    const runId = fsm.getContext().runId;
    await fsm.observeBackendStatus({ jobId: 'job-1', runId, state: 'running', revision: 4, targetMessageVersion: 0 });
    const staleTerminal = await fsm.observeBackendStatus({ jobId: 'job-1', runId, state: 'completed', revision: 3, targetMessageVersion: 0 });

    assert.equal(staleTerminal.accepted, false);
    assert.equal(staleTerminal.reason, 'out_of_order_revision');
    assert.equal(fsm.getContext().state, RetryState.RUNNING);
    assert.equal(fsm.getContext().jobId, 'job-1');
});

test('completed status queues behind an in-flight running apply and completes after the flush', async () => {
    const { fsm, calls, setApplyAcceptedOutputResult } = createHarness();
    const chatIdentity = { kind: 'character', chatId: 'chat-1', groupId: null };
    const target = { chatIdentity, assistantAnchorId: 'anchor-1' };

    fsm.arm({ chatIdentity, intent: { mode: 'toggle' }, target });
    fsm.capture({ request: { messages: ['hi'] }, fingerprint: { chatIdentity, userMessageText: 'hi' }, target });
    fsm.jobStarted({ jobId: 'job-1', target });

    let resolveFirstApply;
    const firstApply = new Promise((resolve) => {
        resolveFirstApply = resolve;
    });
    setApplyAcceptedOutputResult(firstApply);

    const runId = fsm.getContext().runId;
    const runningPromise = fsm.observeBackendStatus({
        jobId: 'job-1',
        runId,
        state: 'running',
        revision: 1,
        targetMessageVersion: 1,
    });
    await Promise.resolve();
    assert.equal(calls.filter((entry) => entry.method === 'applyAcceptedOutput').length, 1);

    const completedResult = await fsm.observeBackendStatus({
        jobId: 'job-1',
        runId,
        state: 'completed',
        revision: 2,
        acceptedCount: 2,
        targetAcceptedCount: 2,
        targetMessageVersion: 2,
    });
    assert.equal(completedResult.accepted, true);
    assert.equal(
        calls.filter((entry) => entry.method === 'applyAcceptedOutput').length,
        1,
        'terminal output must be queued instead of applying concurrently',
    );

    setApplyAcceptedOutputResult({ ok: true });
    resolveFirstApply({ ok: true });
    await runningPromise;

    assert.equal(
        calls.filter((entry) => entry.method === 'applyAcceptedOutput').length,
        2,
        'queued terminal output flushes after the running apply settles',
    );
    const context = fsm.getContext();
    assert.equal(context.state, RetryState.ARMED);
    assert.equal(context.lastTerminalResult?.status?.targetMessageVersion, 2);
});

test('duplicate completed statuses coalesce while terminal apply is in flight', async () => {
    const { fsm, calls, setApplyAcceptedOutputResult } = createHarness();
    const chatIdentity = { kind: 'character', chatId: 'chat-1', groupId: null };
    const target = { chatIdentity, assistantAnchorId: 'anchor-1' };

    fsm.arm({ chatIdentity, intent: { mode: 'toggle' }, target });
    fsm.capture({ request: { messages: ['hi'] }, fingerprint: { chatIdentity, userMessageText: 'hi' }, target });
    fsm.jobStarted({ jobId: 'job-1', target });

    let resolveTerminalApply;
    const terminalApply = new Promise((resolve) => {
        resolveTerminalApply = resolve;
    });
    setApplyAcceptedOutputResult(terminalApply);

    const runId = fsm.getContext().runId;
    const first = fsm.observeBackendStatus({
        jobId: 'job-1',
        runId,
        state: 'completed',
        revision: 1,
        acceptedCount: 2,
        targetAcceptedCount: 2,
        targetMessageVersion: 2,
    });
    await Promise.resolve();
    assert.equal(calls.filter((entry) => entry.method === 'applyAcceptedOutput').length, 1);

    const second = await fsm.observeBackendStatus({
        jobId: 'job-1',
        runId,
        state: 'completed',
        revision: 2,
        acceptedCount: 2,
        targetAcceptedCount: 2,
        targetMessageVersion: 2,
    });
    assert.equal(second.accepted, true);
    assert.equal(
        calls.filter((entry) => entry.method === 'applyAcceptedOutput').length,
        1,
        'second terminal status must not start a duplicate terminal apply',
    );

    resolveTerminalApply({ ok: true });
    await first;

    assert.equal(calls.filter((entry) => entry.method === 'applyAcceptedOutput').length, 1);
    assert.equal(fsm.getContext().state, RetryState.ARMED);
});

test('observeBackendStatus rejects active job responses for a different runId', async () => {
    const { fsm } = createHarness();
    const chatIdentity = { kind: 'character', chatId: 'chat-1', groupId: null };
    const target = { chatIdentity, assistantAnchorId: 'anchor-1' };

    fsm.arm({ chatIdentity, intent: { mode: 'toggle' }, target });
    fsm.capture({ request: { messages: ['hi'] }, fingerprint: { chatIdentity, userMessageText: 'hi' }, target });
    fsm.jobStarted({ jobId: 'job-1', target });

    const result = await fsm.observeBackendStatus({
        jobId: 'job-1',
        runId: 'run-stale',
        state: 'running',
        revision: 1,
        targetMessageVersion: 1,
    });

    assert.equal(result.accepted, false);
    assert.equal(result.reason, 'run_id_mismatch');
    assert.equal(fsm.getContext().lastAppliedVersion, 0);
});

test('enterRunning calls stopAllExcept with the newly allocated polling token', () => {
    const { fsm, calls } = createHarness();
    const chatIdentity = { kind: 'character', chatId: 'chat-1', groupId: null };
    const target = { chatIdentity, assistantAnchorId: 'anchor-1' };

    fsm.arm({ chatIdentity, intent: { mode: 'toggle' }, target });
    fsm.capture({ request: { messages: ['hi'] }, fingerprint: { chatIdentity, userMessageText: 'hi' }, target });
    fsm.jobStarted({ jobId: 'job-1', target });

    assert.equal(fsm.getContext().state, RetryState.RUNNING);
    const stopAllExceptCall = lastCall(calls, 'stopAllExcept');
    assert.ok(stopAllExceptCall, 'stopAllExcept must be called on enterRunning');
    assert.equal(stopAllExceptCall.args[0], 'poll:job-1', 'stopAllExcept must receive the new polling token');
});

test('goal=1 native-accepted completion produces lastTerminalResult.kind === native_accepted', async () => {
    const { fsm, emitPolledStatus } = createHarness({
        initialIntent: {
            mode: 'toggle',
            engaged: true,
            singleTarget: null,
            settings: { targetAcceptedCount: 1, nativeGraceSeconds: 30 },
        },
    });
    const chatIdentity = { kind: 'character', chatId: 'chat-1', groupId: null };
    const target = { chatIdentity, assistantAnchorId: 'anchor-1' };

    fsm.arm({ chatIdentity, intent: { mode: 'toggle' }, target });
    fsm.capture({ request: { messages: ['hi'] }, fingerprint: { chatIdentity, userMessageText: 'hi' }, target });
    fsm.jobStarted({ jobId: 'job-1', target });

    await emitPolledStatus({
        jobId: 'job-1',
        state: 'completed',
        acceptedCount: 1,
        targetAcceptedCount: 1,
        targetMessageVersion: 0,
    });

    const ctx = fsm.getContext();
    assert.equal(ctx.lastTerminalResult?.kind, 'native_accepted', 'goal=1 native-accepted must produce kind=native_accepted');
});

test('multi-attempt completion where output is written (targetMessageVersion > 0) produces lastTerminalResult.kind === completed', async () => {
    const { fsm, emitPolledStatus } = createHarness({
        initialIntent: {
            mode: 'toggle',
            engaged: true,
            singleTarget: null,
            settings: { targetAcceptedCount: 2, nativeGraceSeconds: 30 },
        },
    });
    const chatIdentity = { kind: 'character', chatId: 'chat-1', groupId: null };
    const target = { chatIdentity, assistantAnchorId: 'anchor-1' };

    fsm.arm({ chatIdentity, intent: { mode: 'toggle' }, target });
    fsm.capture({ request: { messages: ['hi'] }, fingerprint: { chatIdentity, userMessageText: 'hi' }, target });
    fsm.jobStarted({ jobId: 'job-1', target });

    await emitPolledStatus({
        jobId: 'job-1',
        state: 'completed',
        acceptedCount: 2,
        targetAcceptedCount: 2,
        targetMessageVersion: 2,
    });

    const ctx = fsm.getContext();
    assert.equal(ctx.lastTerminalResult?.kind, 'completed', 'multi-attempt completion with written output must produce kind=completed');
});
