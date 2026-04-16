const fs = require('node:fs');
const path = require('node:path');

const { DEFAULT_BRANCH, PLUGIN_ID, PLUGIN_NAME, REPOSITORY_URL } = require('./plugin-meta');

const RAW_REPOSITORY_BASE = REPOSITORY_URL.replace('https://github.com/', 'https://raw.githubusercontent.com/');

async function getReleaseInfo(request) {
    const backendPackage = readJsonFile(path.join(__dirname, 'package.json')) || {};
    const frontendInstall = resolveFrontendInstall(request);
    const latest = {
        backendVersion: '',
        frontendVersion: '',
        checkedAt: new Date().toISOString(),
    };

    const update = {
        canCheck: false,
        hasUpdate: false,
        backendOutdated: false,
        frontendOutdated: false,
        message: 'Update check has not run yet.',
    };

    try {
        const latestVersions = await fetchLatestVersions();
        latest.backendVersion = latestVersions.backendVersion;
        latest.frontendVersion = latestVersions.frontendVersion;
        latest.checkedAt = new Date().toISOString();

        update.canCheck = true;
        update.backendOutdated = compareVersions(backendPackage.version, latest.backendVersion) < 0;
        update.frontendOutdated = frontendInstall.installed && compareVersions(frontendInstall.version, latest.frontendVersion) < 0;
        update.hasUpdate = update.backendOutdated || update.frontendOutdated;
        update.message = update.hasUpdate
            ? 'A newer Retry Mobile build is available. From your local SillyTavern directory, run the installer and choose Install / Update now.'
            : 'Retry Mobile is up to date.';
    } catch (error) {
        update.message = error instanceof Error ? error.message : String(error);
    }

    return {
        pluginId: PLUGIN_ID,
        pluginName: PLUGIN_NAME,
        repositoryUrl: REPOSITORY_URL,
        branch: DEFAULT_BRANCH,
        installed: {
            backend: {
                installed: true,
                version: typeof backendPackage.version === 'string' ? backendPackage.version : '',
                location: 'plugins/retry-mobile',
            },
            frontend: frontendInstall,
        },
        latest,
        update,
        instructions: {
            updateNow: 'From your local SillyTavern directory, run the Retry Mobile bootstrap installer and choose Install / Update now.',
            addProfile: 'From your local SillyTavern directory, run the Retry Mobile bootstrap installer and choose Install / Update now to add another profile or install for everyone.',
        },
    };
}

function resolveFrontendInstall(request) {
    const localBase = request?.user?.directories?.extensions;
    const localPath = localBase ? path.join(localBase, PLUGIN_ID) : '';
    const globalPath = path.join(process.cwd(), 'public', 'scripts', 'extensions', 'third-party', PLUGIN_ID);

    const localManifest = readJsonFile(localPath ? path.join(localPath, 'manifest.json') : '');
    if (localManifest) {
        return {
            installed: true,
            version: typeof localManifest.version === 'string' ? localManifest.version : '',
            scope: 'current-profile',
            location: 'Current profile',
        };
    }

    const globalManifest = readJsonFile(path.join(globalPath, 'manifest.json'));
    if (globalManifest) {
        return {
            installed: true,
            version: typeof globalManifest.version === 'string' ? globalManifest.version : '',
            scope: 'global',
            location: 'All profiles (global third-party)',
        };
    }

    return {
        installed: false,
        version: '',
        scope: 'missing',
        location: 'Not installed for this profile',
    };
}

async function fetchLatestVersions() {
    const [backendPackage, frontendManifest] = await Promise.all([
        fetchJson(`${RAW_REPOSITORY_BASE}/${DEFAULT_BRANCH}/server/package.json`),
        fetchJson(`${RAW_REPOSITORY_BASE}/${DEFAULT_BRANCH}/frontend/manifest.json`),
    ]);

    return {
        backendVersion: typeof backendPackage?.version === 'string' ? backendPackage.version : '',
        frontendVersion: typeof frontendManifest?.version === 'string' ? frontendManifest.version : '',
    };
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
