const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function ensureDir(dirPath) {
    fs.mkdirSync(dirPath, { recursive: true });
}

function writeFile(filePath, text) {
    ensureDir(path.dirname(filePath));
    fs.writeFileSync(filePath, text, 'utf8');
}

function runInstaller({ repoRoot, stRoot, env }) {
    const installEntry = path.join(repoRoot, 'install.cjs');
    const result = cp.spawnSync(process.execPath, [installEntry], {
        cwd: stRoot,
        env: {
            ...process.env,
            ...env,
        },
        encoding: 'utf8',
    });

    if (result.status !== 0) {
        const detail = [
            'Installer invocation failed.',
            `cwd=${stRoot}`,
            `exit=${result.status}`,
            '',
            'stdout:',
            result.stdout || '(empty)',
            '',
            'stderr:',
            result.stderr || '(empty)',
        ].join('\n');
        throw new Error(detail);
    }

    return result;
}

function createFakeSillyTavernRoot(sandboxRoot) {
    const stRoot = path.join(sandboxRoot, 'SillyTavern');
    ensureDir(path.join(stRoot, 'plugins'));
    ensureDir(path.join(stRoot, 'public', 'scripts', 'extensions', 'third-party'));
    ensureDir(path.join(stRoot, 'data', 'default-user', 'extensions'));
    writeFile(path.join(stRoot, 'config.yaml'), [
        'dataRoot: ./data',
        'enableServerPlugins: true',
        '',
    ].join('\n'));
    return stRoot;
}

test('installer (headless) installs backend + profile frontend, then migrates to global', () => {
    const repoRoot = process.cwd();
    const releaseVersion = String(readJson(path.join(repoRoot, 'release.json'))?.version || '').trim();
    assert.ok(releaseVersion, 'release.json must include a version string for the installer tests.');

    const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'retry-mobile-installer-e2e-'));
    const stRoot = createFakeSillyTavernRoot(sandboxRoot);

    const backendTarget = path.join(stRoot, 'plugins', 'retry-mobile');
    const profileFrontendTarget = path.join(stRoot, 'data', 'default-user', 'extensions', 'retry-mobile');
    const globalFrontendTarget = path.join(stRoot, 'public', 'scripts', 'extensions', 'third-party', 'retry-mobile');

    // 1) Profile-local install (backend + profile frontend)
    runInstaller({
        repoRoot,
        stRoot,
        env: {
            RETRY_MOBILE_HEADLESS: '1',
            RETRY_MOBILE_BRANCH: 'main',
            RETRY_MOBILE_PROFILE: 'default-user',
        },
    });

    assert.ok(fs.existsSync(path.join(backendTarget, 'index.js')), 'backend should be installed');
    assert.ok(fs.existsSync(path.join(profileFrontendTarget, 'src', 'app.js')), 'profile frontend should be installed');

    const backendPackage = readJson(path.join(backendTarget, 'package.json'));
    const profileManifest = readJson(path.join(profileFrontendTarget, 'manifest.json'));
    assert.equal(backendPackage.version, releaseVersion, 'backend package.json version should match release.json');
    assert.equal(profileManifest.version, releaseVersion, 'frontend manifest.json version should match release.json');

    const profileInstallSource = readJson(path.join(profileFrontendTarget, 'install-source.json'));
    assert.equal(profileInstallSource.branch, 'main', 'install-source.json should record selected branch');

    // 2) Global install migration (backend + global frontend, profile frontend removed)
    runInstaller({
        repoRoot,
        stRoot,
        env: {
            RETRY_MOBILE_HEADLESS: '1',
            RETRY_MOBILE_BRANCH: 'main',
            RETRY_MOBILE_PROFILE: '',
        },
    });

    assert.ok(fs.existsSync(path.join(globalFrontendTarget, 'src', 'app.js')), 'global frontend should be installed');
    assert.ok(!fs.existsSync(profileFrontendTarget), 'profile frontend should be removed when installing globally');

    const globalManifest = readJson(path.join(globalFrontendTarget, 'manifest.json'));
    assert.equal(globalManifest.version, releaseVersion, 'global frontend manifest.json version should match release.json');

    const globalInstallSource = readJson(path.join(globalFrontendTarget, 'install-source.json'));
    assert.equal(globalInstallSource.branch, 'main', 'global install-source.json should record selected branch');

    fs.rmSync(sandboxRoot, { recursive: true, force: true });
});

