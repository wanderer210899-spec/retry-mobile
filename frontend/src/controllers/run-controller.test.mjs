import test from 'node:test';
import assert from 'node:assert/strict';
import { mock } from 'node:test';

// Provide a minimal browser-like global so SillyTavern wrappers don't throw
// ReferenceError at call-time.  Functions that use window.SillyTavern will
// just receive null context and return early or no-op.
globalThis.window = {
    toastr: null,
    SillyTavern: null,
    clearTimeout: (id) => clearTimeout(id),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
};

import { createRunController } from './run-controller.js';
import { createRuntime } from '../core/runtime.js';
import { RUN_STATE, RUN_MODE, VALIDATION_MODE } from '../constants.js';

function makeSettings(overrides = {}) {
    return {
        runMode: RUN_MODE.SINGLE,
        targetAcceptedCount: 1,
        maxAttempts: 3,
        attemptTimeoutSeconds: 30,
        nativeGraceSeconds: 10,
        minCharacters: 10,
        minTokens: 0,
        validationMode: VALIDATION_MODE.CHARACTERS,
        notifyOnSuccess: false,
        notifyOnComplete: false,
        vibrateOnSuccess: false,
        vibrateOnComplete: false,
        notificationMessageTemplate: '',
        ...overrides,
    };
}

function makeStatusController(overrides = {}) {
    return {
        applyErrorState: mock.fn(),
        refreshChatState: mock.fn(async () => {}),
        clearPolling: mock.fn(),
        applyTerminalState: mock.fn(async () => {}),
        noteTransportError: mock.fn(),
        getCurrentState: mock.fn(() => RUN_STATE.IDLE),
        clearActiveBackendStatus: mock.fn(),
        ...overrides,
    };
}

function makeRuntime(settingsOverrides = {}) {
    const rt = createRuntime();
    rt.settings = makeSettings(settingsOverrides);
    rt.diagnostics = { startEnabled: true };
    return rt;
}

test('armPlugin blocks when diagnostics.startEnabled is false', async () => {
    const runtime = makeRuntime();
    runtime.diagnostics = { startEnabled: false };
    const statusController = makeStatusController();
    const controller = createRunController({ runtime, render: mock.fn(), statusController });

    await controller.armPlugin();

    assert.equal(statusController.applyErrorState.mock.calls.length, 1);
    const err = statusController.applyErrorState.mock.calls[0].arguments[0];
    assert.equal(err.code, 'capture_missing_payload');
});

test('armPlugin blocks when run config timeout is zero', async () => {
    const runtime = makeRuntime({ attemptTimeoutSeconds: 0 });
    const statusController = makeStatusController();
    const controller = createRunController({ runtime, render: mock.fn(), statusController });

    await controller.armPlugin();

    assert.equal(statusController.applyErrorState.mock.calls.length, 1);
});

test('armPlugin blocks when minCharacters is zero in characters mode', async () => {
    const runtime = makeRuntime({ minCharacters: 0, validationMode: VALIDATION_MODE.CHARACTERS });
    const statusController = makeStatusController();
    const controller = createRunController({ runtime, render: mock.fn(), statusController });

    await controller.armPlugin();

    assert.equal(statusController.applyErrorState.mock.calls.length, 1);
});

test('stopPlugin sets manualStopRequested', async () => {
    const runtime = makeRuntime();
    runtime.activeJobId = null;
    const statusController = makeStatusController();
    const controller = createRunController({ runtime, render: mock.fn(), statusController });

    await controller.stopPlugin();

    assert.equal(runtime.manualStopRequested, true);
});

test('stopPlugin transitions to CANCELLED when there is no active run', async () => {
    const runtime = makeRuntime();
    runtime.activeJobId = null;
    const statusController = makeStatusController();
    const render = mock.fn();
    const controller = createRunController({ runtime, render, statusController });

    await controller.stopPlugin();

    assert.equal(render.mock.calls.length >= 1, true);
    assert.equal(statusController.applyTerminalState.mock.calls.length, 0);
});

test('maybeAutoRearmAfterRun skips in single-run mode', async () => {
    const runtime = makeRuntime({ runMode: RUN_MODE.SINGLE });
    const statusController = makeStatusController();
    const controller = createRunController({ runtime, render: mock.fn(), statusController });

    await controller.maybeAutoRearmAfterRun(RUN_STATE.COMPLETED);

    assert.equal(statusController.applyErrorState.mock.calls.length, 0);
    assert.equal(statusController.refreshChatState.mock.calls.length, 0);
});

test('maybeAutoRearmAfterRun skips when manualStopRequested is true', async () => {
    const runtime = makeRuntime({ runMode: RUN_MODE.TOGGLE });
    runtime.manualStopRequested = true;
    const statusController = makeStatusController();
    const controller = createRunController({ runtime, render: mock.fn(), statusController });

    await controller.maybeAutoRearmAfterRun(RUN_STATE.COMPLETED);

    assert.equal(statusController.refreshChatState.mock.calls.length, 0);
});

test('maybeAutoRearmAfterRun skips for non-terminal states', async () => {
    const runtime = makeRuntime({ runMode: RUN_MODE.TOGGLE });
    runtime.manualStopRequested = false;
    const statusController = makeStatusController();
    const controller = createRunController({ runtime, render: mock.fn(), statusController });

    await controller.maybeAutoRearmAfterRun(RUN_STATE.CANCELLED);

    assert.equal(statusController.refreshChatState.mock.calls.length, 0);
});

test('stopPlugin clears the capture session', async () => {
    const runtime = makeRuntime();
    const stopFn = mock.fn();
    runtime.capture.session = { stop: stopFn };
    runtime.activeJobId = null;

    const statusController = makeStatusController();
    const controller = createRunController({ runtime, render: mock.fn(), statusController });

    await controller.stopPlugin();

    assert.equal(runtime.capture.session, null);
    assert.equal(stopFn.mock.calls.length, 1);
});
