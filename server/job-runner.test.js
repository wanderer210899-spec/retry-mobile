const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
    extractNativeReplyText,
    extractResponseText,
    replayCapturedRequest,
    resolveNativeAttempt,
    resolvePendingNativeState,
    runJob,
} = require('./job-runner');

function buildResolveAttemptJob(overrides = {}) {
    return {
        jobId: 'resolve-native-test-job',
        runId: 'resolve-native-test-run',
        state: 'running',
        phase: 'native_confirmed',
        attemptCount: 0,
        acceptedCount: 0,
        targetAcceptedCount: 2,
        maxAttempts: 5,
        nativeState: 'confirmed',
        nativeAttemptResolved: false,
        recoveryMode: 'top_up_existing',
        cancelRequested: false,
        captureConfirmedAt: '2026-05-03T10:00:00.000Z',
        targetMessage: {
            mes: 'Native first reply text body that is long enough to pass.',
            swipes: ['Native first reply text body that is long enough to pass.'],
            swipe_id: 0,
            extra: {},
        },
        acceptedResults: [],
        attemptLog: [],
        runConfig: {
            validationMode: 'characters',
            minCharacters: 10,
            minWords: 0,
            minTokens: 0,
            allowHeuristicTokenFallback: false,
        },
        capturedRequest: { model: 'native-test-model' },
        // userContext omitted on purpose — appendJobLog/ensureJobLog short-circuit
        // when job.userContext.handle is missing, so tests stay disk-free.
        ...overrides,
    };
}

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

test('replayCapturedRequest treats plain transient HTTP failures as retryable upstream failures', async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => ({
        ok: false,
        status: 500,
        async text() {
            return 'Internal Server Error';
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
                assert.match(error.message, /status 500/u);
                assert.match(error.detail, /status=500/u);
                assert.match(error.detail, /response=Internal Server Error/u);
                return true;
            },
        );
    } finally {
        global.fetch = originalFetch;
    }
});

test('replayCapturedRequest treats wrapped internal provider errors as retryable upstream failures', async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => ({
        ok: true,
        status: 200,
        async text() {
            return JSON.stringify({
                error: {
                    message: 'Internal Server Error',
                    type: 'server_error',
                    code: 'internal_error',
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
                assert.match(error.message, /Internal Server Error/u);
                assert.match(error.detail, /providerCode=internal_error/u);
                assert.match(error.detail, /providerType=server_error/u);
                return true;
            },
        );
    } finally {
        global.fetch = originalFetch;
    }
});

test('replayCapturedRequest treats message-only internal provider errors as retryable upstream failures', async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => ({
        ok: true,
        status: 200,
        async text() {
            return JSON.stringify({
                error: {
                    message: 'Internal Server Error',
                },
                quota_error: false,
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
                assert.match(error.message, /Internal Server Error/u);
                assert.match(error.detail, /status=200/u);
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

test('resolvePendingNativeState abandons a baseline-matching assistant on explicit native timeout', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'retry-mobile-native-baseline-timeout-'));
    const chatsRoot = path.join(tempRoot, 'chats');
    const cardDir = path.join(chatsRoot, 'Kate');
    fs.mkdirSync(cardDir, { recursive: true });

    const integrity = 'integrity-native-baseline-timeout';
    const userAnchorId = 'user-anchor-native-baseline-timeout';
    const chatId = 'kate-native-baseline-timeout';
    const staleReply = 'This stale assistant reply existed before the current retry capture.';
    const staleFinishedAt = '2026-05-03T22:00:00.000Z';
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
        JSON.stringify({
            name: 'Kate',
            is_user: false,
            is_system: false,
            mes: staleReply,
            swipes: [staleReply],
            swipe_id: 0,
            gen_finished: staleFinishedAt,
            extra: {},
        }),
    ].join('\n'));

    const now = new Date().toISOString();
    const job = {
        jobId: 'job-native-baseline-timeout',
        runId: 'run-native-baseline-timeout',
        state: 'running',
        phase: 'pending_native',
        createdAt: now,
        updatedAt: now,
        nativeState: 'pending',
        nativeResolutionCause: 'native_wait_timeout',
        recoveryMode: '',
        acceptedCount: 0,
        targetAcceptedCount: 1,
        attemptCount: 0,
        maxAttempts: 3,
        targetMessageVersion: 0,
        targetUserAnchorId: userAnchorId,
        targetAssistantAnchorId: 'assistant-anchor-native-baseline-timeout',
        capturedChatIntegrity: integrity,
        capturedChatLength: 2,
        targetFingerprint: {
            userMessageIndex: 0,
            userMessageText: 'I wait under the streetlight after class.',
            assistantBaseline: {
                messageText: staleReply,
                swipeCount: 1,
                swipeId: 0,
                genFinished: staleFinishedAt,
            },
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
        const result = await resolvePendingNativeState(job, 'native_wait_timeout');

        assert.equal(result.outcome, 'abandoned');
        assert.equal(job.state, 'running');
        assert.equal(job.phase, 'native_abandoned');
        assert.equal(job.nativeState, 'abandoned');
        assert.equal(job.recoveryMode, 'reuse_empty_placeholder');
        assert.equal(job.inspectionAttempts, 1);
        assert.equal(job.assistantMessageIndex, 1);
    } finally {
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

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'retry-mobile-native-attempt-timeout-'));
    const chatsRoot = path.join(tempRoot, 'chats');
    const cardDir = path.join(chatsRoot, 'Kate');
    const jobsDir = path.join(tempRoot, 'retry-mobile', 'jobs');
    fs.mkdirSync(jobsDir, { recursive: true });
    fs.mkdirSync(cardDir, { recursive: true });

    const integrity = 'integrity-native-attempt-timeout';
    const userAnchorId = 'user-anchor';
    const chatId = 'chat-native-attempt-timeout';
    fs.writeFileSync(path.join(cardDir, `${chatId}.jsonl`), [
        JSON.stringify({ chat_metadata: { integrity } }),
        JSON.stringify({
            name: 'User',
            is_user: true,
            is_system: false,
            mes: 'hello',
            extra: { retryMobileUserAnchorId: userAnchorId },
        }),
        JSON.stringify({
            name: 'Kate',
            is_user: false,
            is_system: false,
            mes: '',
            swipes: [''],
            swipe_id: 0,
            extra: { retryMobileAssistantAnchorId: 'assistant-anchor' },
        }),
    ].join('\n'));

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
        targetUserAnchorId: userAnchorId,
        targetAssistantAnchorId: 'assistant-anchor',
        capturedChatIntegrity: integrity,
        capturedChatLength: 2,
        targetFingerprint: {
            userMessageIndex: 0,
            userMessageText: 'hello',
            assistantBaseline: {
                messageText: '',
                swipeCount: 1,
                swipeId: 0,
                genFinished: '',
            },
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
        await runJob(job, { baseUrl: 'http://127.0.0.1:8000', requestAuth: null });
        assert.equal(job.state, 'failed');
        assert.equal(job.nativeState, 'abandoned');
        assert.equal(job.recoveryMode, 'reuse_empty_placeholder');
        assert.equal(job.attemptCount, 1);
        assert.equal(job.attemptLog.some((entry) => entry.reason === 'native_attempt_timeout'), true);
        assert.equal(fetchCalls.length, 1);
        assert.notEqual(job.structuredError?.code, 'native_write_not_ready');
    } finally {
        global.fetch = originalFetch;
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('extractNativeReplyText prefers mes, then the active swipe, then empty string', () => {
    assert.equal(extractNativeReplyText(null), '');
    assert.equal(extractNativeReplyText({}), '');
    assert.equal(extractNativeReplyText({ mes: 'visible text' }), 'visible text');
    assert.equal(extractNativeReplyText({
        mes: '',
        swipes: ['first', 'second'],
        swipe_id: 1,
    }), 'second');
    assert.equal(extractNativeReplyText({
        mes: '',
        swipes: [],
        swipe_id: 0,
    }), '');
    assert.equal(extractNativeReplyText({
        mes: 'mes wins',
        swipes: ['swipe loses'],
        swipe_id: 0,
    }), 'mes wins');
});

test('resolveNativeAttempt counts an accepted native reply toward the goal as attempt 1', async () => {
    const job = buildResolveAttemptJob();

    await resolveNativeAttempt(job);

    assert.equal(job.attemptCount, 1);
    assert.equal(job.acceptedCount, 1);
    assert.equal(job.nativeAttemptResolved, true);
    assert.equal(job.recoveryMode, 'top_up_existing');
    assert.equal(job.acceptedResults.length, 1);
    assert.equal(job.acceptedResults[0].source, 'native');
    assert.equal(job.phase, 'awaiting_retry_results');

    const lastAttempt = job.attemptLog[job.attemptLog.length - 1];
    assert.equal(lastAttempt.outcome, 'accepted');
    assert.equal(lastAttempt.reason, 'native_accepted');
    assert.equal(lastAttempt.attemptNumber, 1);
});

test('resolveNativeAttempt rejects a too-short native reply and flips recoveryMode to replace_rejected_native', async () => {
    const job = buildResolveAttemptJob({
        targetMessage: {
            mes: 'short',
            swipes: ['short'],
            swipe_id: 0,
            extra: {},
        },
        runConfig: {
            validationMode: 'characters',
            minCharacters: 50,
            minWords: 0,
            minTokens: 0,
            allowHeuristicTokenFallback: false,
        },
    });

    await resolveNativeAttempt(job);

    assert.equal(job.attemptCount, 1);
    assert.equal(job.acceptedCount, 0);
    assert.equal(job.nativeAttemptResolved, true);
    assert.equal(job.recoveryMode, 'replace_rejected_native');
    assert.equal(job.acceptedResults.length, 0);
    assert.equal(job.phase, 'native_rejected');

    const lastAttempt = job.attemptLog[job.attemptLog.length - 1];
    assert.equal(lastAttempt.outcome, 'rejected');
    assert.equal(lastAttempt.reason, 'below_min_characters');
    assert.equal(lastAttempt.attemptNumber, 1);
});

test('resolveNativeAttempt is a no-op when nativeState is not confirmed', async () => {
    const job = buildResolveAttemptJob({ nativeState: 'pending' });

    await resolveNativeAttempt(job);

    assert.equal(job.attemptCount, 0);
    assert.equal(job.acceptedCount, 0);
    assert.equal(job.nativeAttemptResolved, false);
});

test('resolveNativeAttempt is a no-op when nativeAttemptResolved is already true (idempotent across re-entry)', async () => {
    const job = buildResolveAttemptJob({
        nativeAttemptResolved: true,
        attemptCount: 1,
        acceptedCount: 1,
    });

    await resolveNativeAttempt(job);

    assert.equal(job.attemptCount, 1);
    assert.equal(job.acceptedCount, 1);
    assert.equal(job.attemptLog.length, 0);
});

test('resolveNativeAttempt marks pre-existing progress as resolved without replaying the native attempt', async () => {
    const job = buildResolveAttemptJob({ attemptCount: 2, acceptedCount: 1 });

    await resolveNativeAttempt(job);

    assert.equal(job.attemptCount, 2);
    assert.equal(job.acceptedCount, 1);
    assert.equal(job.nativeAttemptResolved, true);
    assert.equal(job.attemptLog.length, 0);
});

function buildRunJobNativeBase(overrides = {}) {
    const now = new Date().toISOString();
    return {
        jobId: 'job-runjob-native-test',
        runId: 'run-runjob-native-test',
        state: 'running',
        phase: 'native_confirmed',
        createdAt: now,
        updatedAt: now,
        nativeState: 'confirmed',
        nativeAttemptResolved: false,
        recoveryMode: 'top_up_existing',
        acceptedCount: 0,
        targetAcceptedCount: 1,
        attemptCount: 0,
        maxAttempts: 3,
        acceptedResults: [],
        attemptLog: [],
        targetMessage: {
            mes: 'A long enough native reply to pass character validation easily.',
            swipes: ['A long enough native reply to pass character validation easily.'],
            swipe_id: 0,
            extra: {},
        },
        runConfig: {
            validationMode: 'characters',
            minCharacters: 10,
            minWords: 0,
            minTokens: 0,
            allowHeuristicTokenFallback: false,
        },
        capturedRequest: { prompt: 'hello' },
        jobController: new AbortController(),
        ...overrides,
    };
}

function createRunJobChatFixture(rootPath, options = {}) {
    const directories = {
        root: rootPath,
        chats: path.join(rootPath, 'chats'),
        groupChats: path.join(rootPath, 'group chats'),
        backups: path.join(rootPath, 'backups'),
    };
    const cardName = options.cardName || 'hero';
    const chatId = options.chatId || 'provider-error-retry';
    const integrity = options.integrity || 'integrity-provider-error';
    const userAnchorId = options.userAnchorId || 'user-provider-error';
    const userMessageText = options.userMessageText || 'Hello there';
    const chatDir = path.join(directories.chats, cardName);
    const chatPath = path.join(chatDir, `${chatId}.jsonl`);

    fs.mkdirSync(chatDir, { recursive: true });
    fs.mkdirSync(directories.groupChats, { recursive: true });
    fs.mkdirSync(directories.backups, { recursive: true });
    fs.writeFileSync(chatPath, [
        {
            chat_metadata: {
                integrity,
            },
        },
        {
            name: 'You',
            is_user: true,
            is_system: false,
            mes: userMessageText,
            extra: {
                retryMobileUserAnchorId: userAnchorId,
            },
        },
    ].map((row) => JSON.stringify(row)).join('\n'));

    return {
        directories,
        chatId,
        integrity,
        userAnchorId,
        userMessageText,
    };
}

test('runJob retries transient provider failures before consuming a later success', async () => {
    const originalFetch = global.fetch;
    const fetchCalls = [];
    let backendCallCount = 0;
    global.fetch = async (url) => {
        fetchCalls.push(url);
        backendCallCount++;
        if (backendCallCount === 1) {
            return {
                ok: true,
                status: 200,
                async text() {
                    return JSON.stringify({
                        error: {
                            message: 'Internal Server Error',
                            type: 'server_error',
                            code: 'internal_error',
                        },
                    });
                },
            };
        }

        if (backendCallCount === 2) {
            return {
                ok: false,
                status: 429,
                async text() {
                    return JSON.stringify({
                        error: {
                            message: 'Rate limited.',
                            type: 'rate_limit',
                            code: 'rate_limit_exceeded',
                        },
                    });
                },
            };
        }

        return {
            ok: true,
            status: 200,
            async text() {
                return JSON.stringify({
                    choices: [{
                        text: 'Recovered provider response that is long enough to be accepted by validation.',
                    }],
                });
            },
        };
    };

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'retry-mobile-provider-error-retry-'));
    const fixture = createRunJobChatFixture(tempRoot);
    const job = buildRunJobNativeBase({
        jobId: 'job-provider-error-retry',
        runId: 'run-provider-error-retry',
        phase: 'native_abandoned',
        nativeState: 'abandoned',
        nativeAttemptResolved: true,
        recoveryMode: 'create_missing_turn',
        targetAcceptedCount: 1,
        maxAttempts: 3,
        targetMessage: null,
        targetUserAnchorId: fixture.userAnchorId,
        targetAssistantAnchorId: 'assistant-provider-error',
        capturedChatIntegrity: fixture.integrity,
        capturedChatLength: 1,
        targetFingerprint: {
            userMessageIndex: 0,
            userMessageText: fixture.userMessageText,
        },
        chatIdentity: {
            kind: 'character',
            avatarUrl: 'hero.png',
            chatId: fixture.chatId,
            fileName: fixture.chatId,
        },
        userContext: {
            handle: 'default-user',
            directories: fixture.directories,
        },
    });

    try {
        await runJob(job, { baseUrl: 'http://127.0.0.1:8000', requestAuth: null });

        assert.equal(fetchCalls.length, 3);
        assert.equal(job.attemptCount, 3);
        const retryableFailures = job.attemptLog.filter((entry) => entry.reason === 'attempt_upstream_retryable');
        assert.equal(retryableFailures.length, 2);
        assert.deepEqual(retryableFailures.map((entry) => entry.attemptNumber), [1, 2]);
    } finally {
        global.fetch = originalFetch;
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('runJob uses the configured hidden-tab takeover delay when pending native loses frontend polling', async () => {
    const originalFetch = global.fetch;
    const fetchCalls = [];
    global.fetch = async (url) => {
        fetchCalls.push(url);
        return {
            ok: true,
            status: 200,
            async text() {
                return JSON.stringify({
                    choices: [{
                        text: 'Recovered backend response after the browser stopped polling during native generation.',
                    }],
                });
            },
        };
    };

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'retry-mobile-configured-hidden-takeover-'));
    const fixture = createRunJobChatFixture(tempRoot, {
        chatId: 'configured-hidden-takeover',
        integrity: 'integrity-configured-hidden-takeover',
        userAnchorId: 'user-configured-hidden-takeover',
    });
    const configuredDelaySeconds = 12;
    const job = buildRunJobNativeBase({
        jobId: 'job-configured-hidden-takeover',
        runId: 'run-configured-hidden-takeover',
        phase: 'pending_native',
        nativeState: 'pending',
        nativeAttemptResolved: false,
        recoveryMode: '',
        targetMessage: null,
        targetAcceptedCount: 1,
        maxAttempts: 2,
        nativeGraceSeconds: configuredDelaySeconds,
        lastFrontendSeenAt: new Date(Date.now() - ((configuredDelaySeconds + 1) * 1000)).toISOString(),
        frontendVisibilityState: 'visible',
        targetUserAnchorId: fixture.userAnchorId,
        targetAssistantAnchorId: 'assistant-configured-hidden-takeover',
        capturedChatIntegrity: fixture.integrity,
        capturedChatLength: 1,
        targetFingerprint: {
            userMessageIndex: 0,
            userMessageText: fixture.userMessageText,
        },
        chatIdentity: {
            kind: 'character',
            avatarUrl: 'hero.png',
            chatId: fixture.chatId,
            fileName: fixture.chatId,
        },
        userContext: {
            handle: 'default-user',
            directories: fixture.directories,
        },
    });

    try {
        await runJob(job, { baseUrl: 'http://127.0.0.1:8000', requestAuth: null });

        assert.equal(job.nativeState, 'abandoned');
        assert.equal(job.nativeResolutionCause, 'frontend_stale');
        assert.equal(job.recoveryMode, 'create_missing_turn');
        assert.equal(fetchCalls.length, 1);
    } finally {
        global.fetch = originalFetch;
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('runJob goal=1 native-confirmed-accepted: completes without any backend fetch', async () => {
    const originalFetch = global.fetch;
    const fetchCalls = [];
    global.fetch = async (url) => {
        fetchCalls.push(url);
        return { ok: true, status: 200, async text() { return JSON.stringify({ choices: [{ text: 'backend result' }] }); } };
    };

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'retry-mobile-native-accept-goal1-'));
    const job = buildRunJobNativeBase({
        jobId: 'job-native-accept-goal1',
        targetAcceptedCount: 1,
        userContext: {
            handle: 'default-user',
            directories: { root: tempRoot, chats: path.join(tempRoot, 'chats'), groupChats: path.join(tempRoot, 'group chats') },
        },
    });

    try {
        await runJob(job, { baseUrl: 'http://127.0.0.1:8000', requestAuth: null });

        assert.equal(job.state, 'completed');
        assert.equal(job.acceptedCount, 1);
        assert.equal(job.attemptCount, 1);
        assert.equal(job.nativeAttemptResolved, true);
        assert.equal(fetchCalls.length, 0, 'no backend fetch when native accepted meets goal=1');
    } finally {
        global.fetch = originalFetch;
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('runJob goal=1 native-confirmed-rejected at maxAttempts=1: sets replace_rejected_native and fails', async () => {
    const originalFetch = global.fetch;
    const fetchCalls = [];
    global.fetch = async (url) => {
        fetchCalls.push(url);
        return { ok: true, status: 200, async text() { return JSON.stringify({ choices: [{ text: 'backend result' }] }); } };
    };

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'retry-mobile-native-reject-goal1-'));
    const job = buildRunJobNativeBase({
        jobId: 'job-native-reject-goal1',
        targetAcceptedCount: 1,
        maxAttempts: 1,
        targetMessage: {
            mes: 'short',
            swipes: ['short'],
            swipe_id: 0,
            extra: {},
        },
        runConfig: {
            validationMode: 'characters',
            minCharacters: 50,
            minWords: 0,
            minTokens: 0,
            allowHeuristicTokenFallback: false,
        },
        userContext: {
            handle: 'default-user',
            directories: { root: tempRoot, chats: path.join(tempRoot, 'chats'), groupChats: path.join(tempRoot, 'group chats') },
        },
    });

    try {
        await runJob(job, { baseUrl: 'http://127.0.0.1:8000', requestAuth: null });

        assert.equal(job.state, 'failed');
        assert.equal(job.acceptedCount, 0);
        assert.equal(job.attemptCount, 1);
        assert.equal(job.nativeAttemptResolved, true);
        assert.equal(job.recoveryMode, 'replace_rejected_native');
        assert.equal(fetchCalls.length, 0, 'no backend fetch — maxAttempts exhausted after native rejection');
    } finally {
        global.fetch = originalFetch;
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('runJob goal=2 native-confirmed-accepted: enters backend retry loop for second accepted result', async () => {
    const originalFetch = global.fetch;
    const fetchCalls = [];
    global.fetch = async (url) => {
        fetchCalls.push(url);
        return {
            ok: true,
            status: 200,
            async text() { return JSON.stringify({ choices: [{ text: 'Backend retry result long enough to be accepted by validation.' }] }); },
        };
    };

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'retry-mobile-native-accept-goal2-'));
    const job = buildRunJobNativeBase({
        jobId: 'job-native-accept-goal2',
        targetAcceptedCount: 2,
        maxAttempts: 3,
        userContext: {
            handle: 'default-user',
            directories: { root: tempRoot, chats: path.join(tempRoot, 'chats'), groupChats: path.join(tempRoot, 'group chats') },
        },
    });

    try {
        // writeAcceptedResult will throw (no chat file on disk) — swallow and inspect intermediate state
        await runJob(job, { baseUrl: 'http://127.0.0.1:8000', requestAuth: null }).catch(() => {});

        assert.equal(job.nativeAttemptResolved, true);
        assert.equal(job.acceptedResults.length >= 1, true, 'native result was counted before write failure');
        assert.equal(job.acceptedResults[0].source, 'native');
        assert.equal(job.attemptCount >= 2, true, 'at least one backend retry was attempted after native accepted');
        assert.equal(fetchCalls.length >= 1, true, 'backend fetch was called for the retry loop');
    } finally {
        global.fetch = originalFetch;
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('runJob goal=2 native-confirmed-rejected: enters backend retry loop with replace_rejected_native mode', async () => {
    const originalFetch = global.fetch;
    const fetchCalls = [];
    global.fetch = async (url) => {
        fetchCalls.push(url);
        return {
            ok: true,
            status: 200,
            async text() { return JSON.stringify({ choices: [{ text: 'Backend retry result long enough to be accepted by validation.' }] }); },
        };
    };

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'retry-mobile-native-reject-goal2-'));
    const job = buildRunJobNativeBase({
        jobId: 'job-native-reject-goal2',
        targetAcceptedCount: 2,
        maxAttempts: 4,
        targetMessage: {
            mes: 'short',
            swipes: ['short'],
            swipe_id: 0,
            extra: {},
        },
        runConfig: {
            validationMode: 'characters',
            minCharacters: 50,
            minWords: 0,
            minTokens: 0,
            allowHeuristicTokenFallback: false,
        },
        userContext: {
            handle: 'default-user',
            directories: { root: tempRoot, chats: path.join(tempRoot, 'chats'), groupChats: path.join(tempRoot, 'group chats') },
        },
    });

    try {
        // writeAcceptedResult throws (no chat file) once backend accepts — swallow and inspect
        await runJob(job, { baseUrl: 'http://127.0.0.1:8000', requestAuth: null }).catch(() => {});

        assert.equal(job.nativeAttemptResolved, true, 'native attempt was resolved');
        assert.equal(job.recoveryMode, 'replace_rejected_native', 'recovery mode set to overwrite rejected native');
        assert.equal(job.attemptCount >= 2, true, 'at least one backend retry was attempted after native rejection');
        assert.equal(fetchCalls.length >= 1, true, 'backend fetch was called for the retry loop');
        assert.equal(job.acceptedResults.filter((r) => r.source === 'native').length, 0, 'rejected native is not in acceptedResults');
    } finally {
        global.fetch = originalFetch;
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('runJob goal=3 native-confirmed-accepted: counts native as first, enters backend loop for remaining 2', async () => {
    const originalFetch = global.fetch;
    const fetchCalls = [];
    global.fetch = async (url) => {
        fetchCalls.push(url);
        return {
            ok: true,
            status: 200,
            async text() { return JSON.stringify({ choices: [{ text: 'Backend retry result long enough to be accepted by validation.' }] }); },
        };
    };

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'retry-mobile-native-accept-goal3-'));
    const job = buildRunJobNativeBase({
        jobId: 'job-native-accept-goal3',
        targetAcceptedCount: 3,
        maxAttempts: 5,
        userContext: {
            handle: 'default-user',
            directories: { root: tempRoot, chats: path.join(tempRoot, 'chats'), groupChats: path.join(tempRoot, 'group chats') },
        },
    });

    try {
        await runJob(job, { baseUrl: 'http://127.0.0.1:8000', requestAuth: null }).catch(() => {});

        assert.equal(job.nativeAttemptResolved, true, 'native attempt was resolved');
        assert.equal(job.acceptedResults.length >= 1, true, 'native result counted before write failure');
        assert.equal(job.acceptedResults[0].source, 'native', 'first accepted result source is native');
        assert.equal(job.acceptedCount >= 1, true, 'acceptedCount includes native');
        assert.equal(fetchCalls.length >= 1, true, 'backend fetch was called for remaining goal');
        assert.equal(job.attemptCount >= 2, true, 'at least one backend retry attempt after native');
    } finally {
        global.fetch = originalFetch;
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('runJob goal=3 native-confirmed-rejected: enters backend retry loop, native not in acceptedResults', async () => {
    const originalFetch = global.fetch;
    const fetchCalls = [];
    global.fetch = async (url) => {
        fetchCalls.push(url);
        return {
            ok: true,
            status: 200,
            async text() { return JSON.stringify({ choices: [{ text: 'Backend retry result long enough to be accepted by validation.' }] }); },
        };
    };

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'retry-mobile-native-reject-goal3-'));
    const job = buildRunJobNativeBase({
        jobId: 'job-native-reject-goal3',
        targetAcceptedCount: 3,
        maxAttempts: 5,
        targetMessage: {
            mes: 'short',
            swipes: ['short'],
            swipe_id: 0,
            extra: {},
        },
        runConfig: {
            validationMode: 'characters',
            minCharacters: 50,
            minWords: 0,
            minTokens: 0,
            allowHeuristicTokenFallback: false,
        },
        userContext: {
            handle: 'default-user',
            directories: { root: tempRoot, chats: path.join(tempRoot, 'chats'), groupChats: path.join(tempRoot, 'group chats') },
        },
    });

    try {
        await runJob(job, { baseUrl: 'http://127.0.0.1:8000', requestAuth: null }).catch(() => {});

        assert.equal(job.nativeAttemptResolved, true, 'native attempt was resolved');
        assert.equal(job.recoveryMode, 'replace_rejected_native', 'recovery mode set to overwrite rejected native for goal=3');
        assert.equal(fetchCalls.length >= 1, true, 'backend fetch called after native rejection');
        assert.equal(job.acceptedResults.filter((r) => r.source === 'native').length, 0, 'rejected native not in acceptedResults');
        assert.equal(job.attemptCount >= 2, true, 'attemptCount covers native + at least one retry');
    } finally {
        global.fetch = originalFetch;
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('runJob mid-run rejected attempt does not increment acceptedCount', async () => {
    const originalFetch = global.fetch;
    const fetchCalls = [];
    let backendCallCount = 0;
    global.fetch = async (url) => {
        fetchCalls.push(url);
        backendCallCount++;
        // First backend call returns short text (rejected), second returns long text (accepted, write will throw)
        const text = backendCallCount === 1
            ? 'short'
            : 'Backend retry result long enough to be accepted by validation.';
        return {
            ok: true,
            status: 200,
            async text() { return JSON.stringify({ choices: [{ text }] }); },
        };
    };

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'retry-mobile-midrun-reject-'));
    const job = buildRunJobNativeBase({
        jobId: 'job-midrun-reject',
        targetAcceptedCount: 2,
        maxAttempts: 5,
        runConfig: {
            validationMode: 'characters',
            minCharacters: 50,
            minWords: 0,
            minTokens: 0,
            allowHeuristicTokenFallback: false,
        },
        userContext: {
            handle: 'default-user',
            directories: { root: tempRoot, chats: path.join(tempRoot, 'chats'), groupChats: path.join(tempRoot, 'group chats') },
        },
    });

    try {
        // Native accepted (long enough by default), then 1 rejected backend retry, then 1 accepted backend retry (write throws)
        await runJob(job, { baseUrl: 'http://127.0.0.1:8000', requestAuth: null }).catch(() => {});

        assert.equal(job.nativeAttemptResolved, true, 'native resolved');
        assert.equal(job.acceptedResults[0].source, 'native', 'native counted as first accepted result');
        assert.equal(job.acceptedCount, 1, 'rejected mid-run retry did not increment acceptedCount');
        assert.equal(backendCallCount >= 2, true, 'at least one rejected retry + one accepted retry were attempted');
        const rejectedEntries = job.attemptLog.filter((e) => e.outcome === 'rejected');
        assert.equal(rejectedEntries.length >= 1, true, 'at least one rejected attempt logged');
    } finally {
        global.fetch = originalFetch;
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('resolveNativeAttempt + goal=2: native counts as first accepted, exactly one backend retry is needed', async () => {
    // Validates goal arithmetic: when native is confirmed+accepted, acceptedCount=1 after
    // resolveNativeAttempt, so the backend loop should run exactly once to reach goal=2.
    // Regression guard against the 3-swipe bug (native + 2 backend retries instead of 1).
    const job = buildResolveAttemptJob({
        targetAcceptedCount: 2,
        maxAttempts: 5,
        nativeState: 'confirmed',
    });

    await resolveNativeAttempt(job);

    assert.equal(job.acceptedCount, 1, 'native counts as first accepted result (acceptedCount=1)');
    assert.equal(job.attemptCount, 1, 'native counts as first attempt');
    assert.equal(job.acceptedResults.length, 1, 'exactly one entry in acceptedResults after native');
    assert.equal(job.acceptedResults[0].source, 'native', 'native result is correctly sourced');
    // The loop condition is: acceptedCount < targetAcceptedCount. With acceptedCount=1 and
    // targetAcceptedCount=2, the loop runs exactly once more — not twice.
    assert.equal(
        job.acceptedCount < job.targetAcceptedCount,
        true,
        'loop will run: still one more accepted result needed',
    );
    assert.equal(
        job.targetAcceptedCount - job.acceptedCount,
        1,
        'exactly 1 more backend retry needed to reach goal=2',
    );
});

test('runJob goal=2 native-confirmed-accepted: exactly one backend fetch is made after native acceptance', async () => {
    const originalFetch = global.fetch;
    const fetchCalls = [];
    global.fetch = async (url) => {
        fetchCalls.push(url);
        return {
            ok: true,
            status: 200,
            async text() {
                return JSON.stringify({ choices: [{ text: 'Backend retry result that is long enough to be accepted by character validation.' }] });
            },
        };
    };

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'retry-mobile-goal2-exact-fetch-'));
    const job = buildRunJobNativeBase({
        jobId: 'job-goal2-exact-fetch',
        targetAcceptedCount: 2,
        maxAttempts: 5,
        userContext: {
            handle: 'default-user',
            directories: { root: tempRoot, chats: path.join(tempRoot, 'chats'), groupChats: path.join(tempRoot, 'group chats') },
        },
    });

    try {
        // writeAcceptedResult throws (no chat file) after the backend retry accepts —
        // swallow the exception and inspect the state at the point of failure.
        await runJob(job, { baseUrl: 'http://127.0.0.1:8000', requestAuth: null }).catch(() => {});

        assert.equal(job.nativeAttemptResolved, true, 'native was resolved');
        assert.equal(job.acceptedResults[0].source, 'native', 'first accepted result is from native');
        assert.equal(
            fetchCalls.length,
            1,
            'exactly one backend fetch — native fills slot 1, backend fills slot 2, loop stops',
        );
        assert.equal(job.attemptCount, 2, 'exactly 2 total attempts: native (1) + backend retry (2)');
    } finally {
        global.fetch = originalFetch;
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});
