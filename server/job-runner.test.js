const test = require('node:test');
const assert = require('node:assert/strict');

const { replayCapturedRequest } = require('./job-runner');

test('replayCapturedRequest forwards cookie and csrf headers from the successful start request', async () => {
    const originalFetch = global.fetch;
    const seen = [];
    global.fetch = async (url, options) => {
        seen.push({ url, options });
        return {
            ok: true,
            status: 200,
            async text() {
                return JSON.stringify({ choices: [{ text: 'retry result' }] });
            },
        };
    };

    try {
        const payload = await replayCapturedRequest({
            capturedRequest: {
                chat_completion_source: 'openai',
                messages: [{ role: 'user', content: 'hello' }],
            },
            runConfig: {
                attemptTimeoutSeconds: 5,
            },
        }, {
            baseUrl: 'http://127.0.0.1:8000',
            requestAuth: {
                cookieHeader: 'session-123=abc',
                csrfToken: 'csrf-123',
            },
        });

        assert.equal(seen.length, 1);
        assert.equal(seen[0].url, 'http://127.0.0.1:8000/api/backends/chat-completions/generate');
        assert.equal(seen[0].options.headers.Cookie, 'session-123=abc');
        assert.equal(seen[0].options.headers['X-CSRF-Token'], 'csrf-123');
        assert.equal(payload.choices[0].text, 'retry result');
    } finally {
        global.fetch = originalFetch;
    }
});

test('replayCapturedRequest includes auth-context diagnostics when generation replay fails', async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => ({
        ok: false,
        status: 403,
        async text() {
            return JSON.stringify({
                error: 'Invalid CSRF token. Please refresh the page and try again.',
            });
        },
    });

    try {
        await assert.rejects(
            replayCapturedRequest({
                capturedRequest: {
                    prompt: 'hello',
                },
                runConfig: {
                    attemptTimeoutSeconds: 5,
                },
            }, {
                baseUrl: 'http://127.0.0.1:8000',
                requestAuth: {
                    cookieHeader: 'session-123=abc',
                    csrfToken: '',
                },
            }),
            (error) => {
                assert.equal(error.code, 'handoff_request_failed');
                assert.match(error.detail, /request=POST \/api\/backends\/text-completions\/generate/u);
                assert.match(error.detail, /status=403/u);
                assert.match(error.detail, /cookie=present/u);
                assert.match(error.detail, /csrf=missing/u);
                return true;
            },
        );
    } finally {
        global.fetch = originalFetch;
    }
});
