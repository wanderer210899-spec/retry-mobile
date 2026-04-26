const test = require('node:test');
const assert = require('node:assert/strict');

const plugin = require('./index');

test('extractReplayAuthContext keeps only the browser cookie and csrf token needed for server-side replay', () => {
    const request = {
        get(name) {
            const headers = {
                cookie: 'session-123=abc; Path=/',
                'x-csrf-token': 'csrf-123',
                host: '127.0.0.1:8000',
            };
            return headers[String(name).toLowerCase()] || '';
        },
    };

    const auth = plugin._test.extractReplayAuthContext(request);
    assert.deepEqual(auth, {
        cookieHeader: 'session-123=abc; Path=/',
        csrfToken: 'csrf-123',
    });
});

test('extractReplayAuthContext returns null when the start request had no replayable auth context', () => {
    const request = {
        get() {
            return '';
        },
    };

    assert.equal(plugin._test.extractReplayAuthContext(request), null);
});

test('native_turn_mismatch is treated as an allowed native failure hint', () => {
    assert.equal(plugin._test.isAllowedNativeFailureReason('native_turn_mismatch'), true);
    assert.equal(plugin._test.isAllowedNativeFailureReason('native_wait_timeout'), true);
    assert.equal(plugin._test.isAllowedNativeFailureReason('totally_unknown_reason'), false);
});

test('server allowlist covers every failure code the frontend can emit', () => {
    const frontendCodes = [
        'hidden_timeout',
        'native_wait_timeout',
        'native_wait_stalled',
        'native_turn_mismatch',
        'native_turn_missing',
        'native_generation_stopped',
        'capture_chat_changed',
        'rendered_without_end',
        'grace_expired',
    ];

    for (const code of frontendCodes) {
        assert.equal(
            plugin._test.isAllowedNativeFailureReason(code),
            true,
            `${code} should be allowlisted`,
        );
    }
});

test('init() registers all plugin routes even when boot recovery throws — otherwise SillyTavern returns its outer 404 for every endpoint', async () => {
    // Build a fake express-style router that just records every registration.
    const registrations = [];
    const router = {
        get(path) {
            registrations.push({ method: 'GET', path });
        },
        post(path) {
            registrations.push({ method: 'POST', path });
        },
        delete(path) {
            registrations.push({ method: 'DELETE', path });
        },
    };

    // Force a clean boot path: clear the cached state so this test exercises
    // the init() try/catch wiring, not a previously-resolved boot.
    plugin._test.bootState.ready = false;
    plugin._test.bootState.promise = null;
    plugin._test.bootState.lastError = '';

    // init() should resolve without throwing even when ensureBackendReady
    // throws internally (which it will here because there is no SillyTavern
    // src/users.js next to the test process). The contract under test:
    //   route registration MUST happen unconditionally.
    await assert.doesNotReject(() => plugin.init(router));

    const registeredPaths = registrations.map((r) => `${r.method} ${r.path}`);
    const expectedRoutes = [
        'GET /capabilities',
        'GET /i18n-catalog',
        'GET /active',
        'GET /status/:jobId',
    ];
    for (const expected of expectedRoutes) {
        assert.ok(
            registeredPaths.includes(expected),
            `expected route "${expected}" to be registered, got: ${JSON.stringify(registeredPaths)}`,
        );
    }
});

test('restorePersistedJobsWith() skips a corrupt snapshot and still processes the remaining ones — one bad snapshot must not kill the whole boot', async () => {
    const processed = [];
    const snapshots = [
        { jobId: 'good-1' },
        { jobId: 'poison', boom: true },
        { jobId: 'good-2' },
    ];

    const processSnapshot = (snapshot) => {
        if (snapshot?.boom) {
            throw new Error('simulated unrestorable snapshot');
        }
        processed.push(snapshot.jobId);
    };

    const originalConsoleError = console.error;
    console.error = () => {};
    try {
        await assert.doesNotReject(() => plugin._test.restorePersistedJobsWith(
            async () => snapshots,
            processSnapshot,
        ));
    } finally {
        console.error = originalConsoleError;
    }

    assert.deepEqual(processed, ['good-1', 'good-2'],
        'restore loop must continue past the poison snapshot and still rehydrate the survivors');
});
