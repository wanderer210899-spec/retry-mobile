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
