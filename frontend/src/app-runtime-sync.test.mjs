import test from 'node:test';
import assert from 'node:assert/strict';

import { RetryState } from './retry-fsm.js';
import { syncActiveRunBinding } from './app-runtime-sync.js';

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
