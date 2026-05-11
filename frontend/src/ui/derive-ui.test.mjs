import test from 'node:test';
import assert from 'node:assert/strict';

import { deriveUiState } from './derive-ui.js';

test('deriveUiState throws in dev when running has terminalError', () => {
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

test('deriveUiState hides non-render apply running errors', () => {
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
        'statusPillState',
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
            toastScope: { jobId: 'job-1', lastTerminalState: 'completed:completed' },
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
    assert.equal(snapshot.statusLabel, 'runState.armedAfterCompleted');
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
    assert.equal(snapshot.nextToastScope?.lastTerminalState, 'completed:completed');
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
            toastScope: { jobId: 'job-1', lastTerminalState: 'failed:failed' },
        },
        {
            activeJobStatus: null,
            controlError: null,
        },
    );
    assert.equal(snapshot.errorVisible, false);
    assert.equal(snapshot.errorText, '');
});

test('deriveUiState fires toasts.nativeAccepted for a goal=1 native-accepted completion', () => {
    const snapshot = deriveUiState(
        {
            state: 'idle',
            lastTerminalResult: {
                outcome: 'completed',
                kind: 'native_accepted',
                jobId: 'job-1',
                status: {
                    jobId: 'job-1',
                    state: 'completed',
                    acceptedCount: 1,
                    targetAcceptedCount: 1,
                    attemptCount: 1,
                    maxAttempts: 1,
                    targetMessageVersion: 0,
                },
            },
            toastScope: null,
        },
        { activeJobStatus: null, controlError: null },
    );

    assert.equal(snapshot.toastsToFire.length, 1);
    assert.equal(snapshot.toastsToFire[0].kind, 'success');
    assert.match(snapshot.toastsToFire[0].message, /nativeAccepted/);
    assert.equal(snapshot.nextToastScope?.lastTerminalState, 'completed:native_accepted');
});

test('deriveUiState fires toasts.jobComplete for a multi-attempt completion (not native-accepted)', () => {
    const snapshot = deriveUiState(
        {
            state: 'idle',
            lastTerminalResult: {
                outcome: 'completed',
                kind: 'completed',
                jobId: 'job-1',
                status: {
                    jobId: 'job-1',
                    state: 'completed',
                    acceptedCount: 3,
                    targetAcceptedCount: 3,
                    attemptCount: 5,
                    maxAttempts: 10,
                    targetMessageVersion: 3,
                },
            },
            toastScope: null,
        },
        { activeJobStatus: null, controlError: null },
    );

    assert.equal(snapshot.toastsToFire.length, 1);
    assert.equal(snapshot.toastsToFire[0].kind, 'success');
    assert.match(snapshot.toastsToFire[0].message, /jobComplete/);
    assert.equal(snapshot.nextToastScope?.lastTerminalState, 'completed:completed');
});

test('completed:native_accepted followed by completed:completed both fire distinct toasts', () => {
    const baseContext = (kind, terminalMsgVersion) => ({
        state: 'idle',
        lastTerminalResult: {
            outcome: 'completed',
            kind,
            jobId: 'job-1',
            status: {
                jobId: 'job-1',
                state: 'completed',
                acceptedCount: 1,
                targetAcceptedCount: 1,
                attemptCount: 1,
                maxAttempts: 1,
                targetMessageVersion: terminalMsgVersion,
            },
        },
    });
    const runtime = { activeJobStatus: null, controlError: null };

    const first = deriveUiState({ ...baseContext('native_accepted', 0), toastScope: null }, runtime);
    assert.equal(first.toastsToFire.length, 1);
    assert.match(first.toastsToFire[0].message, /nativeAccepted/);

    // Second render with the scope from the first — toast must not re-fire
    const second = deriveUiState({ ...baseContext('native_accepted', 0), toastScope: first.nextToastScope }, runtime);
    assert.equal(second.toastsToFire.length, 0);

    // New run completes with a regular completed kind — distinct key fires again
    const third = deriveUiState({ ...baseContext('completed', 1), toastScope: first.nextToastScope }, runtime);
    assert.equal(third.toastsToFire.length, 1);
    assert.match(third.toastsToFire[0].message, /jobComplete/);
});
