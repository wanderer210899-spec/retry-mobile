const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { extractResponseText, replayCapturedRequest, resolvePendingNativeState } = require('./job-runner');

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
                    message: 'Too Many Requests: request limit reached.',
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
                { text: 'The wind catches my sleeve, ' },
                { text: 'and she glances over at me.' },
            ],
        },
    });

    assert.equal(text, 'The wind catches my sleeve, and she glances over at me.');
});

test('resolvePendingNativeState fails closed when a frontend-confirmed native assistant disappears before persistence confirmation', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'retry-mobile-native-gap-'));
    const chatsRoot = path.join(tempRoot, 'chats');
    const cardDir = path.join(chatsRoot, 'Kate');
    const jobsDir = path.join(tempRoot, 'retry-mobile', 'jobs');
    fs.mkdirSync(cardDir, { recursive: true });
    fs.mkdirSync(jobsDir, { recursive: true });

    const integrity = 'integrity-native-gap';
    const userAnchorId = 'user-anchor-native-gap';
    const chatId = 'kate-native-gap';
    const chatPath = path.join(cardDir, `${chatId}.jsonl`);
    fs.writeFileSync(chatPath, [
        JSON.stringify({
            chat_metadata: {
                integrity,
            },
        }),
        JSON.stringify({
            name: 'User',
            is_user: true,
            is_system: false,
            mes: 'I wait under the streetlight after class.',
            extra: {
                retryMobileUserAnchorId: userAnchorId,
            },
        }),
    ].join('\n'));

    const now = new Date().toISOString();
    const job = {
        jobId: 'job-native-gap',
        runId: 'run-native-gap',
        state: 'running',
        phase: 'native_confirming_persisted',
        createdAt: now,
        updatedAt: now,
        nativeState: 'pending',
        nativeResolutionCause: 'frontend_confirmed',
        recoveryMode: '',
        acceptedCount: 0,
        targetAcceptedCount: 2,
        attemptCount: 0,
        maxAttempts: 2,
        targetMessageVersion: 0,
        targetUserAnchorId: userAnchorId,
        targetAssistantAnchorId: 'assistant-anchor-native-gap',
        capturedChatIntegrity: integrity,
        capturedChatLength: 1,
        targetFingerprint: {
            userMessageIndex: 0,
            userMessageText: 'I wait under the streetlight after class.',
        },
        chatIdentity: {
            kind: 'character',
            avatarUrl: 'Kate.png',
            chatId,
            fileName: chatId,
        },
        userContext: {
            handle: 'default-user',
            directories: {
                root: tempRoot,
                chats: chatsRoot,
                groupChats: path.join(tempRoot, 'group chats'),
            },
        },
        attemptLog: [],
    };

    try {
        const result = await resolvePendingNativeState(job, 'frontend_confirmed');

        assert.equal(result.outcome, 'failed');
        assert.equal(job.state, 'failed');
        assert.equal(job.phase, 'failed');
        assert.equal(job.nativeState, 'failed');
        assert.equal(job.recoveryMode, '');
        assert.equal(job.structuredError?.code, 'native_turn_missing');
        assert.match(job.structuredError?.message || '', /disappeared before Retry Mobile could continue safely/i);

        const logPath = path.join(jobsDir, 'job-native-gap.log.jsonl');
        const logText = fs.readFileSync(logPath, 'utf8');
        assert.match(logText, /native_confirmation_failed/);
        assert.doesNotMatch(logText, /create the missing assistant turn/i);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});
