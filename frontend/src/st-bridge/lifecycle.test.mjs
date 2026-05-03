import test from 'node:test';
import assert from 'node:assert/strict';

import { waitForNativeCompletion } from './lifecycle.js';

test('waitForNativeCompletion fails closed when the observed native assistant row is deleted before confirmation', async () => {
    const originalWindow = globalThis.window;
    const originalDocument = globalThis.document;

    const handlers = new Map();
    const eventSource = {
        on(eventName, handler) {
            const bucket = handlers.get(eventName) || [];
            bucket.push(handler);
            handlers.set(eventName, bucket);
        },
        removeListener(eventName, handler) {
            const bucket = handlers.get(eventName) || [];
            handlers.set(eventName, bucket.filter((entry) => entry !== handler));
        },
        emit(eventName, ...args) {
            const bucket = handlers.get(eventName) || [];
            for (const handler of bucket) {
                handler(...args);
            }
        },
    };

    const context = {
        chatId: 'chat-native-delete',
        groupId: null,
        characterId: null,
        characters: [],
        name2: 'Kate',
        getCurrentChatId() {
            return 'chat-native-delete';
        },
        chat: [
            {
                is_user: true,
                mes: 'I wait under the streetlight after class.',
            },
            {
                is_user: false,
                mes: 'Native reply still visible.',
            },
        ],
        eventTypes: {
            GENERATION_ENDED: 'generation_ended',
            CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
            GENERATION_STOPPED: 'generation_stopped',
            CHAT_CHANGED: 'chat_changed',
            CHAT_DELETED: 'chat_deleted',
        },
        eventSource,
    };

    globalThis.window = {
        SillyTavern: {
            getContext() {
                return context;
            },
        },
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
    };
    globalThis.document = {
        visibilityState: 'visible',
        body: {
            dataset: {},
        },
        querySelector() {
            return null;
        },
        addEventListener() {},
        removeEventListener() {},
    };

    try {
        const resultPromise = waitForNativeCompletion({
            fingerprint: {
                chatIdentity: {
                    kind: 'character',
                    chatId: 'chat-native-delete',
                    groupId: null,
                },
                userIndexAtCapture: 0,
                userMessageText: 'I wait under the streetlight after class.',
                precedingMessageText: '',
                messageIdHint: 0,
            },
            timeoutMs: 5000,
        });

        eventSource.emit('character_message_rendered', 1, 'normal');
        context.chat = [
            {
                is_user: true,
                mes: 'I wait under the streetlight after class.',
            },
        ];
        eventSource.emit('generation_ended', 1);

        await assert.rejects(resultPromise, (error) => {
            assert.equal(error?.code, 'native_turn_missing');
            assert.match(error?.message || '', /disappear before it could be confirmed/i);
            return true;
        });
    } finally {
        globalThis.window = originalWindow;
        globalThis.document = originalDocument;
    }
});

test('waitForNativeCompletion confirms the native turn from live chat state when lifecycle events never arrive', async () => {
    const originalWindow = globalThis.window;
    const originalDocument = globalThis.document;

    const handlers = new Map();
    const eventSource = {
        on(eventName, handler) {
            const bucket = handlers.get(eventName) || [];
            bucket.push(handler);
            handlers.set(eventName, bucket);
        },
        removeListener(eventName, handler) {
            const bucket = handlers.get(eventName) || [];
            handlers.set(eventName, bucket.filter((entry) => entry !== handler));
        },
    };

    const context = {
        chatId: 'chat-native-fallback',
        groupId: null,
        characterId: null,
        characters: [],
        name2: 'Kate',
        getCurrentChatId() {
            return 'chat-native-fallback';
        },
        chat: [
            {
                is_user: true,
                mes: 'I wait under the streetlight after class.',
            },
            {
                is_user: false,
                mes: 'Native reply visible in chat without lifecycle events.',
            },
        ],
        eventTypes: {
            GENERATION_ENDED: 'generation_ended',
            CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
            GENERATION_STOPPED: 'generation_stopped',
            CHAT_CHANGED: 'chat_changed',
            CHAT_DELETED: 'chat_deleted',
        },
        eventSource,
    };

    globalThis.window = {
        SillyTavern: {
            getContext() {
                return context;
            },
        },
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
    };
    globalThis.document = {
        visibilityState: 'visible',
        body: {
            dataset: {},
        },
        addEventListener() {},
        removeEventListener() {},
        querySelectorAll() {
            return [];
        },
        querySelector(selector) {
            if (selector === '.mes[mesid="1"]') {
                return {
                    querySelector() {
                        return {
                            textContent: 'Native reply visible in chat without lifecycle events.',
                        };
                    },
                    textContent: 'Native reply visible in chat without lifecycle events.',
                };
            }
            return null;
        },
    };

    try {
        const events = [];
        const resultPromise = waitForNativeCompletion({
            fingerprint: {
                chatIdentity: {
                    kind: 'character',
                    chatId: 'chat-native-fallback',
                    groupId: null,
                },
                userIndexAtCapture: 0,
                userMessageText: 'I wait under the streetlight after class.',
                precedingMessageText: '',
                messageIdHint: 0,
            },
            timeoutMs: 1500,
            onEvent(event) {
                events.push(event);
            },
        });

        // Simulate the real mobile path where ST renders the assistant row but
        // never emits GENERATION_ENDED for the observed turn.
        const bucket = handlers.get('character_message_rendered') || [];
        for (const handler of bucket) {
            handler(1, 'normal');
        }

        const result = await resultPromise;

        assert.equal(result?.outcome, 'succeeded');
        assert.equal(result?.assistantMessageIndex, 1);
        assert.equal(result?.assistantMessage?.mes, 'Native reply visible in chat without lifecycle events.');
        assert.equal(events.includes('NATIVE_FALLBACK_CONFIRMED'), true);
    } finally {
        globalThis.window = originalWindow;
        globalThis.document = originalDocument;
    }
});

test('waitForNativeCompletion returns native_attempt_timeout when visible generation exceeds the configured attempt timeout', async () => {
    const originalWindow = globalThis.window;
    const originalDocument = globalThis.document;

    const handlers = new Map();
    const eventSource = {
        on(eventName, handler) {
            const bucket = handlers.get(eventName) || [];
            bucket.push(handler);
            handlers.set(eventName, bucket);
        },
        removeListener(eventName, handler) {
            const bucket = handlers.get(eventName) || [];
            handlers.set(eventName, bucket.filter((entry) => entry !== handler));
        },
    };

    const context = {
        chatId: 'chat-native-timeout',
        groupId: null,
        characterId: null,
        characters: [],
        name2: 'Kate',
        getCurrentChatId() {
            return 'chat-native-timeout';
        },
        chat: [
            {
                is_user: true,
                mes: 'I wait under the streetlight after class.',
            },
        ],
        eventTypes: {
            GENERATION_ENDED: 'generation_ended',
            CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
            GENERATION_STOPPED: 'generation_stopped',
            CHAT_CHANGED: 'chat_changed',
            CHAT_DELETED: 'chat_deleted',
        },
        eventSource,
    };

    globalThis.window = {
        SillyTavern: {
            getContext() {
                return context;
            },
        },
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
    };
    globalThis.document = {
        visibilityState: 'visible',
        body: {
            dataset: {
                generating: 'true',
            },
        },
        querySelector() {
            return null;
        },
        querySelectorAll(selector) {
            if (selector === '#mes_stop, #mes_stop_buttons, .fa-stop') {
                return [1];
            }
            return [];
        },
        addEventListener() {},
        removeEventListener() {},
    };

    try {
        const resultPromise = waitForNativeCompletion({
            fingerprint: {
                chatIdentity: {
                    kind: 'character',
                    chatId: 'chat-native-timeout',
                    groupId: null,
                },
                userIndexAtCapture: 0,
                userMessageText: 'I wait under the streetlight after class.',
                precedingMessageText: '',
                messageIdHint: 0,
            },
            timeoutMs: 1500,
            attemptTimeoutSeconds: 0.05,
        });

        const bucket = handlers.get('character_message_rendered') || [];
        for (const handler of bucket) {
            handler(1, 'normal');
        }

        const result = await resultPromise;

        assert.equal(result?.outcome, 'timed_out');
        assert.equal(result?.reason, 'native_attempt_timeout');
    } finally {
        globalThis.window = originalWindow;
        globalThis.document = originalDocument;
    }
});

test('waitForNativeCompletion confirms live chat instead of timing out when generation has stopped', async () => {
    const originalWindow = globalThis.window;
    const originalDocument = globalThis.document;

    const handlers = new Map();
    const eventSource = {
        on(eventName, handler) {
            const bucket = handlers.get(eventName) || [];
            bucket.push(handler);
            handlers.set(eventName, bucket);
        },
        removeListener(eventName, handler) {
            const bucket = handlers.get(eventName) || [];
            handlers.set(eventName, bucket.filter((entry) => entry !== handler));
        },
    };

    const context = {
        chatId: 'chat-native-timeout-confirmed',
        groupId: null,
        characterId: null,
        characters: [],
        name2: 'Kate',
        getCurrentChatId() {
            return 'chat-native-timeout-confirmed';
        },
        chat: [
            {
                is_user: true,
                mes: 'I wait under the streetlight after class.',
            },
            {
                is_user: false,
                mes: 'Native reply finished just before timeout.',
            },
        ],
        eventTypes: {
            GENERATION_ENDED: 'generation_ended',
            CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
            GENERATION_STOPPED: 'generation_stopped',
            CHAT_CHANGED: 'chat_changed',
            CHAT_DELETED: 'chat_deleted',
        },
        eventSource,
    };

    globalThis.window = {
        SillyTavern: {
            getContext() {
                return context;
            },
        },
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
    };
    globalThis.document = {
        visibilityState: 'visible',
        body: {
            dataset: {
                generating: 'true',
            },
        },
        querySelector() {
            return null;
        },
        querySelectorAll() {
            return [];
        },
        addEventListener() {},
        removeEventListener() {},
    };

    try {
        const resultPromise = waitForNativeCompletion({
            fingerprint: {
                chatIdentity: {
                    kind: 'character',
                    chatId: 'chat-native-timeout-confirmed',
                    groupId: null,
                },
                userIndexAtCapture: 0,
                userMessageText: 'I wait under the streetlight after class.',
                precedingMessageText: '',
                messageIdHint: 0,
            },
            timeoutMs: 1500,
            attemptTimeoutSeconds: 0.05,
        });

        const bucket = handlers.get('character_message_rendered') || [];
        for (const handler of bucket) {
            handler(1, 'normal');
        }

        setTimeout(() => {
            document.body.dataset.generating = '';
        }, 20);

        const result = await resultPromise;

        assert.equal(result?.outcome, 'succeeded');
        assert.equal(result?.assistantMessageIndex, 1);
        assert.equal(result?.assistantMessage?.mes, 'Native reply finished just before timeout.');
    } finally {
        globalThis.window = originalWindow;
        globalThis.document = originalDocument;
    }
});
