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
    let visible = true;
    let applyAcceptedOutputResult = { ok: true };
    let applyAcceptedOutputError = null;
    let flushPendingVisibleRenderResult = { ok: true };
    let flushPendingVisibleRenderError = null;
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
        enableInteractionGuard() {
            calls.push({ port: 'st', method: 'enableInteractionGuard', args: [] });
        },
        disableInteractionGuard() {
            calls.push({ port: 'st', method: 'disableInteractionGuard', args: [] });
        },
        setGeneratingIndicator(payload) {
            calls.push({ port: 'st', method: 'setGeneratingIndicator', args: [payload] });
        },
        clearGeneratingIndicator(payload) {
            calls.push({ port: 'st', method: 'clearGeneratingIndicator', args: [payload] });
        },
        flushPendingVisibleRender(payload) {
            calls.push({ port: 'st', method: 'flushPendingVisibleRender', args: [payload] });
            if (flushPendingVisibleRenderError) {
                return Promise.reject(flushPendingVisibleRenderError);
            }
            return Promise.resolve(flushPendingVisibleRenderResult);
        },
        isVisible() {
            calls.push({ port: 'st', method: 'isVisible', args: [] });
            return visible;
        },
        queueVisibleRender(payload) {
            calls.push({ port: 'st', method: 'queueVisibleRender', args: [payload] });
            return payload;
        },
        applyAcceptedOutput(payload) {
            calls.push({ port: 'st', method: 'applyAcceptedOutput', args: [payload] });
            if (applyAcceptedOutputError) {
                return Promise.reject(applyAcceptedOutputError);
            }
            return Promise.resolve(applyAcceptedOutputResult);
        },
        guardedReload() {
            calls.push({ port: 'st', method: 'guardedReload', args: [] });
            return Promise.resolve(true);
        },
    };

    const backendPort = {
        startJob(payload) {
            calls.push({ port: 'backend', method: 'startJob', args: [payload] });
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
        setApplyAcceptedOutputResult(nextResult) {
            applyAcceptedOutputResult = nextResult;
        },
        setApplyAcceptedOutputError(nextError) {
            applyAcceptedOutputError = nextError;
        },
        setFlushPendingVisibleRenderResult(nextResult) {
            flushPendingVisibleRenderResult = nextResult;
        },
        setFlushPendingVisibleRenderError(nextError) {
            flushPendingVisibleRenderError = nextError;
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
        lastKnownTargetMessageVersion: 0,
        lastAppliedVersion: 0,
        pendingVisibleRender: null,
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

    const resumed = fsm.resume({
        reason: 'window.focused',
        isVisible: true,
        pendingVisibleRender: {
            targetVersion: 3,
        },
    });

    await Promise.resolve();

    assert.equal(resumed.state, RetryState.RUNNING);
    assert.equal(fsm.getContext().pendingVisibleRender, null);
    assert.equal(calls.filter((entry) => entry.method === 'startPolling').length, pollingStartsBeforeResume);
    assert.equal(calls.filter((entry) => entry.method === 'setGeneratingIndicator').length, indicatorSetsBeforeResume);
    assert.deepEqual(lastCall(calls, 'flushPendingVisibleRender')?.args[0], {
        targetVersion: 3,
    });
    assert.deepEqual(lastCall(calls, 'reportFrontendPresence')?.args, [
        'job-1',
        {
            reason: 'window.focused',
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
    const resumed = fsm.resume({
        reason: 'window.focused',
        isVisible: true,
        pendingVisibleRender,
    });

    await Promise.resolve();
    await Promise.resolve();

    assert.equal(resumed.state, RetryState.RUNNING);
    assert.deepEqual(fsm.getContext().pendingVisibleRender, pendingVisibleRender);
    assert.equal(fsm.getContext().lastAppliedVersion, 0);
    assert.equal(calls.filter((entry) => entry.method === 'guardedReload').length, 1);
});

test('resume flush with result.ok === false triggers guardedReload and clears pendingVisibleRender', async () => {
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
    const resumed = fsm.resume({
        reason: 'window.focused',
        isVisible: true,
        pendingVisibleRender,
    });

    await Promise.resolve();
    await Promise.resolve();

    assert.equal(resumed.state, RetryState.RUNNING);
    assert.equal(calls.filter((entry) => entry.method === 'guardedReload').length, 1);
    assert.equal(fsm.getContext().pendingVisibleRender, null);
});

test('resume keeps pending renders queued while the tab is still hidden', () => {
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

    const resumed = fsm.resume({
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
    assert.equal(calls.some((entry) => entry.method === 'flushPendingVisibleRender'), false);
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

test('CURRENTLY FAILING (pre-fix): running context shape excludes terminalError key', () => {
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

test('CURRENTLY FAILING (pre-fix): running context rejects terminalError writes in dev mode', () => {
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

test('CURRENTLY FAILING (pre-fix): healthy running polls clear runError even with no version bump', async () => {
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

test('CURRENTLY FAILING (pre-fix): queued final render payload does not carry terminalOutcome', async () => {
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
    const queuedCall = calls.filter((entry) => entry.method === 'queueVisibleRender').at(-1);
    assert.equal(Boolean(queuedCall), true);
    assert.equal(Object.prototype.hasOwnProperty.call(queuedCall.args[0], 'terminalOutcome'), false);
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
