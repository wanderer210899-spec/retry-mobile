import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildChatKey,
    clearActiveRunBinding,
    readActiveRunBinding,
    recoverBoundStatus,
    writeActiveRunBinding,
} from './run-binding.js';

function createStorage() {
    const store = new Map();
    return {
        getItem(key) {
            return store.has(key) ? store.get(key) : null;
        },
        setItem(key, value) {
            store.set(key, String(value));
        },
        removeItem(key) {
            store.delete(key);
        },
    };
}

function createChatIdentity(chatId = 'chat-1') {
    return {
        kind: 'character',
        chatId,
        groupId: null,
    };
}

test('recoverBoundStatus prefers an exact running binding over a different active chat job', async () => {
    const storage = createStorage();
    const chatIdentity = createChatIdentity();
    writeActiveRunBinding({
        runId: 'run-1',
        jobId: 'job-bound',
        chatKey: buildChatKey(chatIdentity),
        chatIdentity,
        updatedAt: '2026-04-20T10:00:00.000Z',
    }, storage);

    let activeFetchCount = 0;
    const result = await recoverBoundStatus({
        chatIdentity,
        readBinding: (identity) => readActiveRunBinding(identity, storage),
        clearBinding: (identity) => clearActiveRunBinding(identity, storage),
        fetchStatus: async (jobId) => ({
            jobId,
            runId: 'run-1',
            state: 'running',
            chatIdentity,
        }),
        fetchActive: async () => {
            activeFetchCount += 1;
            return {
                jobId: 'job-foreign',
                runId: 'run-foreign',
                state: 'running',
                chatIdentity,
            };
        },
    });

    assert.equal(result.source, 'binding');
    assert.equal(result.status?.jobId, 'job-bound');
    assert.equal(activeFetchCount, 0);
});

test('recoverBoundStatus clears a stale binding and falls back to the chat active job', async () => {
    const storage = createStorage();
    const chatIdentity = createChatIdentity();
    writeActiveRunBinding({
        runId: 'run-stale',
        jobId: 'job-stale',
        chatKey: buildChatKey(chatIdentity),
        chatIdentity,
        updatedAt: '2026-04-20T10:00:00.000Z',
    }, storage);

    const result = await recoverBoundStatus({
        chatIdentity,
        readBinding: (identity) => readActiveRunBinding(identity, storage),
        clearBinding: (identity) => clearActiveRunBinding(identity, storage),
        fetchStatus: async () => {
            const error = new Error('missing');
            error.status = 404;
            throw error;
        },
        fetchActive: async () => ({
            jobId: 'job-active',
            runId: 'run-active',
            state: 'running',
            chatIdentity,
        }),
    });

    assert.equal(result.source, 'active');
    assert.equal(result.status?.jobId, 'job-active');
    assert.equal(readActiveRunBinding(chatIdentity, storage), null);
});
