import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appPortsSource = readFileSync(new URL('./app-ports.js', import.meta.url), 'utf8');
const appRuntimeSyncSource = readFileSync(new URL('./app-runtime-sync.js', import.meta.url), 'utf8');
const appRecoverySource = readFileSync(new URL('./app-recovery.js', import.meta.url), 'utf8');
const sessionLockdownSource = readFileSync(new URL('./ui/session-lockdown.js', import.meta.url), 'utf8');
const reconcilerSource = readFileSync(new URL('./render/reconciler.js', import.meta.url), 'utf8');

test('app-ports stays isolated from concrete adapters', () => {
    assert.doesNotMatch(
        appPortsSource,
        new RegExp(`from ['"]${escapeForRegExp('./st-adapter.js')}['"]`),
        'app-ports.js must not import st-adapter.js',
    );
    assert.doesNotMatch(
        appPortsSource,
        new RegExp(`from ['"]${escapeForRegExp('./backend-client.js')}['"]`),
        'app-ports.js must not import backend-client.js',
    );
});

test('app-runtime-sync stays isolated from concrete adapters', () => {
    assert.doesNotMatch(
        appRuntimeSyncSource,
        new RegExp(`from ['"]${escapeForRegExp('./st-adapter.js')}['"]`),
        'app-runtime-sync.js must not import st-adapter.js',
    );
    assert.doesNotMatch(
        appRuntimeSyncSource,
        new RegExp(`from ['"]${escapeForRegExp('./backend-client.js')}['"]`),
        'app-runtime-sync.js must not import backend-client.js',
    );
});

test('app-recovery stays isolated from concrete adapters', () => {
    assert.doesNotMatch(
        appRecoverySource,
        new RegExp(`from ['"]${escapeForRegExp('./st-adapter.js')}['"]`),
        'app-recovery.js must not import st-adapter.js',
    );
    assert.doesNotMatch(
        appRecoverySource,
        new RegExp(`from ['"]${escapeForRegExp('./backend-client.js')}['"]`),
        'app-recovery.js must not import backend-client.js',
    );
});

test('only session-lockdown owns blocked click and keydown interception', () => {
    assert.match(sessionLockdownSource, /addEventListener\?\.\('click'/);
    assert.match(sessionLockdownSource, /addEventListener\?\.\('keydown'/);

    const sources = collectFrontendSources().filter((entry) => !entry.filePath.endsWith(path.join('ui', 'session-lockdown.js')));
    for (const entry of sources) {
        assert.doesNotMatch(
            entry.source,
            /#send_but|\.last_mes \.swipe_right|#option_regenerate|#mes_continue|#send_textarea/,
            `Only session-lockdown.js may own blocked generation selectors (${entry.filePath})`,
        );
    }
});

test('only reconciler imports chat write helpers from st-operations', () => {
    assert.match(reconcilerSource, /from ['"]\.\.?\/st-operations\.js['"]/);
    const sources = collectFrontendSources().filter((entry) => !entry.filePath.endsWith(path.join('render', 'reconciler.js')));
    for (const entry of sources) {
        assert.doesNotMatch(
            entry.source,
            /from ['"][./]+render\/st-operations\.js['"]/,
            `Only reconciler.js may import st-operations chat write helpers (${entry.filePath})`,
        );
    }
});

test('runtime active job mirrors are only written in app-runtime-sync', () => {
    const runtimeWritePattern = /runtime\.(activeJobStatus|activeJobId|activeRunBinding)\s*=/;
    const sources = collectFrontendSources().filter((entry) => !entry.filePath.endsWith('app-runtime-sync.js'));
    for (const entry of sources) {
        assert.doesNotMatch(
            entry.source,
            runtimeWritePattern,
            `Only app-runtime-sync.js may write runtime active mirrors (${entry.filePath})`,
        );
    }
});

function escapeForRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function collectFrontendSources() {
    const root = fileURLToPath(new URL('.', import.meta.url));
    const files = listFilesRecursively(root)
        .filter((filePath) => filePath.endsWith('.js') || filePath.endsWith('.mjs'))
        .filter((filePath) => !filePath.endsWith('.test.mjs'));
    return files.map((filePath) => ({
        filePath,
        source: readFileSync(filePath, 'utf8'),
    }));
}

function listFilesRecursively(directoryPath) {
    const entries = readdirSync(directoryPath, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
        const fullPath = path.join(directoryPath, entry.name);
        if (entry.isDirectory()) {
            files.push(...listFilesRecursively(fullPath));
            continue;
        }
        files.push(fullPath);
    }
    return files;
}

