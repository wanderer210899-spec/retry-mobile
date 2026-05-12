const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const plugin = require('./index');
const { buildChatKey, createJob, getJob, jobs } = require('./state');

test('extractReplayAuthContext keeps only the browser cookie and csrf token needed for server-side replay', () => {
    const request = {
        get(name) {
            const headers = {
                cookie: 'session-123=abc; Path=/',
                'x-csrf-token': 'csrf-123',
                host: '127.0.0.1:8000',
            };
            return headers[String(name).toLowerCase()] || '';
        },
    };

    const auth = plugin._test.extractReplayAuthContext(request);
    assert.deepEqual(auth, {
        cookieHeader: 'session-123=abc; Path=/',
        csrfToken: 'csrf-123',
    });
});

test('extractReplayAuthContext returns null when the start request had no replayable auth context', () => {
    const request = {
        get() {
            return '';
        },
    };

    assert.equal(plugin._test.extractReplayAuthContext(request), null);
});

test('getRequestBaseUrl maps Android emulator host aliases to the backend-local SillyTavern origin', () => {
    const request = {
        protocol: 'http',
        socket: { localPort: 8000 },
        get(name) {
            return String(name).toLowerCase() === 'host' ? '10.0.2.2:8000' : '';
        },
    };

    assert.equal(plugin._test.getRequestBaseUrl(request), 'http://127.0.0.1:8000');
});

test('getRequestBaseUrl leaves ordinary browser hosts untouched', () => {
    const request = {
        protocol: 'http',
        get(name) {
            return String(name).toLowerCase() === 'host' ? '127.0.0.1:8000' : '';
        },
    };

    assert.equal(plugin._test.getRequestBaseUrl(request), 'http://127.0.0.1:8000');
});

test('native_turn_mismatch is treated as an allowed native failure hint', () => {
    assert.equal(plugin._test.isAllowedNativeFailureReason('native_turn_mismatch'), true);
    assert.equal(plugin._test.isAllowedNativeFailureReason('native_wait_timeout'), true);
    assert.equal(plugin._test.isAllowedNativeFailureReason('totally_unknown_reason'), false);
});

test('server allowlist covers every failure code the frontend can emit', () => {
    const frontendCodes = [
        'hidden_timeout',
        'native_wait_timeout',
        'native_wait_stalled',
        'native_turn_mismatch',
        'native_turn_missing',
        'native_generation_stopped',
        'capture_chat_changed',
        'rendered_without_end',
        'grace_expired',
    ];

    for (const code of frontendCodes) {
        assert.equal(
            plugin._test.isAllowedNativeFailureReason(code),
            true,
            `${code} should be allowlisted`,
        );
    }
});

test('init() registers all plugin routes even when boot recovery throws — otherwise SillyTavern returns its outer 404 for every endpoint', async () => {
    // Build a fake express-style router that just records every registration.
    const registrations = [];
    const router = {
        get(path) {
            registrations.push({ method: 'GET', path });
        },
        post(path) {
            registrations.push({ method: 'POST', path });
        },
        delete(path) {
            registrations.push({ method: 'DELETE', path });
        },
    };

    // Force a clean boot path: clear the cached state so this test exercises
    // the init() try/catch wiring, not a previously-resolved boot.
    plugin._test.bootState.ready = false;
    plugin._test.bootState.promise = null;
    plugin._test.bootState.lastError = '';

    // init() should resolve without throwing even when ensureBackendReady
    // throws internally (which it will here because there is no SillyTavern
    // src/users.js next to the test process). The contract under test:
    //   route registration MUST happen unconditionally.
    await assert.doesNotReject(() => plugin.init(router));

    const registeredPaths = registrations.map((r) => `${r.method} ${r.path}`);
    const expectedRoutes = [
        'GET /capabilities',
        'GET /i18n-catalog',
        'GET /active',
        'GET /status/:jobId',
    ];
    for (const expected of expectedRoutes) {
        assert.ok(
            registeredPaths.includes(expected),
            `expected route "${expected}" to be registered, got: ${JSON.stringify(registeredPaths)}`,
        );
    }
});

test('restoreSinglePersistedJob skips terminal snapshots and deletes them from disk so a server restart starts with a clean retry/job slate', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'retry-mobile-restore-'));
    const handle = 'test-user';
    const userRoot = path.join(tempRoot, handle);
    const jobsDir = path.join(userRoot, 'retry-mobile', 'jobs');
    fs.mkdirSync(jobsDir, { recursive: true });

    const snapshot = {
        schemaVersion: 1,
        jobId: 'completed-job-1',
        runId: 'completed-job-1',
        state: 'completed',
        phase: 'completed',
        chatIdentity: { kind: 'character', chatId: 'chat-1', groupId: null },
        chatKey: 'character::chat-1::',
        userContext: { handle, directories: { root: userRoot } },
        acceptedCount: 2,
        attemptCount: 2,
        targetAcceptedCount: 2,
        maxAttempts: 5,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };
    const snapshotPath = path.join(jobsDir, `${snapshot.jobId}.json`);
    fs.writeFileSync(snapshotPath, JSON.stringify(snapshot), 'utf8');

    const failedSnapshot = { ...snapshot, jobId: 'failed-job-1', runId: 'failed-job-1', state: 'failed' };
    const failedPath = path.join(jobsDir, `${failedSnapshot.jobId}.json`);
    fs.writeFileSync(failedPath, JSON.stringify(failedSnapshot), 'utf8');

    const cancelledSnapshot = { ...snapshot, jobId: 'cancelled-job-1', runId: 'cancelled-job-1', state: 'cancelled' };
    const cancelledPath = path.join(jobsDir, `${cancelledSnapshot.jobId}.json`);
    fs.writeFileSync(cancelledPath, JSON.stringify(cancelledSnapshot), 'utf8');

    try {
        plugin._test.restoreSinglePersistedJob(snapshot);
        plugin._test.restoreSinglePersistedJob(failedSnapshot);
        plugin._test.restoreSinglePersistedJob(cancelledSnapshot);

        assert.equal(getJob(snapshot.jobId), null,
            'completed snapshots must not be loaded into the in-memory job store on boot');
        assert.equal(getJob(failedSnapshot.jobId), null,
            'failed snapshots must not be loaded into the in-memory job store on boot');
        assert.equal(getJob(cancelledSnapshot.jobId), null,
            'cancelled snapshots must not be loaded into the in-memory job store on boot');

        assert.equal(fs.existsSync(snapshotPath), false,
            'completed snapshot file must be deleted from disk during boot restore');
        assert.equal(fs.existsSync(failedPath), false,
            'failed snapshot file must be deleted from disk during boot restore');
        assert.equal(fs.existsSync(cancelledPath), false,
            'cancelled snapshot file must be deleted from disk during boot restore');
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('restoreSinglePersistedJob records terminal event identity and notification dedupe on running recovery', () => {
    jobs.clear();
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'retry-mobile-running-restore-'));
    const handle = 'default-user';
    const userRoot = path.join(tempRoot, handle);
    const directories = createRecoveryDirectories(userRoot);
    const chatPath = path.join(directories.chats, 'hero', 'session-1.jsonl');
    const snapshot = {
        schemaVersion: 1,
        jobId: 'restored-running-job',
        runId: 'restored-running-run',
        state: 'running',
        phase: 'awaiting_retry_results',
        chatIdentity: {
            kind: 'character',
            chatId: 'session-1',
            fileName: 'session-1',
            avatarUrl: 'hero.png',
            groupId: null,
        },
        chatKey: 'character::session-1::',
        userContext: { handle, directories },
        acceptedCount: 1,
        attemptCount: 1,
        targetAcceptedCount: 1,
        maxAttempts: 3,
        capturedChatIntegrity: 'integrity-a',
        targetFingerprint: {
            userMessageIndex: 0,
            userMessageText: 'Hello there',
        },
        runConfig: {
            notifyOnComplete: false,
            vibrateOnComplete: false,
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };
    writeJsonl(chatPath, [
        {
            chat_metadata: {
                integrity: 'integrity-a',
            },
        },
        {
            name: 'You',
            is_user: true,
            mes: 'Hello there',
        },
        {
            name: 'Hero',
            is_user: false,
            mes: 'Recovered swipe',
            swipe_info: [
                {
                    extra: {
                        retryMobileJobId: 'restored-running-job',
                    },
                },
            ],
        },
    ]);

    try {
        plugin._test.restoreSinglePersistedJob(snapshot);

        const job = getJob(snapshot.jobId);
        assert.equal(job.state, 'completed');
        assert.equal(job.lastEvent.type, 'completed');
        assert.equal(job.lastEvent.detail.source, 'restart_recovery');
        assert.equal(job.notificationLedger['terminal:completed'].eventType, 'completed');
    } finally {
        jobs.clear();
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('restorePersistedJobsWith() skips a corrupt snapshot and still processes the remaining ones — one bad snapshot must not kill the whole boot', async () => {
    const processed = [];
    const snapshots = [
        { jobId: 'good-1' },
        { jobId: 'poison', boom: true },
        { jobId: 'good-2' },
    ];

    const processSnapshot = (snapshot) => {
        if (snapshot?.boom) {
            throw new Error('simulated unrestorable snapshot');
        }
        processed.push(snapshot.jobId);
    };

    const originalConsoleError = console.error;
    console.error = () => {};
    try {
        await assert.doesNotReject(() => plugin._test.restorePersistedJobsWith(
            async () => snapshots,
            processSnapshot,
        ));
    } finally {
        console.error = originalConsoleError;
    }

    assert.deepEqual(processed, ['good-1', 'good-2'],
        'restore loop must continue past the poison snapshot and still rehydrate the survivors');
});

test('target-mutated route tombstones and cancels a running job', async () => {
    jobs.clear();
    const posts = new Map();
    const router = {
        get() {},
        post(routePath, handler) {
            posts.set(routePath, handler);
        },
    };

    plugin._test.bootState.ready = true;
    plugin._test.bootState.promise = null;
    plugin._test.bootState.lastError = '';
    await plugin.init(router);

    const identity = { kind: 'character', chatId: 'chat-target', groupId: null };
    const job = createJob({
        jobId: 'job-target',
        runId: 'run-target',
        state: 'running',
        phase: 'awaiting_retry_results',
        chatIdentity: identity,
        chatKey: buildChatKey(identity),
        targetAcceptedCount: 2,
        runConfig: {},
        userContext: {
            handle: 'test-user',
            directories: { root: path.join(os.tmpdir(), 'retry-mobile-target-route') },
        },
        skipPersist: true,
    });
    let aborted = false;
    job.jobController = {
        abort() {
            aborted = true;
        },
    };

    const response = createResponse();
    await posts.get('/target-mutated/:jobId')({
        params: { jobId: 'job-target' },
        body: {
            runId: 'run-target',
            chatIdentity: identity,
            mutationType: 'message_deleted',
            reason: 'assistant_missing_after_delete',
            sourceEvent: 'MESSAGE_DELETED',
            targetMessageVersion: 1,
        },
    }, response);

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.job.state, 'cancelled');
    assert.equal(response.body.job.recoverySuppressed, true);
    assert.equal(response.body.job.userTombstone.reason, 'assistant_missing_after_delete');
    assert.equal(response.body.job.lastEvent.type, 'user_target_mutated');
    assert.equal(getJob('job-target').cancelRequested, true);
    assert.equal(aborted, true);

    jobs.clear();
});

test('target-mutated route suppresses terminal recovery without rewriting terminal outcome', async () => {
    jobs.clear();
    const posts = new Map();
    const router = {
        get() {},
        post(routePath, handler) {
            posts.set(routePath, handler);
        },
    };

    plugin._test.bootState.ready = true;
    plugin._test.bootState.promise = null;
    plugin._test.bootState.lastError = '';
    await plugin.init(router);

    const identity = { kind: 'character', chatId: 'chat-terminal-target', groupId: null };
    createJob({
        jobId: 'job-terminal-target',
        runId: 'run-terminal-target',
        state: 'completed',
        phase: 'completed',
        chatIdentity: identity,
        chatKey: buildChatKey(identity),
        targetAcceptedCount: 2,
        lastError: '',
        runConfig: {},
        userContext: {
            handle: 'test-user',
            directories: { root: path.join(os.tmpdir(), 'retry-mobile-terminal-target-route') },
        },
        skipPersist: true,
    });

    const response = createResponse();
    await posts.get('/target-mutated/:jobId')({
        params: { jobId: 'job-terminal-target' },
        body: {
            runId: 'run-terminal-target',
            chatIdentity: identity,
            mutationType: 'message_deleted',
            reason: 'assistant_missing_after_delete',
            sourceEvent: 'MESSAGE_DELETED',
            targetMessageVersion: 2,
        },
    }, response);

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.job.state, 'completed');
    assert.equal(response.body.job.recoverySuppressed, true);
    assert.equal(response.body.job.userTombstone.reason, 'assistant_missing_after_delete');
    assert.equal(response.body.job.lastError, '');
    assert.equal(response.body.job.lastEvent.type, 'user_target_mutated');
    assert.equal(getJob('job-terminal-target').cancelRequested, false);

    jobs.clear();
});

test('target-mutated route rejects reports without a chat identity', async () => {
    jobs.clear();
    const posts = new Map();
    const router = {
        get() {},
        post(routePath, handler) {
            posts.set(routePath, handler);
        },
    };

    plugin._test.bootState.ready = true;
    plugin._test.bootState.promise = null;
    plugin._test.bootState.lastError = '';
    await plugin.init(router);

    const identity = { kind: 'character', chatId: 'chat-missing-identity', groupId: null };
    createJob({
        jobId: 'job-missing-identity',
        runId: 'run-missing-identity',
        state: 'running',
        phase: 'awaiting_retry_results',
        chatIdentity: identity,
        chatKey: buildChatKey(identity),
        targetAcceptedCount: 2,
        runConfig: {},
        userContext: {
            handle: 'test-user',
            directories: { root: path.join(os.tmpdir(), 'retry-mobile-missing-identity') },
        },
        skipPersist: true,
    });

    const response = createResponse();
    await posts.get('/target-mutated/:jobId')({
        params: { jobId: 'job-missing-identity' },
        body: {
            runId: 'run-missing-identity',
            mutationType: 'message_deleted',
            reason: 'assistant_missing_after_delete',
            sourceEvent: 'MESSAGE_DELETED',
            targetMessageVersion: 1,
        },
    }, response);

    assert.equal(response.statusCode, 400);
    assert.equal(getJob('job-missing-identity').userTombstone, null);
    assert.equal(getJob('job-missing-identity').recoverySuppressed, false);

    jobs.clear();
});

function createResponse() {
    return {
        statusCode: 200,
        body: null,
        set() {
            return this;
        },
        status(code) {
            this.statusCode = code;
            return this;
        },
        send(payload) {
            this.body = payload;
            return payload;
        },
    };
}

function createRecoveryDirectories(rootPath) {
    const directories = {
        root: rootPath,
        chats: path.join(rootPath, 'chats'),
        groupChats: path.join(rootPath, 'groups'),
        backups: path.join(rootPath, 'backups'),
    };

    fs.mkdirSync(path.join(directories.chats, 'hero'), { recursive: true });
    fs.mkdirSync(directories.groupChats, { recursive: true });
    fs.mkdirSync(directories.backups, { recursive: true });
    return directories;
}

function writeJsonl(filePath, rows) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join('\n'), 'utf8');
}
