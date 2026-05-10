import test from 'node:test';
import assert from 'node:assert/strict';

import { createResumeCoordinator } from './app-resume-coordinator.js';
import { RetryState } from './retry-fsm.js';

function createFakeWindow() {
    let nextHandle = 1;
    const handles = new Map();
    return {
        setTimeout(callback, ms) {
            const handle = nextHandle++;
            handles.set(handle, { callback, ms });
            return handle;
        },
        clearTimeout(handle) {
            handles.delete(handle);
        },
        runTimeout(handle) {
            const entry = handles.get(handle);
            if (!entry) return;
            handles.delete(handle);
            entry.callback();
        },
        runAllTimeouts() {
            for (const [handle, entry] of [...handles.entries()]) {
                handles.delete(handle);
                entry.callback();
            }
        },
        pendingHandles() {
            return [...handles.keys()];
        },
    };
}

function createFsmStub({ state = RetryState.IDLE, context = {} } = {}) {
    let currentState = state;
    let currentContext = { state: currentState, jobId: null, ...context };
    return {
        getState() { return currentState; },
        getContext() { return { ...currentContext, state: currentState }; },
        setState(nextState) { currentState = nextState; },
        setContext(patch) { currentContext = { ...currentContext, ...patch }; },
        resume() {},
    };
}

test('page.hidden reports frontend presence when running', () => {
    const presenceCalls = [];
    const fsm = createFsmStub({ state: RetryState.RUNNING, context: { jobId: 'job-1', chatIdentity: { chatId: 'c1' } } });
    const coordinator = createResumeCoordinator({
        retryFsm: fsm,
        runtime: { controlError: null },
        backendPort: {
            reportFrontendPresence: (jobId, payload) => {
                presenceCalls.push({ jobId, payload });
                return Promise.resolve();
            },
        },
        stPort: { isVisible: () => false },
        restoreController: {},
        ensurePanelMounted: () => {},
        syncRuntimeFromFsm: () => {},
        updateActiveJob: () => {},
        render: () => {},
        getCurrentChatIdentity: () => ({ chatId: 'c1' }),
        toStructuredError: (e) => e,
        windowRef: createFakeWindow(),
    });

    coordinator.dispatch('page.hidden');
    assert.equal(presenceCalls.length, 1);
    assert.equal(presenceCalls[0].jobId, 'job-1');
    assert.equal(presenceCalls[0].payload.reason, 'page.hidden');
    assert.equal(presenceCalls[0].payload.visibilityState, 'hidden');
});

test('page.hidden does nothing while idle', () => {
    const presenceCalls = [];
    const fsm = createFsmStub({ state: RetryState.IDLE });
    const coordinator = createResumeCoordinator({
        retryFsm: fsm,
        runtime: { controlError: null },
        backendPort: {
            reportFrontendPresence: (jobId, payload) => {
                presenceCalls.push({ jobId, payload });
                return Promise.resolve();
            },
        },
        stPort: { isVisible: () => false },
        restoreController: {},
        ensurePanelMounted: () => {},
        syncRuntimeFromFsm: () => {},
        updateActiveJob: () => {},
        render: () => {},
        getCurrentChatIdentity: () => null,
        toStructuredError: (e) => e,
        windowRef: createFakeWindow(),
    });

    coordinator.dispatch('page.hidden');
    assert.equal(presenceCalls.length, 0);
});

test('non-RUNNING return calls reconcileLatestForCurrentChat with allowReload:true', async () => {
    const reconcileCalls = [];
    const renderCalls = [];
    const fsm = createFsmStub({ state: RetryState.IDLE });
    const coordinator = createResumeCoordinator({
        retryFsm: fsm,
        runtime: { controlError: null },
        backendPort: {},
        stPort: { isVisible: () => true },
        restoreController: {
            reconcileLatestForCurrentChat: (options) => {
                reconcileCalls.push(options);
                return Promise.resolve({ ok: true });
            },
        },
        ensurePanelMounted: () => {},
        syncRuntimeFromFsm: () => {},
        updateActiveJob: () => {},
        render: () => { renderCalls.push(true); },
        getCurrentChatIdentity: () => ({ chatId: 'c1' }),
        toStructuredError: (e) => e,
        windowRef: createFakeWindow(),
    });

    coordinator.dispatch('page.visible');
    // Wait one microtask + one macrotask cycle so the .then() callback runs.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(reconcileCalls.length, 1);
    assert.equal(reconcileCalls[0].allowReload, true);
    assert.equal(reconcileCalls[0].reason, 'page.visible');
    assert.ok(renderCalls.length >= 1);
});

test('a burst of visibility/focus/online signals only triggers one reconcile', async () => {
    const reconcileCalls = [];
    const fsm = createFsmStub({ state: RetryState.IDLE });
    const fakeWindow = createFakeWindow();
    const coordinator = createResumeCoordinator({
        retryFsm: fsm,
        runtime: { controlError: null },
        backendPort: {},
        stPort: { isVisible: () => true },
        restoreController: {
            reconcileLatestForCurrentChat: (options) => {
                reconcileCalls.push(options);
                return Promise.resolve({ ok: true });
            },
        },
        ensurePanelMounted: () => {},
        syncRuntimeFromFsm: () => {},
        updateActiveJob: () => {},
        render: () => {},
        getCurrentChatIdentity: () => ({ chatId: 'c1' }),
        toStructuredError: (e) => e,
        windowRef: fakeWindow,
    });

    coordinator.dispatch('page.visible');
    coordinator.dispatch('window.focused');
    coordinator.dispatch('network.online');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(reconcileCalls.length, 1, 'guard should coalesce the burst');

    // Once the guard expires, the next return signal can run again.
    fakeWindow.runAllTimeouts();
    coordinator.dispatch('window.focused');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(reconcileCalls.length, 2);
});

test('RUNNING return path awaits retryFsm.resume before the explicit return poll', async () => {
    const pollCalls = [];
    const order = [];
    const fsm = createFsmStub({
        state: RetryState.RUNNING,
        context: { jobId: 'job-2', chatIdentity: { chatId: 'c1' }, pendingVisibleRender: null },
    });
    let resumeArgs = null;
    let releaseResume;
    const resumeBlocker = new Promise((resolve) => {
        releaseResume = resolve;
    });
    fsm.resume = async (args) => {
        resumeArgs = args;
        order.push('resume-start');
        await resumeBlocker;
        order.push('resume-finish');
    };

    const updateActiveJobCalls = [];
    const renderCalls = [];
    const coordinator = createResumeCoordinator({
        retryFsm: fsm,
        runtime: { controlError: null },
        backendPort: {
            pollStatus: (jobId) => {
                order.push('poll');
                pollCalls.push(jobId);
                return Promise.resolve({ jobId, state: 'running', acceptedCount: 1 });
            },
        },
        stPort: { isVisible: () => true },
        restoreController: { reconcileLatestForCurrentChat: () => Promise.resolve({ ok: true }) },
        ensurePanelMounted: () => {},
        syncRuntimeFromFsm: () => { order.push('sync'); },
        updateActiveJob: (status) => {
            order.push('update');
            updateActiveJobCalls.push(status);
        },
        render: () => {
            order.push('render');
            renderCalls.push(true);
        },
        getCurrentChatIdentity: () => ({ chatId: 'c1' }),
        toStructuredError: (e) => e,
        windowRef: createFakeWindow(),
    });

    coordinator.dispatch('page.visible');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(pollCalls, [], 'return poll must wait for resume() to finish');

    releaseResume();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.ok(resumeArgs, 'retryFsm.resume must be called');
    assert.equal(resumeArgs.reason, 'page.visible');
    assert.deepEqual(pollCalls, ['job-2']);
    assert.equal(updateActiveJobCalls.length, 1);
    assert.ok(renderCalls.length >= 1);
    assert.ok(order.indexOf('resume-finish') < order.indexOf('poll'));
});

test('reconcile rejection writes runtime.controlError without throwing', async () => {
    const fsm = createFsmStub({ state: RetryState.IDLE });
    const runtime = { controlError: null };
    const coordinator = createResumeCoordinator({
        retryFsm: fsm,
        runtime,
        backendPort: {},
        stPort: { isVisible: () => true },
        restoreController: {
            reconcileLatestForCurrentChat: () => Promise.reject(new Error('boom')),
        },
        ensurePanelMounted: () => {},
        syncRuntimeFromFsm: () => {},
        updateActiveJob: () => {},
        render: () => {},
        getCurrentChatIdentity: () => ({ chatId: 'c1' }),
        toStructuredError: (error, fallback) => ({ code: 'reconcile_failed', message: fallback, detail: error?.message }),
        windowRef: createFakeWindow(),
    });

    coordinator.dispatch('page.visible');
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(runtime.controlError?.code, 'reconcile_failed');
});
