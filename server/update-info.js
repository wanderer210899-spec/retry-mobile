const fs = require('node:fs');
const path = require('node:path');

const { readInstallSourceFromRoot, resolvePluginRuntimeRoot } = require('./install-source');
const { DEFAULT_BRANCH, PLUGIN_ID, PLUGIN_NAME, REPOSITORY_URL } = require('./plugin-meta');

const RAW_REPOSITORY_BASE = REPOSITORY_URL.replace('https://github.com/', 'https://raw.githubusercontent.com/');
const RELEASE_MANIFEST_FILE = 'release.json';

async function getReleaseInfo() {
    const runtimeRoot = resolvePluginRuntimeRoot(__dirname);
    const installSource = readInstallSourceFromRoot(runtimeRoot, {
        defaultBranch: DEFAULT_BRANCH,
        repositoryUrl: REPOSITORY_URL,
    }) || {
        branch: DEFAULT_BRANCH,
        commit: '',
        installedAt: '',
        repositoryUrl: REPOSITORY_URL,
        selectedFrom: 'default',
        uiLanguage: '',
    };
    const selectedBranch = installSource.branch || DEFAULT_BRANCH;
    const localRelease = readJsonFile(path.join(runtimeRoot, RELEASE_MANIFEST_FILE)) || {};
    const localVersion = typeof localRelease.version === 'string' ? localRelease.version : '';
    const latest = {
        version: '',
        branch: selectedBranch,
        checkedAt: new Date().toISOString(),
    };

    const update = {
        canCheck: false,
        hasUpdate: false,
        message: 'Update check has not run yet.',
    };

    try {
        const latestRelease = await fetchLatestReleaseManifest(selectedBranch);
        latest.version = typeof latestRelease.version === 'string' ? latestRelease.version : '';
        latest.checkedAt = new Date().toISOString();

        update.canCheck = Boolean(localVersion && latest.version);
        update.hasUpdate = update.canCheck && compareVersions(localVersion, latest.version) < 0;
        update.message = update.canCheck
            ? (update.hasUpdate
                ? 'A newer Retry Mobile build is available. From your local SillyTavern directory, run the installer and choose Install / Update now.'
                : 'Retry Mobile is up to date.')
            : 'Release manifest missing a version value.';
    } catch (error) {
        update.message = error instanceof Error ? error.message : String(error);
    }

    return {
        pluginId: PLUGIN_ID,
        pluginName: PLUGIN_NAME,
        repositoryUrl: REPOSITORY_URL,
        branch: selectedBranch,
        installed: {
            version: localVersion,
            branch: selectedBranch,
            commit: installSource.commit || '',
            installedAt: installSource.installedAt || '',
            selectedFrom: installSource.selectedFrom || '',
            uiLanguage: installSource.uiLanguage || '',
        },
        latest,
        update,
        instructions: {
            updateNow: `From your local SillyTavern directory, run the Retry Mobile bootstrap installer for branch "${selectedBranch}" and choose Install / Update now.`,
            addProfile: `From your local SillyTavern directory, run the Retry Mobile bootstrap installer for branch "${selectedBranch}" and choose Install / Update now to add another profile or install for everyone.`,
        },
    };
}

async function fetchLatestReleaseManifest(branch) {
    return fetchJson(`${RAW_REPOSITORY_BASE}/${branch}/${RELEASE_MANIFEST_FILE}`);
}

async function fetchJson(url) {
    const options = {};
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
        options.signal = AbortSignal.timeout(8000);
    }

    const response = await fetch(url, options);
    if (!response.ok) {
        throw new Error(`Update check failed at ${url} (${response.status}).`);
    }

    return response.json();
}

function readJsonFile(filePath) {
    if (!filePath || !fs.existsSync(filePath)) {
        return null;
    }

    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function compareVersions(left, right) {
    const leftParts = normalizeVersion(left);
    const rightParts = normalizeVersion(right);
    const length = Math.max(leftParts.length, rightParts.length);

    for (let index = 0; index < length; index += 1) {
        const leftPart = leftParts[index] ?? 0;
        const rightPart = rightParts[index] ?? 0;
        if (leftPart > rightPart) {
            return 1;
        }
        if (leftPart < rightPart) {
            return -1;
        }
    }

    return 0;
}

function normalizeVersion(value) {
    return String(value || '')
        .trim()
        .replace(/^v/i, '')
        .split('.')
        .map((part) => Number.parseInt(part, 10))
        .filter((part) => Number.isFinite(part));
}

module.exports = {
    getReleaseInfo,
};
