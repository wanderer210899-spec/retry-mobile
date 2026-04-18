import test from 'node:test';
import assert from 'node:assert/strict';

import {
    applyStatusToExistingMessage,
    buildCommittedReloadKey,
    clearCommittedReloads,
    commitStatusSyncForContext,
    shouldCommitStatusReload,
} from './chat-sync.js';

test('reload keys are job-and-version scoped', () => {
    assert.equal(buildCommittedReloadKey({
        jobId: 'job-1',
        targetMessageVersion: 3,
    }), 'job-1:3');

    assert.equal(buildCommittedReloadKey({
        jobId: 'job-1',
        targetMessageVersion: 0,
    }), '');
});

test('same job/version only commits once, but later versions still reload', () => {
    const runtime = {
        committedReloadKeys: new Set(),
    };

    const first = {
        jobId: 'job-1',
        targetMessageVersion: 2,
    };
    const later = {
        jobId: 'job-1',
        targetMessageVersion: 3,
    };

    assert.equal(shouldCommitStatusReload(first, runtime), true);
    runtime.committedReloadKeys.add(buildCommittedReloadKey(first));
    assert.equal(shouldCommitStatusReload(first, runtime), false);
    assert.equal(shouldCommitStatusReload(later, runtime), true);
});

test('clearing committed reloads resets the idempotency gate', () => {
    const runtime = {
        committedReloadKeys: new Set(['job-1:2']),
    };

    clearCommittedReloads(runtime);
    assert.deepEqual([...runtime.committedReloadKeys], []);
});

test('live status sync updates the existing assistant turn without forcing a chat reload', async () => {
    const calls = [];
    const runtime = {
        committedReloadKeys: new Set(),
        lastAppliedVersion: 0,
    };
    const context = {
        chatId: 'chat-1',
        chat: [
            { is_user: true, mes: 'Hello' },
            { is_user: false, mes: 'Old', swipes: ['Old'], swipe_info: [{}], swipe_id: 0 },
        ],
        updateMessageBlock: (index, message) => calls.push(['update', index, message.mes]),
        swipe: {
            refresh: (updateCounters) => calls.push(['refresh', updateCounters]),
        },
        activateSendButtons: () => calls.push(['activate']),
        reloadCurrentChat: async () => calls.push(['reload']),
    };
    const status = {
        jobId: 'job-1',
        chatIdentity: {
            kind: 'character',
            chatId: 'chat-1',
            groupId: null,
        },
        targetMessageIndex: 1,
        targetMessageVersion: 2,
        targetMessage: {
            is_user: false,
            mes: 'New accepted swipe',
            swipes: ['Old', 'New accepted swipe'],
            swipe_info: [{}, {}],
            swipe_id: 1,
            extra: {
                retryMobileJobId: 'job-1',
            },
        },
    };

    const refreshed = await commitStatusSyncForContext(status, runtime, context, {
        preferLiveUpdate: true,
    });

    assert.equal(refreshed, true);
    assert.deepEqual(calls, [
        ['update', 1, 'New accepted swipe'],
        ['refresh', true],
        ['activate'],
    ]);
    assert.equal(context.chat[1].mes, 'New accepted swipe');
    assert.equal(runtime.lastAppliedVersion, 2);
    assert.deepEqual([...runtime.committedReloadKeys], ['job-1:2']);
});

test('restored status still falls back to canonical reload', async () => {
    const calls = [];
    const runtime = {
        committedReloadKeys: new Set(),
        lastAppliedVersion: 0,
    };
    const context = {
        chatId: 'chat-1',
        chat: [
            { is_user: true, mes: 'Hello' },
            { is_user: false, mes: 'Old' },
        ],
        updateMessageBlock: () => calls.push(['update']),
        reloadCurrentChat: async () => calls.push(['reload']),
    };
    const status = {
        jobId: 'job-1',
        chatIdentity: {
            kind: 'character',
            chatId: 'chat-1',
            groupId: null,
        },
        targetMessageIndex: 1,
        targetMessageVersion: 3,
        targetMessage: {
            is_user: false,
            mes: 'Restored',
        },
    };

    const refreshed = await commitStatusSyncForContext(status, runtime, context, {
        preferLiveUpdate: false,
    });

    assert.equal(refreshed, true);
    assert.deepEqual(calls, [['reload']]);
    assert.equal(runtime.lastAppliedVersion, 3);
});

test('applyStatusToExistingMessage rejects missing or user targets', () => {
    const context = {
        chat: [
            { is_user: true, mes: 'Hello' },
        ],
        updateMessageBlock: () => {
            throw new Error('should not run');
        },
    };

    assert.equal(applyStatusToExistingMessage({
        targetMessageIndex: 0,
        targetMessage: {
            is_user: false,
            mes: 'Nope',
        },
    }, context), false);
});
