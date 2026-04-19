const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
    advanceGeneration,
    configureJobStore,
    getCurrentGeneration,
    getRetryMobileUserPaths,
    pruneTerminalJobUnits,
    writeJobSnapshot,
} = require('./job-store');

function createUserDirectories(rootPath) {
    return {
        root: rootPath,
        chats: path.join(rootPath, 'chats'),
        groupChats: path.join(rootPath, 'groups'),
        backups: path.join(rootPath, 'backups'),
    };
}

function setupStore() {
    const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'retry-mobile-store-'));
    const userRoot = path.join(sandboxRoot, 'default-user');
    const directories = createUserDirectories(userRoot);
    fs.mkdirSync(userRoot, { recursive: true });
    configureJobStore({
        getUserDirectories: () => directories,
        getUserDirectoriesList: async () => [directories],
    });
    return { sandboxRoot, directories };
}

test('generation index starts at zero and increments per chat', () => {
    const { sandboxRoot, directories } = setupStore();
    const chatKey = 'character::chat-1::';

    assert.equal(getCurrentGeneration('default-user', directories, chatKey), 0);
    assert.equal(advanceGeneration('default-user', directories, chatKey), 1);
    assert.equal(advanceGeneration('default-user', directories, chatKey), 2);
    assert.equal(getCurrentGeneration('default-user', directories, chatKey), 2);

    fs.rmSync(sandboxRoot, { recursive: true, force: true });
});

test('pruning deletes job snapshots and their sidecars as a unit', () => {
    const { sandboxRoot, directories } = setupStore();
    const paths = getRetryMobileUserPaths('default-user', directories);
    fs.mkdirSync(paths.jobsDir, { recursive: true });

    for (let index = 0; index < 55; index += 1) {
        const jobId = `job-${String(index).padStart(2, '0')}`;
        writeJobSnapshot({
            jobId,
            runId: jobId,
            state: 'completed',
            phase: 'completed',
            updatedAt: new Date(2026, 0, index + 1).toISOString(),
            userContext: {
                handle: 'default-user',
                directories,
            },
        });

        if (index === 0) {
            fs.writeFileSync(path.join(paths.jobsDir, `${jobId}.recovery.json`), JSON.stringify({
                jobId,
                state: 'failed',
                phase: 'failed',
                recoveredAt: new Date(2026, 0, 1).toISOString(),
            }));
            fs.writeFileSync(path.join(paths.jobsDir, `${jobId}.log.jsonl`), `${JSON.stringify({
                at: new Date(2026, 0, 1).toISOString(),
                source: 'backend',
                event: 'job_completed',
                summary: 'Stored for pruning coverage.',
            })}\n`);
        }
    }

    pruneTerminalJobUnits('default-user', directories);

    assert.equal(fs.existsSync(path.join(paths.jobsDir, 'job-00.json')), false);
    assert.equal(fs.existsSync(path.join(paths.jobsDir, 'job-00.recovery.json')), false);
    assert.equal(fs.existsSync(path.join(paths.jobsDir, 'job-00.log.jsonl')), false);
    assert.equal(fs.existsSync(path.join(paths.jobsDir, 'job-54.json')), true);

    fs.rmSync(sandboxRoot, { recursive: true, force: true });
});
