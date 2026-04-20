import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildBindingFromState,
    recoverBoundStatus,
} from './run-binding.js';

test('buildBindingFromState keeps the browser session id in the binding', () => {
    const binding = buildBindingFromState({
        phase: 'backend_running',
        jobId: 'job-1',
        runId: 'run-1',
        sessionId: 'session-1',
        chatIdentity: {
            kind: 'character',
            chatId: 'chat-1',
            groupId: null,
        },
        activeStatus: {
            targetMessageVersion: 3,
            state: 'running',
            updatedAt: '2026-04-20T10:00:00.000Z',
        },
        lastAppliedVersion: 2,
    });

    assert.equal(binding?.sessionId, 'session-1');
    assert.equal(binding?.jobId, 'job-1');
    assert.equal(binding?.runId, 'run-1');
});

test('recoverBoundStatus prefers same-session active runs before generic chat fallback', async () => {
    const calls = [];
    const result = await recoverBoundStatus({
        chatIdentity: {
            kind: 'character',
            chatId: 'chat-1',
            groupId: null,
        },
        sessionId: 'session-1',
        readBinding() {
            return null;
        },
        clearBinding() {},
        async fetchStatus() {
            throw new Error('fetchStatus should not be called without a binding');
        },
        async fetchActive(_identity, options = {}) {
            calls.push(options);
            if (options.sameSessionOnly) {
                return {
                    jobId: 'job-1',
                    runId: 'run-1',
                    state: 'running',
                    ownerSessionId: 'session-1',
                    chatIdentity: {
                        kind: 'character',
                        chatId: 'chat-1',
                        groupId: null,
                    },
                };
            }

            return {};
        },
    });

    assert.equal(result.status?.jobId, 'job-1');
    assert.equal(result.source, 'same_session_active');
    assert.deepEqual(calls, [{
        sessionId: 'session-1',
        sameSessionOnly: true,
    }]);
});
