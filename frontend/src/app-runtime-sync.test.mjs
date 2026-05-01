import test from 'node:test';
import assert from 'node:assert/strict';

import { RetryState } from './retry-fsm.js';
import { syncActiveRunBinding, syncRuntimeFromFsm } from './app-runtime-sync.js';

function createFsmStub(context) {
    return {
        getContext() {
            return context;
        },
    };
}

test('syncActiveRunBinding skips sessionStorage writes when only updatedAt changes', () => {
    const chatIdentity = { kind: 'character', chatId: 'chat-1', groupId: null };
    const runtime = {
        sessionId: 'session-1',
        activeJobStatus: {
            state: 'running',
            targetMessageVersion: 3,
            updatedAt: '2026-04-24T12:30:00.000Z',
        },
        activeRunBinding: {
            runId: 'run-1',
            jobId: 'job-1',
            sessionId: 'session-1',
            chatIdentity,
            lastKnownTargetMessageVersion: 3,
            lastKnownState: 'running',
            updatedAt: '2026-04-24T12:00:00.000Z',
        },
    };
    let writes = 0;

    const result = syncActiveRunBinding(runtime, {
        state: RetryState.RUNNING,
        jobId: 'job-1',
        runId: 'run-1',
        chatIdentity,
    }, {
        resolveBindingChatIdentity: () => chatIdentity,
        writeBinding(binding) {
            writes += 1;
            return binding;
        },
    });

    assert.equal(writes, 0);
    assert.deepEqual(result, runtime.activeRunBinding);
});

test('syncActiveRunBinding writes when the persisted target-message version changes', () => {
    const chatIdentity = { kind: 'character', chatId: 'chat-1', groupId: null };
    const runtime = {
        sessionId: 'session-1',
        activeJobStatus: {
            state: 'running',
            targetMessageVersion: 4,
            updatedAt: '2026-04-24T12:30:00.000Z',
        },
        activeRunBinding: {
            runId: 'run-1',
            jobId: 'job-1',
            sessionId: 'session-1',
            chatIdentity,
            lastKnownTargetMessageVersion: 3,
            lastKnownState: 'running',
            updatedAt: '2026-04-24T12:00:00.000Z',
        },
    };
    let writtenBinding = null;

    const result = syncActiveRunBinding(runtime, {
        state: RetryState.RUNNING,
        jobId: 'job-1',
        runId: 'run-1',
        chatIdentity,
    }, {
        resolveBindingChatIdentity: () => chatIdentity,
        writeBinding(binding) {
            writtenBinding = binding;
            return binding;
        },
    });

    assert.equal(writtenBinding?.lastKnownTargetMessageVersion, 4);
    assert.deepEqual(result, writtenBinding);
    assert.deepEqual(runtime.activeRunBinding, writtenBinding);
});

test('syncRuntimeFromFsm does not stomp live activeJobStatus when entering RUNNING with a stale lastTerminalResult', () => {
    // Reproduces the "Generating native… 2/2 turn completed" race: after a
    // completed run, the FSM auto-rearms and a new POST /start writes a fresh
    // running status into runtime.activeJobStatus. The next syncRuntime call
    // must not push the previous run's terminal snapshot back over it.
    const freshRunning = {
        jobId: 'job-2',
        state: 'running',
        acceptedCount: 0,
        targetAcceptedCount: 2,
        attemptCount: 0,
        maxAttempts: 5,
        nativeState: 'pending',
    };
    const runtime = {
        sessionId: 'session-1',
        activeJobStatus: freshRunning,
        activeJobId: 'job-2',
        activeRunBinding: null,
        controlError: null,
        pendingNativeOutcome: null,
    };
    const fsm = createFsmStub({
        state: RetryState.RUNNING,
        jobId: 'job-2',
        runId: 'run-2',
        chatIdentity: null,
        target: null,
        lastTerminalResult: {
            outcome: 'completed',
            jobId: 'job-1',
            status: { jobId: 'job-1', state: 'completed', acceptedCount: 2, targetAcceptedCount: 2 },
        },
        terminalError: null,
        runError: null,
    });

    syncRuntimeFromFsm(runtime, fsm);

    assert.deepEqual(runtime.activeJobStatus, freshRunning);
    assert.equal(runtime.activeJobId, 'job-2');
    assert.equal(runtime.controlError, null);
});

test('syncRuntimeFromFsm clears the runtime activeJobStatus cache once the FSM is no longer running and the cache no longer matches the terminal jobId', () => {
    // After a manual Start press, the previous polled status (e.g. completed)
    // must not keep showing in the new ARMED phase's stats card.
    const runtime = {
        sessionId: 'session-1',
        activeJobStatus: {
            jobId: 'job-1',
            state: 'completed',
            acceptedCount: 2,
            targetAcceptedCount: 2,
        },
        activeJobId: 'job-1',
        activeRunBinding: null,
        controlError: null,
        pendingNativeOutcome: null,
    };
    const fsm = createFsmStub({
        state: RetryState.ARMED,
        jobId: null,
        runId: 'run-2',
        chatIdentity: null,
        target: null,
        // After `arm()` (manual Start), `lastTerminalResult` is null. The
        // stale runtime cache no longer corresponds to a remembered terminal,
        // so it must be cleared.
        lastTerminalResult: null,
        terminalError: null,
        runError: null,
    });

    syncRuntimeFromFsm(runtime, fsm);

    assert.equal(runtime.activeJobStatus, null);
    assert.equal(runtime.controlError, null);
});

test('syncRuntimeFromFsm preserves the activeJobStatus cache while it still matches lastTerminalResult.jobId so terminal display works in IDLE', () => {
    // After a no-rearm completion, IDLE should still surface the resulting
    // counts. The cache is owned by the terminal snapshot until the next
    // user action invalidates it.
    const completedStatus = {
        jobId: 'job-1',
        state: 'completed',
        acceptedCount: 2,
        targetAcceptedCount: 2,
    };
    const runtime = {
        sessionId: 'session-1',
        activeJobStatus: completedStatus,
        activeJobId: 'job-1',
        activeRunBinding: null,
        controlError: null,
        pendingNativeOutcome: null,
    };
    const fsm = createFsmStub({
        state: RetryState.IDLE,
        jobId: null,
        runId: null,
        chatIdentity: null,
        target: null,
        lastTerminalResult: {
            outcome: 'completed',
            jobId: 'job-1',
            status: completedStatus,
        },
        terminalError: null,
        runError: null,
    });

    syncRuntimeFromFsm(runtime, fsm);

    assert.deepEqual(runtime.activeJobStatus, completedStatus);
});
