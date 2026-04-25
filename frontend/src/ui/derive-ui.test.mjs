import test from 'node:test';
import assert from 'node:assert/strict';

import { deriveUiState } from './derive-ui.js';

test('CURRENTLY FAILING (pre-fix): deriveUiState throws in dev when running has terminalError', () => {
    const previousDev = globalThis.__RM_DEV__;
    globalThis.__RM_DEV__ = true;
    try {
        assert.throws(() => {
            deriveUiState(
                {
                    state: 'running',
                    terminalError: { code: 'retry_job_failed', message: 'bad', detail: '' },
                    runError: null,
                    lastTerminalResult: null,
                },
                {
                    activeJobStatus: { state: 'running' },
                    controlError: null,
                },
            );
        }, /\[INVARIANT\] terminalError in running state/);
    } finally {
        globalThis.__RM_DEV__ = previousDev;
    }
});

test('CURRENTLY PASSING (pre-fix): deriveUiState hides non-render apply running errors', () => {
    const snapshot = deriveUiState(
        {
            state: 'running',
            runError: { code: 'client_patch_failed', message: 'Failed', detail: '' },
            lastTerminalResult: null,
        },
        {
            activeJobStatus: { state: 'running' },
            controlError: null,
        },
    );
    assert.equal(snapshot.errorVisible, false);
    assert.equal(snapshot.statusLabel.includes('Completed'), false);
    assert.equal(snapshot.toastsToFire.length > 0, true);
    assert.equal(snapshot.toastsToFire[0].kind, 'warning');
});

test('deriveUiState keeps running label non-terminal with runError present', () => {
    const snapshot = deriveUiState(
        {
            state: 'running',
            runError: { code: 'client_apply_failed', message: 'Apply failed', detail: '' },
            lastTerminalResult: null,
            toastScope: null,
        },
        {
            activeJobStatus: {
                state: 'running',
                phaseText: 'Retry loop active',
            },
            controlError: null,
        },
    );
    assert.equal(snapshot.statusLabel, 'Retry loop active');
    assert.equal(snapshot.errorVisible, false);
});

test('deriveUiState terminal state surfaces terminalError in panel', () => {
    const snapshot = deriveUiState(
        {
            state: 'idle',
            terminalError: { code: 'retry_job_failed', message: 'Backend failed', detail: '' },
            lastTerminalResult: {
                status: { state: 'failed', phaseText: 'Failed' },
            },
        },
        {
            activeJobStatus: null,
            controlError: null,
        },
    );
    assert.equal(snapshot.errorVisible, true);
    assert.equal(snapshot.errorText.includes('Backend failed'), true);
});

test('deriveUiState emits stable shape with declared keys only', () => {
    const snapshot = deriveUiState(
        {
            state: 'armed',
            lastTerminalResult: null,
            toastScope: null,
        },
        {
            activeJobStatus: null,
            controlError: null,
        },
    );
    assert.deepEqual(Object.keys(snapshot).sort(), [
        'activeStatus',
        'error',
        'errorText',
        'errorVisible',
        'nextToastScope',
        'phase',
        'statusLabel',
        'toastsToFire',
        'transport',
    ].sort());
});

test('late start cleanup state yields zero toast intents without active status', () => {
    const snapshot = deriveUiState(
        {
            state: 'idle',
            toastScope: null,
            lastTerminalResult: null,
        },
        {
            activeJobStatus: null,
            controlError: null,
        },
    );
    assert.deepEqual(snapshot.toastsToFire, []);
});
