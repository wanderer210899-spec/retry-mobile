const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const COMPAT_DIR_NAME = '_retry-mobile';
const COMPAT_FILE_NAME = 'compat-probe.jsonl';

const runtimeState = {
    initialized: false,
    initializing: null,
    tokenizerHelpers: null,
    tokenizerHelpersLoading: null,
    compatibility: {
        nativeSaveSupport: false,
        userDirectorySupport: false,
        userDirectoryScanSupport: false,
        detail: 'Retry Mobile has not checked SillyTavern save compatibility yet.',
        checkedAt: null,
    },
    getUserDirectories: null,
    getUserDirectoriesList: null,
    trySaveChat: null,
};

async function initializeStRuntime() {
    if (runtimeState.initialized) {
        return getCompatibilitySnapshot();
    }

    if (runtimeState.initializing) {
        await runtimeState.initializing;
        return getCompatibilitySnapshot();
    }

    runtimeState.initializing = (async () => {
        try {
            const usersModule = await importModuleFromServer('users.js');
            const chatsModule = await importModuleFromServer(path.join('endpoints', 'chats.js'));
            const getUserDirectories = resolveModuleFunction(usersModule, 'getUserDirectories');
            const getAllUserHandles = resolveModuleFunction(usersModule, 'getAllUserHandles');
            const getUserDirectoriesList = buildUserDirectoriesListGetter(usersModule, getUserDirectories, getAllUserHandles);
            const trySaveChat = resolveModuleFunction(chatsModule, 'trySaveChat');
            const detailParts = [];

            runtimeState.getUserDirectories = typeof getUserDirectories === 'function'
                ? getUserDirectories
                : null;
            runtimeState.getUserDirectoriesList = typeof getUserDirectoriesList === 'function'
                ? getUserDirectoriesList
                : null;
            runtimeState.trySaveChat = typeof trySaveChat === 'function'
                ? trySaveChat
                : null;

            if (typeof getUserDirectories !== 'function') {
                detailParts.push('SillyTavern getUserDirectories helper is unavailable.');
            }

            if (typeof getUserDirectoriesList !== 'function') {
                detailParts.push('SillyTavern getUserDirectoriesList helper is unavailable, so persisted-job restore scanning is disabled.');
            }

            if (typeof trySaveChat !== 'function') {
                detailParts.push('SillyTavern trySaveChat helper is unavailable.');
            }

            let nativeSaveSupport = false;
            if (typeof trySaveChat === 'function') {
                const probeResult = await runCompatibilityProbe(trySaveChat);
                nativeSaveSupport = Boolean(probeResult.nativeSaveSupport);
                if (probeResult.detail) {
                    detailParts.push(probeResult.detail);
                }
            }

            runtimeState.compatibility = {
                nativeSaveSupport,
                userDirectorySupport: typeof getUserDirectories === 'function',
                userDirectoryScanSupport: typeof getUserDirectoriesList === 'function',
                detail: detailParts.join(' ').trim() || 'Retry Mobile verified the current SillyTavern runtime helpers.',
                checkedAt: new Date().toISOString(),
            };
        } catch (error) {
            runtimeState.compatibility = {
                nativeSaveSupport: false,
                userDirectorySupport: typeof runtimeState.getUserDirectories === 'function',
                userDirectoryScanSupport: typeof runtimeState.getUserDirectoriesList === 'function',
                detail: error instanceof Error ? error.message : String(error),
                checkedAt: new Date().toISOString(),
            };
        } finally {
            runtimeState.initialized = true;
            runtimeState.initializing = null;
        }
    })();

    await runtimeState.initializing;
    return getCompatibilitySnapshot();
}

function getCompatibilitySnapshot() {
    return {
        nativeSaveSupport: Boolean(runtimeState.compatibility.nativeSaveSupport),
        userDirectorySupport: Boolean(runtimeState.compatibility.userDirectorySupport),
        userDirectoryScanSupport: Boolean(runtimeState.compatibility.userDirectoryScanSupport),
        detail: String(runtimeState.compatibility.detail || ''),
        checkedAt: runtimeState.compatibility.checkedAt || null,
    };
}

function ensureRuntimeReady() {
    if (!runtimeState.initialized) {
        throw new Error('Retry Mobile ST runtime was not initialized.');
    }

    return runtimeState;
}

function getUserDirectories(handle) {
    const state = ensureRuntimeReady();
    if (typeof state.getUserDirectories !== 'function') {
        throw new Error(state.compatibility.detail || 'Retry Mobile user-directory support is unavailable in this SillyTavern runtime.');
    }
    return state.getUserDirectories(handle);
}

async function getUserDirectoriesList() {
    const state = ensureRuntimeReady();
    if (typeof state.getUserDirectoriesList !== 'function') {
        return [];
    }
    return await state.getUserDirectoriesList();
}

function getNativeSaveSupport() {
    return Boolean(runtimeState.compatibility.nativeSaveSupport);
}

async function saveChatThroughSt({ chatData, filePath, skipIntegrityCheck = false, handle, cardName, backupDirectory }) {
    const state = ensureRuntimeReady();
    if (!state.compatibility.nativeSaveSupport || typeof state.trySaveChat !== 'function') {
        throw new Error(state.compatibility.detail || 'Retry Mobile native save compatibility is unavailable.');
    }

    return await state.trySaveChat(chatData, filePath, skipIntegrityCheck, handle, cardName, backupDirectory);
}

async function importModuleFromServer(relativePath) {
    const targetPath = path.join(process.cwd(), 'src', relativePath);
    if (!fs.existsSync(targetPath)) {
        throw new Error(`SillyTavern runtime module is missing: ${targetPath}`);
    }

    const moduleUrl = pathToFileURL(targetPath).href;
    return await import(moduleUrl);
}

function resolveModuleFunction(moduleNamespace, name) {
    if (!moduleNamespace || typeof moduleNamespace !== 'object') {
        return null;
    }

    if (typeof moduleNamespace[name] === 'function') {
        return moduleNamespace[name];
    }

    const nestedDefault = moduleNamespace.default;
    if (nestedDefault && typeof nestedDefault === 'object' && typeof nestedDefault[name] === 'function') {
        return nestedDefault[name];
    }

    return null;
}

async function getTokenizerHelpers() {
    if (runtimeState.tokenizerHelpers) {
        return runtimeState.tokenizerHelpers;
    }

    if (runtimeState.tokenizerHelpersLoading) {
        return await runtimeState.tokenizerHelpersLoading;
    }

    runtimeState.tokenizerHelpersLoading = (async () => {
        const tokenizersModule = await importModuleFromServer(path.join('endpoints', 'tokenizers.js'));
        const helpers = {
            getSentencepiceTokenizer: resolveModuleFunction(tokenizersModule, 'getSentencepiceTokenizer'),
            getTokenizerModel: resolveModuleFunction(tokenizersModule, 'getTokenizerModel'),
            getTiktokenTokenizer: resolveModuleFunction(tokenizersModule, 'getTiktokenTokenizer'),
            getWebTokenizer: resolveModuleFunction(tokenizersModule, 'getWebTokenizer'),
        };

        if (typeof helpers.getTokenizerModel !== 'function') {
            throw new Error('SillyTavern tokenizer model helper is unavailable.');
        }

        if (typeof helpers.getTiktokenTokenizer !== 'function') {
            throw new Error('SillyTavern tiktoken helper is unavailable.');
        }

        runtimeState.tokenizerHelpers = helpers;
        return helpers;
    })();

    try {
        return await runtimeState.tokenizerHelpersLoading;
    } finally {
        runtimeState.tokenizerHelpersLoading = null;
    }
}

function resolveTokenizerModelHint(tokenizerDescriptor = null, requestModel = '') {
    const descriptor = tokenizerDescriptor && typeof tokenizerDescriptor === 'object'
        ? tokenizerDescriptor
        : null;
    const descriptorSource = typeof descriptor?.source === 'string'
        ? descriptor.source.trim()
        : '';
    const descriptorModel = typeof descriptor?.model === 'string'
        ? descriptor.model.trim()
        : '';
    const normalizedRequestModel = typeof requestModel === 'string'
        ? requestModel.trim()
        : '';

    return descriptorModel || descriptorSource || normalizedRequestModel || '';
}

async function countTextTokensWithSt(text, options = {}) {
    const normalizedText = typeof text === 'string'
        ? text
        : String(text ?? '');
    const modelHint = resolveTokenizerModelHint(options.tokenizerDescriptor, options.requestModel);
    if (!modelHint) {
        return {
            ok: false,
            tokenCount: null,
            source: 'unavailable',
            tokenizerModel: null,
            detail: 'Retry Mobile did not receive a tokenizer model hint from SillyTavern chat metadata or the captured request.',
        };
    }

    const helpers = await getTokenizerHelpers();
    const canonicalModel = helpers.getTokenizerModel(modelHint) || modelHint;

    try {
        const webTokenizer = typeof helpers.getWebTokenizer === 'function'
            ? helpers.getWebTokenizer(canonicalModel) || helpers.getWebTokenizer(modelHint)
            : null;
        if (webTokenizer) {
            const instance = await webTokenizer.get();
            if (!instance) {
                throw new Error(`SillyTavern could not load the "${canonicalModel}" web tokenizer.`);
            }

            const tokenCount = Array.from(instance.encode(normalizedText)).length;
            return {
                ok: true,
                tokenCount,
                source: 'sillytavern_web_tokenizer',
                tokenizerModel: canonicalModel,
                detail: '',
            };
        }

        const sentencepieceTokenizer = typeof helpers.getSentencepiceTokenizer === 'function'
            ? helpers.getSentencepiceTokenizer(canonicalModel) || helpers.getSentencepiceTokenizer(modelHint)
            : null;
        if (sentencepieceTokenizer) {
            const instance = await sentencepieceTokenizer.get();
            if (!instance) {
                throw new Error(`SillyTavern could not load the "${canonicalModel}" sentencepiece tokenizer.`);
            }

            const encoded = instance.encodeIds(normalizedText);
            const tokenCount = Array.from(encoded ?? []).length;
            return {
                ok: true,
                tokenCount,
                source: 'sillytavern_sentencepiece_tokenizer',
                tokenizerModel: canonicalModel,
                detail: '',
            };
        }

        const tiktoken = helpers.getTiktokenTokenizer(canonicalModel);
        if (!tiktoken || typeof tiktoken.encode !== 'function') {
            throw new Error(`SillyTavern could not resolve a tokenizer implementation for "${canonicalModel}".`);
        }

        const tokenCount = Array.from(tiktoken.encode(normalizedText)).length;
        return {
            ok: true,
            tokenCount,
            source: 'sillytavern_tiktoken',
            tokenizerModel: canonicalModel,
            detail: '',
        };
    } catch (error) {
        return {
            ok: false,
            tokenCount: null,
            source: 'unavailable',
            tokenizerModel: canonicalModel,
            detail: error instanceof Error ? error.message : String(error),
        };
    }
}

function buildUserDirectoriesListGetter(moduleNamespace, getUserDirectories, getAllUserHandles) {
    const directGetter = resolveModuleFunction(moduleNamespace, 'getUserDirectoriesList');
    if (typeof directGetter === 'function') {
        return directGetter;
    }

    if (typeof getUserDirectories === 'function' && typeof getAllUserHandles === 'function') {
        return async function fallbackGetUserDirectoriesList() {
            const handles = await getAllUserHandles();
            return (Array.isArray(handles) ? handles : [])
                .map((handle) => getUserDirectories(handle))
                .filter((directories) => Boolean(directories?.root));
        };
    }

    return null;
}

async function runCompatibilityProbe(trySaveChat) {
    const dataRoot = String(globalThis.DATA_ROOT || '').trim();
    if (!dataRoot) {
        throw new Error('SillyTavern DATA_ROOT is unavailable, so Retry Mobile cannot probe chat-save compatibility.');
    }

    const compatDir = path.join(dataRoot, COMPAT_DIR_NAME, 'compat');
    const backupsDir = path.join(compatDir, 'backups');
    const probeFilePath = path.join(compatDir, COMPAT_FILE_NAME);
    fs.mkdirSync(backupsDir, { recursive: true });

    const headerA = {
        chat_metadata: {
            integrity: 'retry-mobile-probe-a',
        },
        user_name: 'unused',
        character_name: 'unused',
    };
    const headerB = {
        chat_metadata: {
            integrity: 'retry-mobile-probe-b',
        },
        user_name: 'unused',
        character_name: 'unused',
    };
    const message = {
        name: 'You',
        is_user: true,
        is_system: false,
        send_date: new Date().toISOString(),
        mes: 'compatibility probe',
        extra: {},
    };

    try {
        try {
            fs.rmSync(probeFilePath, { force: true });
        } catch {}

        await trySaveChat([headerA, message], probeFilePath, false, 'retry-mobile-probe', 'retry-mobile-probe', backupsDir);

        let integrityRejected = false;
        try {
            await trySaveChat([headerB, message], probeFilePath, false, 'retry-mobile-probe', 'retry-mobile-probe', backupsDir);
        } catch (error) {
            const messageText = String(error?.message || error || '').toLowerCase();
            integrityRejected = messageText.includes('integrity');
        }

        if (!integrityRejected) {
            throw new Error('SillyTavern trySaveChat compatibility probe did not reject an integrity mismatch.');
        }

        return {
            nativeSaveSupport: true,
            detail: 'Retry Mobile verified direct trySaveChat access and integrity mismatch handling.',
            checkedAt: new Date().toISOString(),
        };
    } finally {
        try {
            fs.rmSync(compatDir, { recursive: true, force: true });
        } catch {}
    }
}

module.exports = {
    COMPAT_DIR_NAME,
    buildUserDirectoriesListGetter,
    countTextTokensWithSt,
    resolveTokenizerModelHint,
    initializeStRuntime,
    getCompatibilitySnapshot,
    getUserDirectories,
    getUserDirectoriesList,
    getNativeSaveSupport,
    resolveModuleFunction,
    saveChatThroughSt,
};
