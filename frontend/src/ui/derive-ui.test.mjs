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

test('deriveUiState does not surface stale running runtime status when its jobId mismatches the FSM jobId', () => {
    // Defense in depth: even if a late callback writes a different job's
    // status into runtime.activeJobStatus while the FSM is on a new jobId,
    // we must not project that into the panel.
    const snapshot = deriveUiState(
        {
            state: 'running',
            jobId: 'job-2',
            lastTerminalResult: null,
            toastScope: { jobId: 'job-2', lastTerminalState: null },
        },
        {
            activeJobStatus: {
                jobId: 'job-1',
                state: 'completed',
                acceptedCount: 2,
                targetAcceptedCount: 2,
            },
            controlError: null,
        },
    );
    assert.equal(snapshot.activeStatus, null);
    assert.deepEqual(snapshot.toastsToFire, []);
});

test('deriveUiState in ARMED phase shows clean stats even when runtime cache and lastTerminalResult still hold the previous run', () => {
    // The FSM cleared `lastTerminalResult` on manual `arm()` — but as a
    // defense in depth the projection itself must hide stale terminal numbers
    // for the ARMED/CAPTURING phases regardless of mirror state.
    const snapshot = deriveUiState(
        {
            state: 'armed',
            jobId: null,
            lastTerminalResult: {
                outcome: 'completed',
                status: { state: 'completed', acceptedCount: 2, targetAcceptedCount: 2 },
            },
            toastScope: { jobId: 'job-1', lastTerminalState: 'completed' },
        },
        {
            activeJobStatus: {
                jobId: 'job-1',
                state: 'completed',
                acceptedCount: 2,
                targetAcceptedCount: 2,
            },
            controlError: null,
        },
    );
    assert.equal(snapshot.activeStatus, null);
    assert.equal(snapshot.statusLabel.includes('Completed'), false);
    // The deduped scope already saw this terminal — no re-fire.
    assert.deepEqual(snapshot.toastsToFire, []);
});

test('deriveUiState fires the one-shot terminal toast on auto-rearm transition (lastTerminalResult.status drives toastStatus)', () => {
    // Right after `jobCompleted` auto-rearms to ARMED, the terminal toast
    // must still fire even though the panel hides stats for ARMED.
    const snapshot = deriveUiState(
        {
            state: 'armed',
            jobId: null,
            lastTerminalResult: {
                outcome: 'completed',
                jobId: 'job-1',
                status: {
                    jobId: 'job-1',
                    state: 'completed',
                    acceptedCount: 2,
                    targetAcceptedCount: 2,
                    attemptCount: 3,
                    maxAttempts: 5,
                },
            },
            // Fresh post-terminal scope — `createTerminalContext` set this
            // to null and `normalizeBaseContext` keeps it null.
            toastScope: null,
        },
        {
            activeJobStatus: null,
            controlError: null,
        },
    );
    assert.equal(snapshot.activeStatus, null);
    assert.equal(snapshot.toastsToFire.length, 1);
    assert.equal(snapshot.toastsToFire[0].kind, 'success');
    assert.equal(snapshot.nextToastScope?.lastTerminalState, 'completed');
});

test('deriveUiState in ARMED with a cleared terminalError does not light the error box (regression for leftover errors after auto-rearm-from-failure)', () => {
    const snapshot = deriveUiState(
        {
            state: 'armed',
            jobId: null,
            terminalError: null,
            lastTerminalResult: {
                outcome: 'failed',
                jobId: 'job-1',
                error: { code: 'retry_job_failed', message: 'died' },
                status: {
                    jobId: 'job-1',
                    state: 'failed',
                    structuredError: { code: 'retry_job_failed', message: 'died' },
                },
            },
            toastScope: { jobId: 'job-1', lastTerminalState: 'failed' },
        },
        {
            activeJobStatus: null,
            controlError: null,
        },
    );
    assert.equal(snapshot.errorVisible, false);
    assert.equal(snapshot.errorText, '');
});
