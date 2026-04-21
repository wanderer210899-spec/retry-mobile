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

test('rendered backend logs surface validation mode and token-count diagnostics', () => {
    const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'retry-mobile-log-store-validation-'));
    const userRoot = path.join(sandboxRoot, 'default-user');
    const directories = createUserDirectories(userRoot);
    fs.mkdirSync(userRoot, { recursive: true });

    const job = createJob({
        jobId: '7e9e84f7-e20b-4d3e-b9ae-0d0d6a116dd7',
        runId: 'run-2',
        state: 'running',
        phase: 'validation_rejected',
        createdAt: '2026-04-21T18:00:00.000Z',
        updatedAt: '2026-04-21T18:00:00.000Z',
        acceptedCount: 0,
        targetAcceptedCount: 1,
        attemptCount: 1,
        maxAttempts: 5,
        chatIdentity: {
            kind: 'character',
            chatId: 'chat-2',
            groupId: '',
        },
        userContext: {
            handle: 'default-user',
            directories,
        },
        runConfig: {
            validationMode: 'tokens',
            minTokens: 120,
            allowHeuristicTokenFallback: false,
        },
        tokenizerDescriptor: {
            source: 'gpt-4o',
        },
        attemptLog: [{
            attemptNumber: 1,
            startedAt: '2026-04-21T18:00:00.000Z',
            finishedAt: '2026-04-21T18:00:05.000Z',
            outcome: 'rejected',
            reason: 'tokenizer_unavailable',
            message: 'Retry Mobile could not verify token length with a real tokenizer.',
            phase: 'validation_rejected',
            characterCount: 420,
            tokenCount: null,
            tokenCountSource: 'unavailable',
            tokenCountModel: 'gpt-4o',
            tokenCountDetail: 'Tokenizer cache not ready.',
        }],
        skipPersist: true,
    });

    const rendered = renderJobLog(job, {
        compatibility: {
            nativeSaveSupport: true,
            detail: 'compatible',
            checkedAt: '2026-04-21T17:59:59.000Z',
        },
    });

    assert.match(rendered, /validationMode: tokens/u);
    assert.match(rendered, /validationThreshold: 120/u);
    assert.match(rendered, /allowHeuristicTokenFallback: no/u);
    assert.ok(rendered.includes('tokenizerDescriptor: {"source":"gpt-4o"}'));
    assert.match(rendered, /tokenCountSource: unavailable/u);
    assert.match(rendered, /tokenCountModel: gpt-4o/u);
    assert.match(rendered, /tokenCountDetail: Tokenizer cache not ready\./u);
    assert.match(rendered, /tokenSource=unavailable/u);
    assert.match(rendered, /tokenModel=gpt-4o/u);

    fs.rmSync(sandboxRoot, { recursive: true, force: true });
});
