const test = require('node:test');
const assert = require('node:assert/strict');

const { extractResponseText, replayCapturedRequest } = require('./job-runner');

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

test('replayCapturedRequest treats wrapped rate-limit payloads as retryable upstream failures', async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => ({
        ok: true,
        status: 200,
        async text() {
            return JSON.stringify({
                error: {
                    message: 'Too Many Requests: 您已达到默认请求数限制：1分钟内最多请求3次，请稍后再试。',
                    type: 'new_api_error',
                },
            });
        },
    });

    try {
        await assert.rejects(
            replayCapturedRequest({
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
            }),
            (error) => {
                assert.equal(error.code, 'attempt_upstream_retryable');
                assert.match(error.message, /Too Many Requests/u);
                assert.match(error.detail, /status=200/u);
                assert.match(error.detail, /providerType=new_api_error/u);
                return true;
            },
        );
    } finally {
        global.fetch = originalFetch;
    }
});

test('extractResponseText supports responseContent.parts payloads', () => {
    const text = extractResponseText({
        responseContent: {
            parts: [
                { text: '晚风吹过校服袖口，' },
                { text: '她抬眼看了我一下。' },
            ],
        },
    });

    assert.equal(text, '晚风吹过校服袖口，她抬眼看了我一下。');
});
