const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
    applyAcceptedResultToMessage,
    assertWritePathReady,
    inspectNativeAssistantState,
    inspectRecoverySnapshot,
    writeAcceptedResult,
} = require('./chat-writer');

function createDirectories(rootPath) {
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
    fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join('\n'));
}

function createJob(directories, overrides = {}) {
    return {
        jobId: 'job-1',
        acceptedCount: 1,
        targetAcceptedCount: 1,
        capturedChatIntegrity: 'integrity-a',
        targetFingerprint: {
            userMessageIndex: 0,
            userMessageText: 'Hello there',
        },
        chatIdentity: {
            kind: 'character',
            chatId: 'session-1',
            fileName: 'session-1',
            avatarUrl: 'hero.png',
            assistantName: 'Hero',
        },
        userContext: {
            handle: 'default-user',
            directories,
        },
        ...overrides,
    };
}

test('recovery marks completed when live tagged swipes meet the target', () => {
    const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'retry-mobile-recovery-'));
    const directories = createDirectories(sandboxRoot);
    const chatPath = path.join(directories.chats, 'hero', 'session-1.jsonl');
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
                        retryMobileJobId: 'job-1',
                    },
                },
            ],
        },
    ]);

    const result = inspectRecoverySnapshot(createJob(directories));
    assert.equal(result.reason, 'completed_on_recovery');
    assert.equal(result.acceptedCount, 1);

    fs.rmSync(sandboxRoot, { recursive: true, force: true });
});

test('recovery becomes ambiguous when the live chat has fewer tagged swipes than the snapshot floor', () => {
    const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'retry-mobile-recovery-'));
    const directories = createDirectories(sandboxRoot);
    const chatPath = path.join(directories.chats, 'hero', 'session-1.jsonl');
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
            mes: 'Untracked swipe',
            swipe_info: [],
        },
    ]);

    const result = inspectRecoverySnapshot(createJob(directories, {
        acceptedCount: 2,
        targetAcceptedCount: 3,
    }));
    assert.equal(result.reason, 'recovery_ambiguous');
    assert.equal(result.floor, 2);
    assert.equal(result.ceiling, 0);

    fs.rmSync(sandboxRoot, { recursive: true, force: true });
});

test('recovery adopts liveCeiling when disk has more tagged swipes than the snapshot floor (partial recovery)', () => {
    const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'retry-mobile-recovery-ceil-'));
    const directories = createDirectories(sandboxRoot);
    const chatPath = path.join(directories.chats, 'hero', 'session-1.jsonl');
    // Disk has 2 tagged swipes; snapshot only recorded 1 (backend restarted mid-run)
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
            mes: 'Second swipe',
            swipe_info: [
                {
                    extra: { retryMobileJobId: 'job-1' },
                },
                {
                    extra: { retryMobileJobId: 'job-1' },
                },
            ],
        },
    ]);

    const result = inspectRecoverySnapshot(createJob(directories, {
        acceptedCount: 1,
        targetAcceptedCount: 3,
    }));
    assert.equal(result.reason, 'partial_on_recovery', 'partial recovery when liveCeiling > persistedFloor but not yet at target');
    assert.equal(result.floor, 1);
    assert.equal(result.ceiling, 2);
    assert.equal(result.acceptedCount, 2, 'resolvedAcceptedCount adopts the higher liveCeiling');

    fs.rmSync(sandboxRoot, { recursive: true, force: true });
});

test('appending an accepted swipe preserves the currently selected swipe', () => {
    const message = {
        mes: 'Current swipe',
        extra: {
            slot: 'current',
        },
        send_date: '2026-04-18T22:16:00.000Z',
        gen_started: '2026-04-18T22:16:00.000Z',
        gen_finished: '2026-04-18T22:16:00.000Z',
        swipes: [
            'Older swipe',
            'Current swipe',
        ],
        swipe_info: [
            {
                send_date: '2026-04-18T22:15:00.000Z',
                gen_started: '2026-04-18T22:15:00.000Z',
                gen_finished: '2026-04-18T22:15:00.000Z',
                extra: {
                    slot: 'older',
                },
            },
            {
                send_date: '2026-04-18T22:16:00.000Z',
                gen_started: '2026-04-18T22:16:00.000Z',
                gen_finished: '2026-04-18T22:16:00.000Z',
                extra: {
                    slot: 'current',
                },
            },
        ],
        swipe_id: 1,
    };

    applyAcceptedResultToMessage({
        jobId: 'job-1',
        acceptedCount: 1,
        capturedRequest: {
            model: 'test-model',
        },
    }, message, {
        text: 'Newest retry swipe',
        characterCount: 1234,
        tokenCount: 321,
    }, '2026-04-18T22:17:00.000Z');

    assert.equal(message.swipes.length, 3);
    assert.equal(message.swipes[2], 'Newest retry swipe');
    assert.equal(message.swipe_id, 1);
    assert.equal(message.mes, 'Current swipe');
    assert.deepEqual(message.extra, {
        slot: 'current',
    });
    assert.equal(message.send_date, '2026-04-18T22:16:00.000Z');
});

test('the first accepted result seeds swipe storage and selects it', () => {
    const message = {
        mes: '',
        extra: {},
        swipes: [],
        swipe_info: [],
        swipe_id: 0,
    };

    applyAcceptedResultToMessage({
        jobId: 'job-2',
        acceptedCount: 0,
        capturedRequest: {
            model: 'seed-model',
        },
    }, message, {
        text: 'First accepted swipe',
        characterCount: 456,
        tokenCount: 78,
    }, '2026-04-18T22:18:00.000Z');

    assert.deepEqual(message.swipes, ['First accepted swipe']);
    assert.equal(message.swipe_id, 0);
    assert.equal(message.mes, 'First accepted swipe');
    assert.equal(message.extra.retryMobileJobId, 'job-2');
    assert.equal(message.send_date, '2026-04-18T22:18:00.000Z');
});

test('inspectNativeAssistantState returns target_pending when the assistant slot still matches the captured baseline', () => {
    const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'retry-mobile-baseline-'));
    const directories = createDirectories(sandboxRoot);
    const chatPath = path.join(directories.chats, 'hero', 'session-1.jsonl');
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
            mes: 'Stale prior reply',
            swipes: ['Stale prior reply'],
            swipe_id: 0,
            gen_finished: '2026-05-03T22:00:00.000Z',
        },
    ]);

    const job = createJob(directories, {
        acceptedCount: 0,
        targetFingerprint: {
            userMessageIndex: 0,
            userMessageText: 'Hello there',
            assistantBaseline: {
                messageText: 'Stale prior reply',
                swipeCount: 1,
                swipeId: 0,
                genFinished: '2026-05-03T22:00:00.000Z',
            },
        },
    });

    const inspection = inspectNativeAssistantState(job);
    assert.equal(inspection.kind, 'target_pending');
    assert.equal(inspection.baselineMatch, true);
    assert.equal(inspection.assistantMessage?.mes, 'Stale prior reply');

    fs.rmSync(sandboxRoot, { recursive: true, force: true });
});

test('write path refuses tombstoned jobs so user-deleted targets are not recreated', () => {
    const job = createJob({}, {
        nativeState: 'abandoned',
        recoveryMode: 'create_missing_turn',
        recoverySuppressed: true,
        userTombstone: {
            mutationType: 'message_deleted',
            reason: 'assistant_missing_after_delete',
        },
    });

    assert.throws(
        () => assertWritePathReady(job),
        /user changed or deleted the target message/,
    );
});

test('writeAcceptedResult fails closed when chat identity is missing', async () => {
    const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'retry-mobile-missing-chat-'));
    const directories = createDirectories(sandboxRoot);
    const job = createJob(directories, {
        chatIdentity: null,
    });

    try {
        await assert.rejects(
            writeAcceptedResult(job, {
                text: 'Accepted backend result long enough to write.',
                characterCount: 45,
                wordCount: 7,
                tokenCount: 0,
            }),
            (error) => {
                assert.equal(error.code, 'backend_write_failed');
                assert.match(error.message, /chat identity/u);
                return true;
            },
        );
    } finally {
        fs.rmSync(sandboxRoot, { recursive: true, force: true });
    }
});

test('inspectNativeAssistantState treats a persisted pre-swipe prefix as target_pending when capture saw a new empty swipe slot', () => {
    const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'retry-mobile-baseline-prefix-'));
    const directories = createDirectories(sandboxRoot);
    const chatPath = path.join(directories.chats, 'hero', 'session-1.jsonl');
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
            mes: 'Second prior swipe',
            swipes: ['First prior swipe', 'Second prior swipe'],
            swipe_id: 1,
            gen_finished: '2026-05-03T22:00:00.000Z',
        },
    ]);

    const job = createJob(directories, {
        acceptedCount: 0,
        targetFingerprint: {
            userMessageIndex: 0,
            userMessageText: 'Hello there',
            assistantBaseline: {
                messageText: '',
                swipes: ['First prior swipe', 'Second prior swipe', ''],
                swipeCount: 3,
                swipeId: 2,
                genFinished: '2026-05-03T22:00:00.000Z',
            },
        },
    });

    const inspection = inspectNativeAssistantState(job);
    assert.equal(inspection.kind, 'target_pending');
    assert.equal(inspection.baselineMatch, true);

    fs.rmSync(sandboxRoot, { recursive: true, force: true });
});

test('inspectNativeAssistantState treats an unchanged prepared empty swipe as target_pending despite volatile timestamps', () => {
    const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'retry-mobile-baseline-prepared-equal-'));
    const directories = createDirectories(sandboxRoot);
    const chatPath = path.join(directories.chats, 'hero', 'session-1.jsonl');
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
            mes: 'Second prior swipe',
            swipes: ['First prior swipe', 'Second prior swipe', ''],
            swipe_id: 1,
            gen_finished: '2026-05-11T10:00:05.000Z',
        },
    ]);

    const job = createJob(directories, {
        acceptedCount: 0,
        targetFingerprint: {
            userMessageIndex: 0,
            userMessageText: 'Hello there',
            assistantBaseline: {
                messageText: '',
                swipes: ['First prior swipe', 'Second prior swipe', ''],
                swipeCount: 3,
                swipeId: 2,
                genFinished: '2026-05-11T10:00:00.000Z',
            },
        },
    });

    const inspection = inspectNativeAssistantState(job);
    assert.equal(inspection.kind, 'target_pending');
    assert.equal(inspection.baselineMatch, true);

    fs.rmSync(sandboxRoot, { recursive: true, force: true });
});

test('inspectNativeAssistantState returns filled once the assistant slot diverges from the baseline', () => {
    const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'retry-mobile-baseline-'));
    const directories = createDirectories(sandboxRoot);
    const chatPath = path.join(directories.chats, 'hero', 'session-1.jsonl');
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
            mes: 'Fresh new generation',
            swipes: ['Stale prior reply', 'Fresh new generation'],
            swipe_id: 1,
            gen_finished: '2026-05-03T22:55:00.000Z',
        },
    ]);

    const job = createJob(directories, {
        acceptedCount: 0,
        targetFingerprint: {
            userMessageIndex: 0,
            userMessageText: 'Hello there',
            assistantBaseline: {
                messageText: 'Stale prior reply',
                swipeCount: 1,
                swipeId: 0,
                genFinished: '2026-05-03T22:00:00.000Z',
            },
        },
    });

    const inspection = inspectNativeAssistantState(job);
    assert.equal(inspection.kind, 'filled');
    assert.equal(inspection.assistantMessage?.mes, 'Fresh new generation');

    fs.rmSync(sandboxRoot, { recursive: true, force: true });
});

test('replace_rejected_native overwrites the existing native swipe instead of appending', () => {
    const message = {
        mes: 'short native reply',
        extra: { existing: true },
        swipes: ['short native reply'],
        swipe_info: [{ extra: { existing: true } }],
        swipe_id: 0,
    };

    applyAcceptedResultToMessage({
        jobId: 'job-replace-native',
        acceptedCount: 0,
        recoveryMode: 'replace_rejected_native',
        capturedRequest: {
            model: 'replace-model',
        },
    }, message, {
        text: 'Accepted backend retry',
        characterCount: 1024,
        tokenCount: 256,
    }, '2026-04-18T22:19:00.000Z');

    assert.equal(message.swipes.length, 1);
    assert.equal(message.swipes[0], 'Accepted backend retry');
    assert.equal(message.swipe_id, 0);
    assert.equal(message.mes, 'Accepted backend retry');
    assert.equal(message.extra.retryMobileJobId, 'job-replace-native');
});
