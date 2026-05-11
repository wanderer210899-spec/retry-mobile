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
            clientTimezoneOffsetMinutes: -60,
            assistantName: '白肆昀',
        },
        skipPersist: true,
    });

    const cursor = ensureJobLog(job);
    assert.match(cursor.title, /^2026-04-18 21-22-30 UTC\+01:00 - 白肆昀 - 9dbefa8a$/u);

    appendJobLog(job, {
        source: 'backend',
        event: 'attempt_started',
        summary: 'Backend started attempt 2.',
        detail: {
            attemptNumber: 2,
        },
        at: '2026-04-18T20:23:00.000Z',
    });
    appendJobLog(job, {
        source: 'frontend',
        event: 'status_ingest_rejected',
        summary: 'Frontend ignored a stale backend status.',
        detail: {
            reason: 'out_of_order_revision',
            statusRevision: 2,
            currentRevision: 5,
        },
        frontendStatus: {
            fsmState: 'running',
            fsmJobId: job.jobId,
            fsmRunId: 'run-1',
            fsmLastStatusRevision: 5,
            runtimeActiveJobId: job.jobId,
            runtimeMirrorJobId: job.jobId,
            runtimeMirrorRunId: 'run-1',
            runtimeMirrorState: 'running',
            runtimeMirrorPhase: 'backend_running',
            runtimeMirrorRevision: 5,
            runtimeAcceptedCount: 1,
            runtimeTargetAcceptedCount: 2,
            runtimeAttemptCount: 1,
            runtimeMaxAttempts: 30,
            runtimeTargetMessageVersion: 2,
            runtimeNativeState: 'confirmed',
            runtimeFrontendVisibilityState: 'hidden',
            lastKnownTargetMessageVersion: 2,
            lastAppliedVersion: 1,
            pendingVisibleRenderVersion: 2,
            reloadAttempted: false,
            browserVisibilityState: 'hidden',
            browserOnline: false,
            logJobId: job.jobId,
            logEntryCount: 3,
            logUpdatedAt: '2026-04-18T21:23:00+01:00',
        },
        at: '2026-04-18T20:23:05.000Z',
    });

    const logPath = getJobLogPath('default-user', directories, job.jobId);
    assert.equal(fs.existsSync(logPath), true);
    const persistedEntries = fs.readFileSync(logPath, 'utf8')
        .trim()
        .split(/\r?\n/u)
        .map((line) => JSON.parse(line));
    assert.equal(persistedEntries.at(-1).backendStatus.state, 'running');
    assert.equal(persistedEntries.at(-1).frontendStatus.fsmState, 'running');
    assert.equal(persistedEntries.at(-1).frontendStatus.runtimeMirrorRevision, 5);

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

    assert.match(rendered, /^2026-04-18 21-22-30 UTC\+01:00 - 白肆昀 - 9dbefa8a/mu);
    assert.match(rendered, /revision: \d+/u);
    assert.match(rendered, /frontendVisibilityState: unknown/u);
    assert.match(rendered, /logEntryCount: 3/u);
    assert.match(rendered, /Attempt Summary:/u);
    assert.match(rendered, /Latest Frontend Snapshot:/u);
    assert.match(rendered, /fsm: fsm=running job=9dbefa8a-2f07-48e0-84cc-ee459a010b55 run=run-1 rev=5/u);
    assert.match(rendered, /runtimeMirror: active=9dbefa8a-2f07-48e0-84cc-ee459a010b55 mirror=running mirrorJob=9dbefa8a-2f07-48e0-84cc-ee459a010b55/u);
    assert.match(rendered, /render: known=2 applied=1 pending=2 reload=no/u);
    assert.match(rendered, /browser: visibility=hidden online=no backendVisibility=hidden/u);
    assert.match(rendered, /Event Timeline:/u);
    assert.match(rendered, /attempt_started/u);
    assert.match(rendered, /2026-04-18T21:23:00\+01:00 \| backend \| attempt_started .*backend=state=running phase=backend_running rev=\d+ accepted=1\/2 attempts=1\/30 native=pending version=0 frontend=unknown/u);
    assert.match(rendered, /status_ingest_rejected .*frontend=fsm=running job=9dbefa8a-2f07-48e0-84cc-ee459a010b55/u);

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
