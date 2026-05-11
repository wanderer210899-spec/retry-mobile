const fs = require('node:fs');
const path = require('node:path');
const { deleteJobLog } = require('./job-log-store');

const SNAPSHOT_SCHEMA_VERSION = 1;
// Max terminal job files kept on disk per user. Per-chat-key pruning (keep newest
// per key) runs first; oldest-first eviction handles any remaining overflow.
const TERMINAL_JOB_RETENTION = 10;
const UNKNOWN_SCHEMA_REASON = 'unknown_schema_version';

let resolveUserDirectories = null;
let listUserDirectories = null;

function configureJobStore({ getUserDirectories, getUserDirectoriesList }) {
    resolveUserDirectories = getUserDirectories;
    listUserDirectories = getUserDirectoriesList;
}

function getRetryMobileUserPaths(handle, directories = null) {
    const resolvedDirectories = directories && directories.root
        ? directories
        : (typeof resolveUserDirectories === 'function' ? resolveUserDirectories(handle) : null);
    if (!resolvedDirectories?.root) {
        throw new Error(`Retry Mobile could not resolve a user data root for "${handle}".`);
    }

    const retryRoot = path.join(resolvedDirectories.root, 'retry-mobile');
    return {
        retryRoot,
        jobsDir: path.join(retryRoot, 'jobs'),
        generationFile: path.join(retryRoot, 'chat-generation.json'),
    };
}

function writeJobSnapshot(jobSnapshot) {
    const handle = String(jobSnapshot?.userContext?.handle || '').trim();
    if (!handle) {
        return;
    }

    const paths = getRetryMobileUserPaths(handle, jobSnapshot.userContext?.directories);
    fs.mkdirSync(paths.jobsDir, { recursive: true });
    const filePath = path.join(paths.jobsDir, `${jobSnapshot.jobId}.json`);
    writeJsonCrashResistant(filePath, {
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        ...jobSnapshot,
    });
}

function writeUnknownSchemaRecoverySidecar(handle, directories, jobId, snapshot, detail) {
    const paths = getRetryMobileUserPaths(handle, directories);
    fs.mkdirSync(paths.jobsDir, { recursive: true });
    const recoveryPath = path.join(paths.jobsDir, `${jobId}.recovery.json`);
    writeJsonCrashResistant(recoveryPath, {
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        jobId,
        state: 'failed',
        phase: 'failed',
        recoveryReason: UNKNOWN_SCHEMA_REASON,
        originalSchemaVersion: snapshot?.schemaVersion ?? null,
        detail,
        recoveredAt: new Date().toISOString(),
        userContext: snapshot?.userContext ?? { handle, directories },
        chatIdentity: snapshot?.chatIdentity ?? null,
        chatKey: snapshot?.chatKey ?? '',
        runId: snapshot?.runId || jobId,
        attemptLog: Array.isArray(snapshot?.attemptLog) ? snapshot.attemptLog : [],
    });
}

async function loadPersistedJobSnapshots() {
    if (typeof listUserDirectories !== 'function') {
        return [];
    }

    const allDirectories = await listUserDirectories();
    const snapshots = [];
    for (const directories of allDirectories || []) {
        const handle = inferHandleFromRoot(directories?.root);
        if (!handle) {
            continue;
        }

        const paths = getRetryMobileUserPaths(handle, directories);
        if (!fs.existsSync(paths.jobsDir)) {
            continue;
        }

        const units = listJobUnits(paths.jobsDir);
        for (const unit of units) {
            const loaded = loadJobUnit(handle, directories, unit);
            if (loaded) {
                snapshots.push(loaded);
            }
        }
    }

    return snapshots;
}

function pruneTerminalJobUnits(handle, directories) {
    const paths = getRetryMobileUserPaths(handle, directories);
    if (!fs.existsSync(paths.jobsDir)) {
        return;
    }

    const terminalUnits = listJobUnits(paths.jobsDir)
        .map((unit) => {
            const primary = readJsonIfExists(path.join(paths.jobsDir, `${unit.baseName}.json`));
            const recovery = readJsonIfExists(path.join(paths.jobsDir, `${unit.baseName}.recovery.json`));
            const effective = recovery || primary;
            return {
                ...unit,
                state: String(effective?.state || ''),
                chatKey: String(effective?.chatKey || ''),
                updatedAt: effective?.updatedAt || effective?.recoveredAt || primary?.updatedAt || null,
                timestamp: Date.parse(effective?.updatedAt || effective?.recoveredAt || primary?.updatedAt || '') || 0,
            };
        })
        .filter((unit) => isTerminalState(unit.state));

    if (terminalUnits.length <= TERMINAL_JOB_RETENTION) {
        return;
    }

    // First pass: within each chat key keep only the most recent terminal job on disk.
    // The frontend always restores by chat key, so older jobs for the same chat are
    // redundant and waste disk space.
    const byChatKey = new Map();
    for (const unit of terminalUnits) {
        const key = unit.chatKey || '';
        const existing = byChatKey.get(key);
        if (!existing || unit.timestamp > existing.timestamp) {
            byChatKey.set(key, unit);
        }
    }

    const toDelete = terminalUnits.filter((unit) => {
        const key = unit.chatKey || '';
        return byChatKey.get(key) !== unit;
    });

    for (const unit of toDelete) {
        deleteJobUnit(paths.jobsDir, unit.baseName, handle, directories);
    }

    // Second pass: if still over the global cap, evict oldest-first across all keys.
    const survivors = terminalUnits.filter((unit) => !toDelete.includes(unit));
    if (survivors.length <= TERMINAL_JOB_RETENTION) {
        return;
    }

    survivors.sort((a, b) => a.timestamp - b.timestamp); // oldest first
    const overflow = survivors.slice(0, survivors.length - TERMINAL_JOB_RETENTION);
    for (const unit of overflow) {
        deleteJobUnit(paths.jobsDir, unit.baseName, handle, directories);
    }
}

function deleteJobUnit(jobsDir, baseName, handle, directories) {
    try {
        fs.rmSync(path.join(jobsDir, `${baseName}.json`), { force: true });
    } catch {}
    try {
        fs.rmSync(path.join(jobsDir, `${baseName}.recovery.json`), { force: true });
    } catch {}
    deleteJobLog(baseName, handle, directories);
}

function getCurrentGeneration(handle, directories, chatKey) {
    const paths = getRetryMobileUserPaths(handle, directories);
    const state = readJsonIfExists(paths.generationFile) || {};
    return Number.isFinite(Number(state?.[chatKey])) ? Number(state[chatKey]) : 0;
}

function advanceGeneration(handle, directories, chatKey) {
    const paths = getRetryMobileUserPaths(handle, directories);
    fs.mkdirSync(path.dirname(paths.generationFile), { recursive: true });
    const state = readJsonIfExists(paths.generationFile) || {};
    const nextGeneration = (Number.isFinite(Number(state?.[chatKey])) ? Number(state[chatKey]) : 0) + 1;
    state[chatKey] = nextGeneration;
    writeJsonCrashResistant(paths.generationFile, state);
    return nextGeneration;
}

function rollbackGeneration(handle, directories, chatKey, { fromGeneration, toGeneration } = {}) {
    const paths = getRetryMobileUserPaths(handle, directories);
    const state = readJsonIfExists(paths.generationFile) || {};
    const current = Number.isFinite(Number(state?.[chatKey])) ? Number(state[chatKey]) : 0;
    const expectedCurrent = Number(fromGeneration);
    if (!Number.isFinite(expectedCurrent) || current !== expectedCurrent) {
        return false;
    }

    const previous = Number(toGeneration);
    if (Number.isFinite(previous) && previous > 0) {
        state[chatKey] = Math.floor(previous);
    } else {
        delete state[chatKey];
    }
    writeJsonCrashResistant(paths.generationFile, state);
    return true;
}

function writeJsonCrashResistant(filePath, data) {
    const directory = path.dirname(filePath);
    fs.mkdirSync(directory, { recursive: true });
    const tempPath = `${filePath}.tmp`;
    const payload = JSON.stringify(data, null, 2);

    const fd = fs.openSync(tempPath, 'w');
    try {
        fs.writeFileSync(fd, payload, 'utf8');
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }

    fs.renameSync(tempPath, filePath);

    try {
        const dirFd = fs.openSync(directory, 'r');
        try {
            fs.fsyncSync(dirFd);
        } finally {
            fs.closeSync(dirFd);
        }
    } catch {}
}

function listJobUnits(jobsDir) {
    const entries = fs.readdirSync(jobsDir)
        .filter((name) => name.endsWith('.json'))
        .filter((name) => !name.endsWith('.tmp'))
        .filter((name) => !name.startsWith('.'));
    const bases = new Set(entries.map((name) => name.replace(/\.recovery\.json$|\.json$/u, '')));
    return [...bases].map((baseName) => ({
        baseName,
        primaryPath: path.join(jobsDir, `${baseName}.json`),
        recoveryPath: path.join(jobsDir, `${baseName}.recovery.json`),
    }));
}

function loadJobUnit(handle, directories, unit) {
    const primary = chooseNewestSnapshot(
        readJsonIfExists(unit.primaryPath),
        readJsonIfExists(`${unit.primaryPath}.tmp`),
    );
    const recovery = chooseNewestSnapshot(
        readJsonIfExists(unit.recoveryPath),
        readJsonIfExists(`${unit.recoveryPath}.tmp`),
    );

    if (!primary && !recovery) {
        return null;
    }

    if (primary && Number(primary.schemaVersion || 0) > SNAPSHOT_SCHEMA_VERSION) {
        if (!recovery) {
            writeUnknownSchemaRecoverySidecar(
                handle,
                directories,
                primary.jobId || unit.baseName,
                primary,
                `Retry Mobile could not migrate schema version ${primary.schemaVersion}.`,
            );
        }
        const sidecar = readJsonIfExists(unit.recoveryPath);
        if (sidecar) {
            return normalizeLoadedSnapshot(sidecar, handle, directories);
        }
        return null;
    }

    return normalizeLoadedSnapshot(recovery || primary, handle, directories);
}

function normalizeLoadedSnapshot(snapshot, handle, directories) {
    if (!snapshot || typeof snapshot !== 'object') {
        return null;
    }

    return {
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        ...snapshot,
        runId: snapshot.runId || snapshot.jobId,
        userContext: {
            ...(snapshot.userContext || {}),
            handle,
            directories,
        },
    };
}

function chooseNewestSnapshot(primary, fallback) {
    if (!primary) {
        return fallback || null;
    }
    if (!fallback) {
        return primary;
    }

    const primaryTime = Date.parse(primary.updatedAt || primary.recoveredAt || '') || 0;
    const fallbackTime = Date.parse(fallback.updatedAt || fallback.recoveredAt || '') || 0;
    return fallbackTime > primaryTime ? fallback : primary;
}

function readJsonIfExists(filePath) {
    try {
        if (!fs.existsSync(filePath)) {
            return null;
        }
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
        return null;
    }
}

function inferHandleFromRoot(rootPath) {
    if (!rootPath) {
        return '';
    }

    return path.basename(rootPath);
}

function isTerminalState(state) {
    return state === 'completed' || state === 'failed' || state === 'cancelled';
}

// Used by boot-time restore to evict terminal-state snapshot files. The
// in-memory restore already skips them, but they accumulate on disk across
// runs and re-surface as `/latest` results after a restart, which breaks the
// "fresh slate after server restart / update" expectation.
function deletePersistedJobSnapshot(snapshot) {
    const handle = String(snapshot?.userContext?.handle || '').trim();
    const jobId = String(snapshot?.jobId || '').trim();
    if (!handle || !jobId) {
        return;
    }

    let paths;
    try {
        paths = getRetryMobileUserPaths(handle, snapshot.userContext?.directories);
    } catch {
        return;
    }

    if (!fs.existsSync(paths.jobsDir)) {
        return;
    }

    deleteJobUnit(paths.jobsDir, jobId, handle, snapshot.userContext?.directories);
}

module.exports = {
    SNAPSHOT_SCHEMA_VERSION,
    TERMINAL_JOB_RETENTION,
    configureJobStore,
    getRetryMobileUserPaths,
    writeJobSnapshot,
    loadPersistedJobSnapshots,
    pruneTerminalJobUnits,
    deletePersistedJobSnapshot,
    getCurrentGeneration,
    advanceGeneration,
    rollbackGeneration,
    writeUnknownSchemaRecoverySidecar,
};
