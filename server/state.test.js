const test = require('node:test');
const assert = require('node:assert/strict');

const {
    buildChatKey,
    appendAttemptLog,
    createJob,
    getJobByChat,
    getJobByChatSession,
    getLatestJobByChat,
    jobs,
    markNotificationSent,
    recordJobEvent,
    serializeJob,
    touchJob,
    updateJobLogState,
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

test('job revision is serialized and advances on every state/log mutation helper', () => {
    jobs.clear();

    const chatIdentity = createIdentity('chat-revision');
    const job = createJob({
        jobId: 'job-revision',
        runId: 'run-revision',
        state: 'running',
        chatIdentity,
        chatKey: buildChatKey(chatIdentity),
        userContext: { handle: 'default-user', directories: {} },
        skipPersist: true,
    });

    assert.equal(job.revision, 1);
    assert.equal(serializeJob(job).revision, 1);

    touchJob(job, { phase: 'pending_native' });
    assert.equal(job.revision, 2);
    assert.equal(serializeJob(job).revision, 2);

    appendAttemptLog(job, { attemptNumber: 1, outcome: 'retry', message: 'Attempt started.' });
    assert.equal(job.revision, 3);

    updateJobLogState(job, { logEntryCount: 1 });
    assert.equal(job.revision, 4);
    assert.equal(serializeJob(job).revision, 4);

    jobs.clear();
});

test('job event identity serializes eventSeq and lastEvent', () => {
    jobs.clear();

    const chatIdentity = createIdentity('chat-events');
    const job = createJob({
        jobId: 'job-events',
        runId: 'run-events',
        state: 'running',
        chatIdentity,
        chatKey: buildChatKey(chatIdentity),
        userContext: { handle: 'default-user', directories: {} },
        skipPersist: true,
    });

    const started = recordJobEvent(job, 'started', { source: 'test' });
    assert.equal(started.seq, 1);
    assert.equal(serializeJob(job).eventSeq, 1);
    assert.equal(serializeJob(job).lastEvent.type, 'started');

    touchJob(job, { phase: 'writing_chat' }, {
        event: 'accepted_written',
        detail: { targetMessageVersion: 1 },
    });
    const serialized = serializeJob(job);
    assert.equal(serialized.eventSeq, 2);
    assert.equal(serialized.lastEvent.type, 'accepted_written');
    assert.equal(serialized.lastEvent.detail.targetMessageVersion, 1);

    jobs.clear();
});

test('getLatestJobByChat skips tombstoned or recovery-suppressed jobs', () => {
    jobs.clear();

    const chatIdentity = createIdentity('chat-suppressed');
    createJob({
        jobId: 'job-suppressed',
        runId: 'run-suppressed',
        state: 'completed',
        recoverySuppressed: true,
        updatedAt: '2026-05-11T12:00:00.000Z',
        chatIdentity,
        chatKey: buildChatKey(chatIdentity),
        userContext: { handle: 'default-user', directories: {} },
        skipPersist: true,
    });
    createJob({
        jobId: 'job-visible',
        runId: 'run-visible',
        state: 'completed',
        updatedAt: '2026-05-11T11:00:00.000Z',
        chatIdentity,
        chatKey: buildChatKey(chatIdentity),
        userContext: { handle: 'default-user', directories: {} },
        skipPersist: true,
    });

    assert.equal(getLatestJobByChat(chatIdentity)?.jobId, 'job-visible');

    jobs.clear();
});

test('markNotificationSent dedupes terminal notification keys durably', () => {
    jobs.clear();

    const chatIdentity = createIdentity('chat-notify');
    const job = createJob({
        jobId: 'job-notify',
        runId: 'run-notify',
        state: 'completed',
        chatIdentity,
        chatKey: buildChatKey(chatIdentity),
        userContext: { handle: 'default-user', directories: {} },
        skipPersist: true,
    });

    assert.equal(markNotificationSent(job, 'terminal:completed'), true);
    assert.equal(markNotificationSent(job, 'terminal:completed'), false);

    jobs.clear();
});

test('getJobByChat ignores running jobs whose cancellation has been requested so a fresh /start can succeed', () => {
    jobs.clear();

    const chatIdentity = createIdentity('chat-stop-start');

    createJob({
        jobId: 'job-cancelling',
        runId: 'run-cancelling',
        state: 'running',
        cancelRequested: true,
        updatedAt: '2026-04-27T22:00:00.000Z',
        chatIdentity,
        chatKey: buildChatKey(chatIdentity),
        ownerSessionId: 'session-A',
        userContext: { handle: 'default-user', directories: {} },
        skipPersist: true,
    });

    assert.equal(
        getJobByChat(chatIdentity),
        null,
        'a cancelling job must NOT block a new start on the same chat',
    );
    assert.equal(
        getJobByChatSession(chatIdentity, 'session-A'),
        null,
        'a cancelling job must NOT be reported as the active session job either',
    );

    createJob({
        jobId: 'job-fresh-running',
        runId: 'run-fresh-running',
        state: 'running',
        cancelRequested: false,
        updatedAt: '2026-04-27T22:00:01.000Z',
        chatIdentity,
        chatKey: buildChatKey(chatIdentity),
        ownerSessionId: 'session-A',
        userContext: { handle: 'default-user', directories: {} },
        skipPersist: true,
    });

    assert.equal(
        getJobByChat(chatIdentity)?.jobId,
        'job-fresh-running',
        'the fresh non-cancelling running job must surface as the active job',
    );
    assert.equal(
        getJobByChatSession(chatIdentity, 'session-A')?.jobId,
        'job-fresh-running',
    );

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
