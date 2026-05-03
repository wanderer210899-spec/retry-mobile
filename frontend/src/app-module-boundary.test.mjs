import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appPortsSource = readFileSync(new URL('./app-ports.js', import.meta.url), 'utf8');
const appRuntimeSyncSource = readFileSync(new URL('./app-runtime-sync.js', import.meta.url), 'utf8');
const appRecoverySource = readFileSync(new URL('./app-recovery.js', import.meta.url), 'utf8');
const sessionLockdownSource = readFileSync(new URL('./st-bridge/lockdown.js', import.meta.url), 'utf8');

test('app-ports stays isolated from concrete adapter factories', () => {
    // app-ports must not construct its own ST or backend ports; the composition
    // root in app.js injects them.
    assert.doesNotMatch(
        appPortsSource,
        /\bcreateStPort\b/,
        'app-ports.js must not import createStPort (composition root only)',
    );
    assert.doesNotMatch(
        appPortsSource,
        /\bcreateBackendPort\b/,
        'app-ports.js must not import createBackendPort (composition root only)',
    );
});

test('app-runtime-sync stays isolated from concrete adapter factories', () => {
    assert.doesNotMatch(
        appRuntimeSyncSource,
        /\bcreateStPort\b/,
        'app-runtime-sync.js must not import createStPort',
    );
    assert.doesNotMatch(
        appRuntimeSyncSource,
        /\bcreateBackendPort\b/,
        'app-runtime-sync.js must not import createBackendPort',
    );
});

test('app-recovery stays isolated from concrete adapter factories', () => {
    assert.doesNotMatch(
        appRecoverySource,
        /\bcreateStPort\b/,
        'app-recovery.js must not import createStPort',
    );
    assert.doesNotMatch(
        appRecoverySource,
        /\bcreateBackendPort\b/,
        'app-recovery.js must not import createBackendPort',
    );
});

test('only st-bridge/lockdown owns blocked click and keydown interception', () => {
    assert.match(sessionLockdownSource, /addEventListener\?\.\('click'/);
    assert.match(sessionLockdownSource, /addEventListener\?\.\('keydown'/);

    const sources = collectFrontendSources()
        .filter((entry) => !entry.filePath.endsWith(path.join('st-bridge', 'lockdown.js')));
    for (const entry of sources) {
        assert.doesNotMatch(
            entry.source,
            /#send_but|\.last_mes \.swipe_right|#option_regenerate|#mes_continue|#send_textarea/,
            `Only st-bridge/lockdown.js may own blocked generation selectors (${entry.filePath})`,
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
