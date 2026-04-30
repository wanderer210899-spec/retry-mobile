const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { extractResponseText, replayCapturedRequest, resolvePendingNativeState, runJob } = require('./job-runner');

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

test('extractResponseText strips leaked thinking blocks and unwraps visible content tags', () => {
    const text = extractResponseText({
        choices: [
            {
                message: {
                    content: `<thinking>
The model should not persist this hidden reasoning.
</thinking>

<content>
『时间:放学后』

路灯下的风把校服衣角吹得轻轻晃了一下。

<report>
- 地点: 校门外旧街
- 状态: 对话继续
</report>
</content>`,
                },
            },
        ],
    });

    assert.equal(text, `『时间:放学后』

路灯下的风把校服衣角吹得轻轻晃了一下。

- 地点: 校门外旧街
- 状态: 对话继续`);
});

test('resolvePendingNativeState recovers when a frontend-confirmed native assistant is not persisted yet', async () => {
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

        assert.equal(result.outcome, 'abandoned');
        assert.equal(job.state, 'running');
        assert.equal(job.phase, 'native_abandoned');
        assert.equal(job.nativeState, 'abandoned');
        assert.equal(job.recoveryMode, 'create_missing_turn');
        assert.equal(job.structuredError, null);

        const logPath = path.join(jobsDir, 'job-native-gap.log.jsonl');
        const logText = fs.readFileSync(logPath, 'utf8');
        assert.match(logText, /native_abandoned/);
        assert.match(logText, /create the missing assistant turn/i);
        assert.doesNotMatch(logText, /native_confirmation_failed/);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('resolvePendingNativeState waits briefly for a frontend-confirmed native assistant to reach disk before failing', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'retry-mobile-native-persist-'));
    const chatsRoot = path.join(tempRoot, 'chats');
    const cardDir = path.join(chatsRoot, 'Kate');
    const jobsDir = path.join(tempRoot, 'retry-mobile', 'jobs');
    fs.mkdirSync(cardDir, { recursive: true });
    fs.mkdirSync(jobsDir, { recursive: true });

    const integrity = 'integrity-native-persist';
    const userAnchorId = 'user-anchor-native-persist';
    const assistantAnchorId = 'assistant-anchor-native-persist';
    const chatId = 'kate-native-persist';
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
        jobId: 'job-native-persist',
        runId: 'run-native-persist',
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
        targetAssistantAnchorId: assistantAnchorId,
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

    let delayedWrite = null;
    try {
        delayedWrite = setTimeout(() => {
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
                JSON.stringify({
                    name: 'Kate',
                    is_user: false,
                    is_system: false,
                    mes: 'I slow down beside you and listen.',
                    extra: {
                        retryMobileAssistantAnchorId: assistantAnchorId,
                    },
                }),
            ].join('\n'));
        }, 150);

        const result = await resolvePendingNativeState(job, 'frontend_confirmed');

        assert.equal(result.outcome, 'confirmed');
        assert.equal(job.state, 'running');
        assert.equal(job.phase, 'native_confirmed');
        assert.equal(job.nativeState, 'confirmed');
        assert.equal(job.recoveryMode, 'top_up_existing');
        assert.equal(job.structuredError, null);

        const logPath = path.join(jobsDir, 'job-native-persist.log.jsonl');
        const logText = fs.readFileSync(logPath, 'utf8');
        assert.match(logText, /native_confirmed/);
        assert.doesNotMatch(logText, /native_confirmation_failed/);
    } finally {
        if (delayedWrite) {
            clearTimeout(delayedWrite);
        }
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('runJob treats native_attempt_timeout as a timed-out first attempt and proceeds to retry generation', async () => {
    const originalFetch = global.fetch;
    const fetchCalls = [];
    global.fetch = async (url) => {
        fetchCalls.push(url);
        return {
            ok: true,
            status: 200,
            async text() {
                return JSON.stringify({ choices: [{ text: 'Recovered retry result after native timeout.' }] });
            },
        };
    };

    const now = new Date().toISOString();
    const job = {
        jobId: 'job-native-attempt-timeout',
        runId: 'run-native-attempt-timeout',
        state: 'running',
        phase: 'pending_native',
        createdAt: now,
        updatedAt: now,
        nativeState: 'pending',
        nativeResolutionCause: 'native_attempt_timeout',
        recoveryMode: '',
        acceptedCount: 0,
        targetAcceptedCount: 1,
        attemptCount: 0,
        maxAttempts: 2,
        targetMessageVersion: 0,
        targetUserAnchorId: 'user-anchor',
        targetAssistantAnchorId: 'assistant-anchor',
        capturedChatIntegrity: 'integrity',
        capturedChatLength: 1,
        targetFingerprint: {
            userMessageIndex: 0,
            userMessageText: 'hello',
        },
        chatIdentity: {
            kind: 'character',
            avatarUrl: 'Kate.png',
            chatId: 'chat-native-attempt-timeout',
            fileName: 'chat-native-attempt-timeout',
        },
        userContext: {
            handle: 'default-user',
            directories: {
                root: 'unused',
                chats: 'unused',
                groupChats: 'unused',
            },
        },
        attemptLog: [],
        runConfig: {
            attemptTimeoutSeconds: 5,
            validationMode: 'characters',
            minCharacters: 0,
            minWords: 0,
            minTokens: 0,
            allowHeuristicTokenFallback: false,
        },
        capturedRequest: {
            prompt: 'hello',
        },
        jobController: new AbortController(),
    };

    try {
        await assert.rejects(
            async () => runJob(job, { baseUrl: 'http://127.0.0.1:8000', requestAuth: null }),
            () => false,
        ).catch(() => {});
        assert.equal(job.attemptCount >= 1, true);
        assert.equal(job.attemptLog.some((entry) => entry.reason === 'native_attempt_timeout'), true);
        assert.equal(fetchCalls.length >= 1, true);
    } finally {
        global.fetch = originalFetch;
    }
});
