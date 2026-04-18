const fs = require('node:fs');
const path = require('node:path');

const SNAPSHOT_SCHEMA_VERSION = 1;
const TERMINAL_JOB_RETENTION = 50;
const CIRCUIT_BREAKER_THRESHOLD = 3;
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
        circuitBreakerFile: path.join(retryRoot, 'circuit-breaker.json'),
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

    const units = listJobUnits(paths.jobsDir)
        .map((unit) => {
            const primary = readJsonIfExists(path.join(paths.jobsDir, `${unit.baseName}.json`));
            const recovery = readJsonIfExists(path.join(paths.jobsDir, `${unit.baseName}.recovery.json`));
            const effective = recovery || primary;
            return {
                ...unit,
                state: String(effective?.state || ''),
                updatedAt: effective?.updatedAt || effective?.recoveredAt || primary?.updatedAt || null,
            };
        })
        .filter((unit) => isTerminalState(unit.state))
        .sort((left, right) => {
            const leftTime = Date.parse(left.updatedAt || '') || 0;
            const rightTime = Date.parse(right.updatedAt || '') || 0;
            return rightTime - leftTime;
        });

    const toDelete = units.slice(TERMINAL_JOB_RETENTION);
    for (const unit of toDelete) {
        try {
            fs.rmSync(path.join(paths.jobsDir, `${unit.baseName}.json`), { force: true });
        } catch {}
        try {
            fs.rmSync(path.join(paths.jobsDir, `${unit.baseName}.recovery.json`), { force: true });
        } catch {}
    }
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

function getCircuitBreakerState(handle, directories, chatKey) {
    const paths = getRetryMobileUserPaths(handle, directories);
    const state = readJsonIfExists(paths.circuitBreakerFile) || {};
    const entry = state?.[chatKey];
    const count = Number.isFinite(Number(entry?.count)) ? Number(entry.count) : 0;
    return {
        count,
        blocked: count >= CIRCUIT_BREAKER_THRESHOLD,
        updatedAt: entry?.updatedAt || null,
    };
}

function incrementCircuitBreaker(handle, directories, chatKey) {
    const paths = getRetryMobileUserPaths(handle, directories);
    fs.mkdirSync(path.dirname(paths.circuitBreakerFile), { recursive: true });
    const state = readJsonIfExists(paths.circuitBreakerFile) || {};
    const current = Number.isFinite(Number(state?.[chatKey]?.count)) ? Number(state[chatKey].count) : 0;
    state[chatKey] = {
        count: current + 1,
        updatedAt: new Date().toISOString(),
    };
    writeJsonCrashResistant(paths.circuitBreakerFile, state);
    return getCircuitBreakerState(handle, directories, chatKey);
}

function resetCircuitBreaker(handle, directories, chatKey) {
    const paths = getRetryMobileUserPaths(handle, directories);
    const state = readJsonIfExists(paths.circuitBreakerFile) || {};
    if (state?.[chatKey]) {
        delete state[chatKey];
        writeJsonCrashResistant(paths.circuitBreakerFile, state);
    }
    return getCircuitBreakerState(handle, directories, chatKey);
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

module.exports = {
    SNAPSHOT_SCHEMA_VERSION,
    TERMINAL_JOB_RETENTION,
    CIRCUIT_BREAKER_THRESHOLD,
    configureJobStore,
    getRetryMobileUserPaths,
    writeJobSnapshot,
    loadPersistedJobSnapshots,
    pruneTerminalJobUnits,
    getCurrentGeneration,
    advanceGeneration,
    getCircuitBreakerState,
    incrementCircuitBreaker,
    resetCircuitBreaker,
    writeUnknownSchemaRecoverySidecar,
};
