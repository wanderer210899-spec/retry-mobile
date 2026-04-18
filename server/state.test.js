const test = require('node:test');
const assert = require('node:assert/strict');

const {
    buildChatKey,
    createJob,
    getLatestJobByChat,
    jobs,
} = require('./state');

function createIdentity(chatId) {
    return {
        kind: 'character',
        chatId,
        groupId: '',
    };
}

test('getLatestJobByChat returns the newest job for the same chat, including terminal runs', () => {
    jobs.clear();

    const chatIdentity = createIdentity('chat-1');
    const otherIdentity = createIdentity('chat-2');

    createJob({
        jobId: 'job-old-running',
        runId: 'run-old-running',
        state: 'running',
        updatedAt: '2026-04-18T18:05:00.000Z',
        chatIdentity,
        chatKey: buildChatKey(chatIdentity),
        userContext: {
            handle: 'default-user',
            directories: {},
        },
        skipPersist: true,
    });
    createJob({
        jobId: 'job-new-completed',
        runId: 'run-new-completed',
        state: 'completed',
        updatedAt: '2026-04-18T18:06:00.000Z',
        chatIdentity,
        chatKey: buildChatKey(chatIdentity),
        userContext: {
            handle: 'default-user',
            directories: {},
        },
        skipPersist: true,
    });
    createJob({
        jobId: 'job-other-chat',
        runId: 'run-other-chat',
        state: 'completed',
        updatedAt: '2026-04-18T18:07:00.000Z',
        chatIdentity: otherIdentity,
        chatKey: buildChatKey(otherIdentity),
        userContext: {
            handle: 'default-user',
            directories: {},
        },
        skipPersist: true,
    });

    const latest = getLatestJobByChat(chatIdentity);
    assert.equal(latest?.jobId, 'job-new-completed');

    jobs.clear();
});

test('getLatestJobByChat prefers a running job when timestamps tie', () => {
    jobs.clear();

    const chatIdentity = createIdentity('chat-1');
    const sharedTimestamp = '2026-04-18T18:06:00.000Z';

    createJob({
        jobId: 'job-completed',
        runId: 'run-completed',
        state: 'completed',
        updatedAt: sharedTimestamp,
        chatIdentity,
        chatKey: buildChatKey(chatIdentity),
        userContext: {
            handle: 'default-user',
            directories: {},
        },
        skipPersist: true,
    });
    createJob({
        jobId: 'job-running',
        runId: 'run-running',
        state: 'running',
        updatedAt: sharedTimestamp,
        chatIdentity,
        chatKey: buildChatKey(chatIdentity),
        userContext: {
            handle: 'default-user',
            directories: {},
        },
        skipPersist: true,
    });

    const latest = getLatestJobByChat(chatIdentity);
    assert.equal(latest?.jobId, 'job-running');

    jobs.clear();
});
