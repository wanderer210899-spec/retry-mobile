const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { inspectRecoverySnapshot } = require('./chat-writer');

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
