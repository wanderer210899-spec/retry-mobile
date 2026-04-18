const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createJob } = require('./state');
const { appendJobLog, ensureJobLog, getJobLogPath, renderJobLog } = require('./job-log-store');

function createUserDirectories(rootPath) {
    return {
        root: rootPath,
        chats: path.join(rootPath, 'chats'),
        groupChats: path.join(rootPath, 'groups'),
        backups: path.join(rootPath, 'backups'),
    };
}

test('backend job logs are created with a human-readable title and rendered from disk', () => {
    const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'retry-mobile-log-store-'));
    const userRoot = path.join(sandboxRoot, 'default-user');
    const directories = createUserDirectories(userRoot);
    fs.mkdirSync(userRoot, { recursive: true });

    const job = createJob({
        jobId: '9dbefa8a-2f07-48e0-84cc-ee459a010b55',
        runId: 'run-1',
        state: 'running',
        phase: 'backend_running',
        createdAt: '2026-04-18T20:22:30.007Z',
        updatedAt: '2026-04-18T20:22:30.007Z',
        acceptedCount: 1,
        targetAcceptedCount: 2,
        attemptCount: 1,
        maxAttempts: 30,
        chatIdentity: {
            kind: 'character',
            chatId: 'chat-1',
            groupId: '',
        },
        userContext: {
            handle: 'default-user',
            directories,
        },
        captureMeta: {
            assistantName: '白肆昀',
        },
        skipPersist: true,
    });

    const cursor = ensureJobLog(job);
    assert.match(cursor.title, /^2026-04-18 20-22-30 UTC - 白肆昀 - 9dbefa8a$/u);

    appendJobLog(job, {
        source: 'backend',
        event: 'attempt_started',
        summary: 'Backend started attempt 2.',
        detail: {
            attemptNumber: 2,
        },
        at: '2026-04-18T20:23:00.000Z',
    });

    const logPath = getJobLogPath('default-user', directories, job.jobId);
    assert.equal(fs.existsSync(logPath), true);

    const rendered = renderJobLog(job, {
        compatibility: {
            nativeSaveSupport: true,
            detail: 'compatible',
            checkedAt: '2026-04-18T20:22:29.000Z',
        },
        circuitBreaker: {
            blocked: false,
            count: 0,
        },
    });

    assert.match(rendered, /^2026-04-18 20-22-30 UTC - 白肆昀 - 9dbefa8a/mu);
    assert.match(rendered, /Attempt Summary:/u);
    assert.match(rendered, /Event Timeline:/u);
    assert.match(rendered, /attempt_started/u);

    fs.rmSync(sandboxRoot, { recursive: true, force: true });
});
