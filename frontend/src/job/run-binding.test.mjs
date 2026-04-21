import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildBindingFromState,
    findLatestActiveRunBinding,
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

test('findLatestActiveRunBinding returns the newest binding for the current browser session', () => {
    const storage = createStorage({
        'retry-mobile:active-run:chat-1': JSON.stringify({
            runId: 'run-1',
            jobId: 'job-1',
            sessionId: 'session-1',
            chatIdentity: {
                kind: 'character',
                chatId: 'chat-1',
                groupId: null,
            },
            updatedAt: '2026-04-21T10:00:00.000Z',
        }),
        'retry-mobile:active-run:chat-2': JSON.stringify({
            runId: 'run-2',
            jobId: 'job-2',
            sessionId: 'session-1',
            chatIdentity: {
                kind: 'character',
                chatId: 'chat-2',
                groupId: null,
            },
            updatedAt: '2026-04-21T11:00:00.000Z',
        }),
        'retry-mobile:active-run:chat-3': JSON.stringify({
            runId: 'run-3',
            jobId: 'job-3',
            sessionId: 'session-2',
            chatIdentity: {
                kind: 'character',
                chatId: 'chat-3',
                groupId: null,
            },
            updatedAt: '2026-04-21T12:00:00.000Z',
        }),
    });

    const binding = findLatestActiveRunBinding('session-1', storage);
    assert.equal(binding?.jobId, 'job-2');
    assert.equal(binding?.chatIdentity?.chatId, 'chat-2');
});

function createStorage(entries) {
    const store = new Map(Object.entries(entries));
    const keys = [...store.keys()];
    return {
        get length() {
            return keys.length;
        },
        key(index) {
            return keys[index] ?? null;
        },
        getItem(key) {
            return store.has(key) ? store.get(key) : null;
        },
    };
}
