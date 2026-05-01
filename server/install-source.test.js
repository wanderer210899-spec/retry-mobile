const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
    detectGitInstallSource,
    readInstallSourceFromRoot,
    resolveInstallSource,
    resolvePluginRuntimeRoot,
    writeInstallSource,
} = require('./install-source');

test('detectGitInstallSource reads branch and commit from .git HEAD refs', () => {
    const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'retry-mobile-install-source-'));
    const repoRoot = path.join(sandboxRoot, 'repo');
    const gitDir = path.join(repoRoot, '.git');
    fs.mkdirSync(path.join(gitDir, 'refs', 'heads', 'feature'), { recursive: true });
    fs.writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/feature/screen_off_initial_generation\n', 'utf8');
    fs.writeFileSync(path.join(gitDir, 'refs', 'heads', 'feature', 'screen_off_initial_generation'), 'abc123def456\n', 'utf8');

    const source = detectGitInstallSource(repoRoot, {
        defaultBranch: 'main',
        repositoryUrl: 'https://example.invalid/retry-mobile',
    });

    assert.equal(source.branch, 'feature/screen_off_initial_generation');
    assert.equal(source.commit, 'abc123def456');

    fs.rmSync(sandboxRoot, { recursive: true, force: true });
});

test('resolveInstallSource prefers override, then git, then installed metadata', () => {
    const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'retry-mobile-install-source-'));
    const repoRoot = path.join(sandboxRoot, 'repo');
    const gitDir = path.join(repoRoot, '.git');
    const installedRoot = path.join(sandboxRoot, 'installed');
    fs.mkdirSync(path.join(gitDir, 'refs', 'heads', 'feature'), { recursive: true });
    fs.writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/feature/from-git\n', 'utf8');
    fs.writeFileSync(path.join(gitDir, 'refs', 'heads', 'feature', 'from-git'), 'gitcommit\n', 'utf8');
    writeInstallSource(installedRoot, {
        branch: 'from-installed',
        commit: 'installedcommit',
        repositoryUrl: 'https://example.invalid/retry-mobile',
        installedAt: '2026-04-18T10:00:00.000Z',
        selectedFrom: 'installed',
    });

    const explicit = resolveInstallSource({
        repoRoot,
        overrideBranch: 'from-override',
        existingRoots: [installedRoot],
        defaultBranch: 'main',
        repositoryUrl: 'https://example.invalid/retry-mobile',
    });
    const fromGit = resolveInstallSource({
        repoRoot,
        overrideBranch: '',
        existingRoots: [installedRoot],
        defaultBranch: 'main',
        repositoryUrl: 'https://example.invalid/retry-mobile',
    });

    assert.equal(explicit.branch, 'from-override');
    assert.equal(explicit.selectedFrom, 'override');
    assert.equal(fromGit.branch, 'feature/from-git');
    assert.equal(fromGit.commit, 'gitcommit');
    assert.equal(fromGit.selectedFrom, 'git');

    fs.rmSync(sandboxRoot, { recursive: true, force: true });
});

test('readInstallSourceFromRoot and resolvePluginRuntimeRoot support source and installed layouts', () => {
    const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'retry-mobile-install-source-'));
    const sourceRoot = path.join(sandboxRoot, 'source-repo');
    const serverDir = path.join(sourceRoot, 'server');
    const installedRoot = path.join(sandboxRoot, 'plugins', 'retry-mobile');
    fs.mkdirSync(serverDir, { recursive: true });
    fs.mkdirSync(installedRoot, { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, 'release.json'), JSON.stringify({ version: '0.1.0' }), 'utf8');
    fs.writeFileSync(path.join(installedRoot, 'release.json'), JSON.stringify({ version: '0.1.0' }), 'utf8');
    writeInstallSource(installedRoot, {
        branch: 'feature/screen_off_initial_generation',
        commit: 'deadbeef',
        repositoryUrl: 'https://example.invalid/retry-mobile',
        installedAt: '2026-04-18T11:00:00.000Z',
        selectedFrom: 'git',
    });

    assert.equal(resolvePluginRuntimeRoot(serverDir), sourceRoot);
    assert.equal(resolvePluginRuntimeRoot(installedRoot), installedRoot);
    assert.equal(readInstallSourceFromRoot(installedRoot, { defaultBranch: 'main' }).branch, 'feature/screen_off_initial_generation');

    fs.rmSync(sandboxRoot, { recursive: true, force: true });
});
