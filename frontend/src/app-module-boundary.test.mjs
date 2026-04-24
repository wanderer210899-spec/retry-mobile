import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const appPortsSource = readFileSync(new URL('./app-ports.js', import.meta.url), 'utf8');
const appRuntimeSyncSource = readFileSync(new URL('./app-runtime-sync.js', import.meta.url), 'utf8');
const appRecoverySource = readFileSync(new URL('./app-recovery.js', import.meta.url), 'utf8');

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

function escapeForRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

