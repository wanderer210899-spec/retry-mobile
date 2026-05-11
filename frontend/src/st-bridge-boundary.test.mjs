// st-bridge-boundary.test.mjs
//
// Enforces the architectural rule that all SillyTavern integration goes
// through `frontend/src/st-bridge/`. No other frontend file may:
//   - call `window.SillyTavern` / `globalThis.SillyTavern` / `SillyTavern.getContext`
//   - reach into st-bridge internal sub-modules (must use `st-bridge/index.js`)
//   - hardcode ST event-name string literals
//   - hardcode ST-specific DOM selector strings
//   - read/write the ST-owned `body.dataset.generating` flag
//
// The rule is asymmetric: files inside `st-bridge/` may freely cross-import
// each other. Tests under any path are exempt from the source-side rule but
// still must not reach into bridge internals from outside the bridge.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ST_PORT_METHOD_ALLOWLIST } from './st-bridge/port.js';
import { createStPort } from './st-bridge/index.js';

const SRC_ROOT = fileURLToPath(new URL('.', import.meta.url));
const BRIDGE_ROOT = path.join(SRC_ROOT, 'st-bridge');

test('only st-bridge/internal/ctx.js calls window.SillyTavern.getContext', () => {
    // Match actual call syntax (`window.SillyTavern?.` chain, or
    // `SillyTavern.getContext?.(` invocation) — not comments or diagnostic
    // strings that merely mention the API by name.
    const callPattern = /(?:window|globalThis)\.SillyTavern\s*\?\.|SillyTavern\.getContext\s*\?\.\s*\(/;
    const offenders = collectFrontendSources()
        .filter((entry) => !entry.filePath.endsWith(path.join('st-bridge', 'internal', 'ctx.js')))
        .filter((entry) => callPattern.test(entry.source));
    assert.deepEqual(
        offenders.map((entry) => path.relative(SRC_ROOT, entry.filePath)),
        [],
        'window.SillyTavern access is allowed only inside st-bridge/internal/ctx.js',
    );
});

test('files outside st-bridge/ may not reach into bridge internal modules', () => {
    const offenders = collectFrontendSources()
        .filter((entry) => !isInsideBridge(entry.filePath))
        .filter((entry) => /from ['"](\.\.?\/)+st-bridge\/(?!index\.js['"])/.test(entry.source));
    assert.deepEqual(
        offenders.map((entry) => path.relative(SRC_ROOT, entry.filePath)),
        [],
        'Outside callers must import from st-bridge/index.js, not deep into sub-modules',
    );
});

test('files outside st-bridge/ may not subscribe to ST event names directly', () => {
    // Hardcoded event-name string literals from SillyTavern's eventTypes table.
    // These strings should only appear inside the bridge.
    const stEventLiterals = /['"](GENERATION_STARTED|GENERATION_ENDED|GENERATION_STOPPED|MESSAGE_SENT|MESSAGE_RECEIVED|MESSAGE_DELETED|MESSAGE_EDITED|MESSAGE_UPDATED|MESSAGE_SWIPED|MESSAGE_SWIPE_DELETED|CHARACTER_MESSAGE_RENDERED|CHAT_CHANGED|CHAT_DELETED|GENERATE_AFTER_DATA|CHAT_COMPLETION_SETTINGS_READY|TEXT_COMPLETION_SETTINGS_READY)['"]/;

    const offenders = collectFrontendSources()
        .filter((entry) => !isInsideBridge(entry.filePath))
        .filter((entry) => stEventLiterals.test(entry.source));
    assert.deepEqual(
        offenders.map((entry) => path.relative(SRC_ROOT, entry.filePath)),
        [],
        'ST event-name literals are allowed only inside st-bridge/',
    );
});

test('files outside st-bridge/ may not hardcode ST-specific DOM selectors', () => {
    // Selector list mirrors ST's own send-bar and message DOM. New selectors
    // discovered during ST integration must be added to st-bridge/lockdown.js
    // or st-bridge/internal/dom-readiness.js, not scattered across callers.
    const stDomSelectors = /['"]#send_but['"]|['"]#send_textarea['"]|['"]#option_regenerate['"]|['"]#option_continue['"]|['"]#mes_continue['"]|['"]#mes_impersonate['"]|['"]#mes_stop['"]|\.last_mes \.swipe_right|\.mes\[mesid|\.mes_text/;

    const offenders = collectFrontendSources()
        .filter((entry) => !isInsideBridge(entry.filePath))
        .filter((entry) => stDomSelectors.test(entry.source));
    assert.deepEqual(
        offenders.map((entry) => path.relative(SRC_ROOT, entry.filePath)),
        [],
        'ST-specific DOM selectors are allowed only inside st-bridge/',
    );
});

test('files outside st-bridge/ may not touch the ST body.dataset.generating flag', () => {
    const offenders = collectFrontendSources()
        .filter((entry) => !isInsideBridge(entry.filePath))
        .filter((entry) => /body\?\.\s*dataset\?\.\s*generating|body\.dataset\.generating/.test(entry.source));
    assert.deepEqual(
        offenders.map((entry) => path.relative(SRC_ROOT, entry.filePath)),
        [],
        'body.dataset.generating is owned by ST; only st-bridge/ may inspect or mutate it',
    );
});

test('files outside st-bridge/ may not import legacy st-* paths that have been consolidated', () => {
    const legacyPaths = /from ['"](\.\.?\/)+(st-context|st-capture|st-chat|st-lifecycle|st-adapter|render\/(st-operations|reconciler|readiness)|ui\/session-lockdown)\.js['"]/;
    const offenders = collectFrontendSources()
        .filter((entry) => legacyPaths.test(entry.source));
    assert.deepEqual(
        offenders.map((entry) => path.relative(SRC_ROOT, entry.filePath)),
        [],
        'Legacy ST adapter files have been consolidated into st-bridge/; update imports to st-bridge/index.js',
    );
});

test('createStPort() returns exactly the documented allowlist of methods', () => {
    // createSessionLockdown reads `document` as a default parameter, so the
    // test needs a minimal stub even though no listeners are bound until
    // setLockdown(true) is called.
    const originalDocument = globalThis.document;
    const originalWindow = globalThis.window;
    globalThis.document = { visibilityState: 'visible' };
    globalThis.window = {};

    try {
        const port = createStPort({
            onCapture() {},
            onCaptureCancelled() {},
            onCaptureEvent() {},
            onNativeReady() {},
            onNativeFailed() {},
            onNativeEvent() {},
        });

        const actualKeys = Object.keys(port).sort();
        const allowedKeys = [...ST_PORT_METHOD_ALLOWLIST].sort();
        assert.deepEqual(
            actualKeys,
            allowedKeys,
            'StPort surface must match port.js allowlist; update both to add a new method',
        );
    } finally {
        globalThis.document = originalDocument;
        globalThis.window = originalWindow;
    }
});

function collectFrontendSources() {
    const files = listFilesRecursively(SRC_ROOT)
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

function isInsideBridge(filePath) {
    const normalized = path.resolve(filePath);
    return normalized === BRIDGE_ROOT || normalized.startsWith(`${BRIDGE_ROOT}${path.sep}`);
}
