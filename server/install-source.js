const fs = require('node:fs');
const path = require('node:path');

const INSTALL_SOURCE_FILE = 'install-source.json';
const RELEASE_MANIFEST_FILE = 'release.json';

function resolvePluginRuntimeRoot(moduleDir) {
    const current = path.resolve(moduleDir || '.');
    if (hasRuntimeMarker(current)) {
        return current;
    }

    const parent = path.dirname(current);
    if (parent !== current && hasRuntimeMarker(parent)) {
        return parent;
    }

    return current;
}

function hasRuntimeMarker(root) {
    return fs.existsSync(path.join(root, INSTALL_SOURCE_FILE))
        || fs.existsSync(path.join(root, RELEASE_MANIFEST_FILE));
}

function readInstallSourceFromRoot(root, options = {}) {
    const runtimeRoot = resolvePluginRuntimeRoot(root);
    const filePath = path.join(runtimeRoot, INSTALL_SOURCE_FILE);
    const payload = readJsonFile(filePath);
    if (!payload) {
        return null;
    }

    return normalizeInstallSource(payload, options);
}

function writeInstallSource(targetRoot, payload) {
    const destination = path.join(path.resolve(targetRoot), INSTALL_SOURCE_FILE);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const normalized = normalizeInstallSource(payload, {
        defaultBranch: payload?.branch || 'main',
        repositoryUrl: payload?.repositoryUrl || '',
    });
    fs.writeFileSync(destination, `${JSON.stringify(normalized, null, 4)}\n`, 'utf8');
    return destination;
}

function resolveInstallSource({
    repoRoot,
    overrideBranch,
    overrideUiLanguage,
    existingRoots = [],
    defaultBranch = 'main',
    repositoryUrl = '',
}) {
    const normalizedOverride = normalizeString(overrideBranch);
    const gitSource = detectGitInstallSource(repoRoot, { defaultBranch, repositoryUrl });
    const existingSource = readFirstInstalledSource(existingRoots, { defaultBranch, repositoryUrl });

    const branch = normalizedOverride
        || gitSource?.branch
        || existingSource?.branch
        || normalizeString(defaultBranch)
        || 'main';

    const gitBranchMatchesOverride = !normalizedOverride || normalizedOverride === gitSource?.branch;
    const commit = gitBranchMatchesOverride
        ? normalizeString(gitSource?.commit) || normalizeString(existingSource?.commit)
        : normalizeString(existingSource?.commit);

    return normalizeInstallSource({
        branch,
        commit,
        repositoryUrl,
        uiLanguage: normalizeLanguageCode(overrideUiLanguage) || normalizeLanguageCode(existingSource?.uiLanguage),
        selectedFrom: normalizedOverride
            ? 'override'
            : (gitSource?.branch
                ? 'git'
                : (existingSource?.branch ? 'installed' : 'default')),
    }, { defaultBranch, repositoryUrl });
}

function detectGitInstallSource(repoRoot, options = {}) {
    const resolvedRoot = path.resolve(repoRoot || '.');
    const gitDir = resolveGitDir(resolvedRoot);
    if (!gitDir) {
        return null;
    }

    const headPath = path.join(gitDir, 'HEAD');
    if (!fs.existsSync(headPath)) {
        return null;
    }

    const headText = normalizeString(fs.readFileSync(headPath, 'utf8'));
    if (!headText) {
        return null;
    }

    if (headText.startsWith('ref:')) {
        const refPath = normalizeString(headText.slice(4));
        const branch = refPath.replace(/^refs\/heads\//, '');
        return normalizeInstallSource({
            branch,
            commit: readGitRefCommit(gitDir, refPath),
            repositoryUrl: options.repositoryUrl || '',
            selectedFrom: 'git',
        }, options);
    }

    return normalizeInstallSource({
        branch: options.defaultBranch || 'main',
        commit: headText,
        repositoryUrl: options.repositoryUrl || '',
        selectedFrom: 'git_detached',
    }, options);
}

function resolveGitDir(repoRoot) {
    const dotGitPath = path.join(repoRoot, '.git');
    if (!fs.existsSync(dotGitPath)) {
        return null;
    }

    const stats = fs.statSync(dotGitPath);
    if (stats.isDirectory()) {
        return dotGitPath;
    }

    if (!stats.isFile()) {
        return null;
    }

    const raw = normalizeString(fs.readFileSync(dotGitPath, 'utf8'));
    if (!raw.toLowerCase().startsWith('gitdir:')) {
        return null;
    }

    const gitDir = normalizeString(raw.slice(7));
    return gitDir ? path.resolve(repoRoot, gitDir) : null;
}

function readGitRefCommit(gitDir, refPath) {
    const looseRefPath = path.join(gitDir, ...refPath.split('/'));
    if (fs.existsSync(looseRefPath)) {
        return normalizeString(fs.readFileSync(looseRefPath, 'utf8'));
    }

    const packedRefsPath = path.join(gitDir, 'packed-refs');
    if (!fs.existsSync(packedRefsPath)) {
        return '';
    }

    const lines = fs.readFileSync(packedRefsPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
        if (!line || line.startsWith('#') || line.startsWith('^')) {
            continue;
        }

        const [hash, name] = line.split(' ');
        if (name === refPath) {
            return normalizeString(hash);
        }
    }

    return '';
}

function readFirstInstalledSource(roots, options = {}) {
    for (const root of roots) {
        if (!root) {
            continue;
        }

        const source = readInstallSourceFromRoot(root, options);
        if (source?.branch) {
            return source;
        }
    }

    return null;
}

function normalizeInstallSource(payload, options = {}) {
    return {
        branch: normalizeString(payload?.branch) || normalizeString(options.defaultBranch) || 'main',
        commit: normalizeString(payload?.commit),
        repositoryUrl: normalizeString(payload?.repositoryUrl) || normalizeString(options.repositoryUrl),
        installedAt: normalizeString(payload?.installedAt),
        selectedFrom: normalizeString(payload?.selectedFrom),
        uiLanguage: normalizeLanguageCode(payload?.uiLanguage) || normalizeLanguageCode(options.uiLanguage) || '',
    };
}

function readJsonFile(filePath) {
    if (!filePath || !fs.existsSync(filePath)) {
        return null;
    }

    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
        return null;
    }
}

function normalizeString(value) {
    return String(value || '').trim();
}

function normalizeLanguageCode(value) {
    const normalized = String(value || '').trim().toLowerCase();
    return normalized === 'zh' ? 'zh' : normalized === 'en' ? 'en' : '';
}

module.exports = {
    INSTALL_SOURCE_FILE,
    RELEASE_MANIFEST_FILE,
    detectGitInstallSource,
    readInstallSourceFromRoot,
    resolveInstallSource,
    resolvePluginRuntimeRoot,
    writeInstallSource,
};
