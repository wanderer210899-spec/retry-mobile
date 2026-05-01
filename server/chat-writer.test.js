const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { applyAcceptedResultToMessage, inspectRecoverySnapshot } = require('./chat-writer');

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
