import test from 'node:test';
import assert from 'node:assert/strict';

import { createArmCaptureSession } from './st-capture.js';

test('createArmCaptureSession ignores dry-run payloads and keeps the real capture armed', async () => {
    const originalWindow = global.window;

    const handlers = new Map();
    const eventSource = {
        on(eventName, handler) {
            const bucket = handlers.get(eventName) || [];
            bucket.push(handler);
            handlers.set(eventName, bucket);
        },
        off(eventName, handler) {
            const bucket = handlers.get(eventName) || [];
            handlers.set(eventName, bucket.filter((entry) => entry !== handler));
        },
        emit(eventName, payload) {
            const bucket = handlers.get(eventName) || [];
            for (const handler of bucket) {
                handler(payload);
            }
        },
    };

    const context = {
        chat: [
            {
                is_user: true,
                mes: 'real user message',
            },
        ],
        eventTypes: {
            CHAT_COMPLETION_SETTINGS_READY: 'chat_completion_settings_ready',
            CHAT_CHANGED: 'chat_changed',
            CHAT_DELETED: 'chat_deleted',
        },
        eventSource,
        getCurrentChatId() {
            return 'chat-1';
        },
        characters: [],
        characterId: null,
        groupId: null,
        name2: 'Kate',
    };

    global.window = {
        SillyTavern: {
            getContext() {
                return context;
            },
        },
    };

    const captures = [];
    const events = [];
    const session = createArmCaptureSession({
        chatIdentity: {
            kind: 'character',
            chatId: 'chat-1',
            groupId: null,
        },
        onCapture(result) {
            captures.push(result);
        },
        onCancel(error) {
            captures.push({
                ok: false,
                error,
            });
        },
        onEvent(eventName, summary) {
            events.push([eventName, summary]);
        },
    });

    try {
        eventSource.emit('chat_completion_settings_ready', {
            type: 'normal',
            dryRun: true,
            chat_completion_source: 'openai',
            messages: [],
        });

        await Promise.resolve();
        assert.equal(captures.length, 0);
        assert.deepEqual(events, [
            ['CHAT_COMPLETION_SETTINGS_READY', 'Ignored dry-run request while armed.'],
        ]);

        eventSource.emit('chat_completion_settings_ready', {
            type: 'normal',
            dryRun: false,
            chat_completion_source: 'openai',
            messages: [],
        });

        await Promise.resolve();
        assert.equal(captures.length, 1);
        assert.equal(captures[0].ok, true);
        assert.equal(captures[0].fingerprint.userMessageText, 'real user message');
    } finally {
        session.stop();
        global.window = originalWindow;
    }
});

test('createArmCaptureSession captures from GENERATE_AFTER_DATA when CHAT_COMPLETION_SETTINGS_READY never arrives', async () => {
    const originalWindow = global.window;

    const handlers = new Map();
    const eventSource = {
        on(eventName, handler) {
            const bucket = handlers.get(eventName) || [];
            bucket.push(handler);
            handlers.set(eventName, bucket);
        },
        off(eventName, handler) {
            const bucket = handlers.get(eventName) || [];
            handlers.set(eventName, bucket.filter((entry) => entry !== handler));
        },
        emit(eventName, payload) {
            const bucket = handlers.get(eventName) || [];
            for (const handler of bucket) {
                handler(payload);
            }
        },
    };

    const context = {
        chat: [
            {
                is_user: true,
                mes: 'fresh mobile send',
            },
        ],
        eventTypes: {
            CHAT_COMPLETION_SETTINGS_READY: 'chat_completion_settings_ready',
            GENERATE_AFTER_DATA: 'generate_after_data',
            CHAT_CHANGED: 'chat_changed',
            CHAT_DELETED: 'chat_deleted',
        },
        eventSource,
        getCurrentChatId() {
            return 'chat-1';
        },
        characters: [],
        characterId: null,
        groupId: null,
        name2: 'Kate',
    };

    global.window = {
        SillyTavern: {
            getContext() {
                return context;
            },
        },
    };

    const captures = [];
    const events = [];
    const session = createArmCaptureSession({
        chatIdentity: {
            kind: 'character',
            chatId: 'chat-1',
            groupId: null,
        },
        onCapture(result) {
            captures.push(result);
        },
        onEvent(eventName, summary) {
            events.push([eventName, summary]);
        },
    });

    try {
        eventSource.emit('generate_after_data', {
            type: 'normal',
            chat_completion_source: 'custom',
            messages: [{ role: 'user', content: 'hello' }],
        });

        await Promise.resolve();
        assert.equal(captures.length, 1);
        assert.equal(captures[0].ok, true);
        assert.equal(captures[0].requestType, 'normal');
        assert.equal(captures[0].fingerprint.userMessageText, 'fresh mobile send');
        assert.deepEqual(events, []);
    } finally {
        session.stop();
        global.window = originalWindow;
    }
});

test('createArmCaptureSession captures from TEXT_COMPLETION_SETTINGS_READY for text-generation providers', async () => {
    const originalWindow = global.window;

    const handlers = new Map();
    const eventSource = {
        on(eventName, handler) {
            const bucket = handlers.get(eventName) || [];
            bucket.push(handler);
            handlers.set(eventName, bucket);
        },
        off(eventName, handler) {
            const bucket = handlers.get(eventName) || [];
            handlers.set(eventName, bucket.filter((entry) => entry !== handler));
        },
        emit(eventName, payload) {
            const bucket = handlers.get(eventName) || [];
            for (const handler of bucket) {
                handler(payload);
            }
        },
    };

    const context = {
        chat: [
            {
                is_user: true,
                mes: 'fresh textgen send',
            },
        ],
        eventTypes: {
            TEXT_COMPLETION_SETTINGS_READY: 'text_completion_settings_ready',
            CHAT_CHANGED: 'chat_changed',
            CHAT_DELETED: 'chat_deleted',
        },
        eventSource,
        getCurrentChatId() {
            return 'chat-1';
        },
        characters: [],
        characterId: null,
        groupId: null,
        name2: 'Kate',
    };

    global.window = {
        SillyTavern: {
            getContext() {
                return context;
            },
        },
    };

    const captures = [];
    const session = createArmCaptureSession({
        chatIdentity: {
            kind: 'character',
            chatId: 'chat-1',
            groupId: null,
        },
        onCapture(result) {
            captures.push(result);
        },
    });

    try {
        eventSource.emit('text_completion_settings_ready', {
            type: 'normal',
            prompt: 'Hello from text completion.',
            api_type: 'generic',
            api_server: 'http://127.0.0.1:5000',
        });

        await Promise.resolve();
        assert.equal(captures.length, 1);
        assert.equal(captures[0].ok, true);
        assert.equal(captures[0].requestType, 'normal');
        assert.equal(captures[0].fingerprint.userMessageText, 'fresh textgen send');
    } finally {
        session.stop();
        global.window = originalWindow;
    }
});

test('createArmCaptureSession ignores incomplete GENERATE_AFTER_DATA fallback payloads until the main capture event arrives', async () => {
    const originalWindow = global.window;

    const handlers = new Map();
    const eventSource = {
        on(eventName, handler) {
            const bucket = handlers.get(eventName) || [];
            bucket.push(handler);
            handlers.set(eventName, bucket);
        },
        off(eventName, handler) {
            const bucket = handlers.get(eventName) || [];
            handlers.set(eventName, bucket.filter((entry) => entry !== handler));
        },
        emit(eventName, payload) {
            const bucket = handlers.get(eventName) || [];
            for (const handler of bucket) {
                handler(payload);
            }
        },
    };

    const context = {
        chat: [
            {
                is_user: true,
                mes: 'fresh mobile send',
            },
        ],
        eventTypes: {
            CHAT_COMPLETION_SETTINGS_READY: 'chat_completion_settings_ready',
            GENERATE_AFTER_DATA: 'generate_after_data',
            CHAT_CHANGED: 'chat_changed',
            CHAT_DELETED: 'chat_deleted',
        },
        eventSource,
        getCurrentChatId() {
            return 'chat-1';
        },
        characters: [],
        characterId: null,
        groupId: null,
        name2: 'Kate',
    };

    global.window = {
        SillyTavern: {
            getContext() {
                return context;
            },
        },
    };

    const captures = [];
    const events = [];
    const session = createArmCaptureSession({
        chatIdentity: {
            kind: 'character',
            chatId: 'chat-1',
            groupId: null,
        },
        onCapture(result) {
            captures.push(result);
        },
        onEvent(eventName, summary) {
            events.push([eventName, summary]);
        },
    });

    try {
        eventSource.emit('generate_after_data', {
            type: 'normal',
            prompt: 'preview only',
        });

        await Promise.resolve();
        assert.equal(captures.length, 0);
        assert.deepEqual(events, [
            ['GENERATE_AFTER_DATA', 'Ignored fallback payload without required keys while armed.'],
        ]);

        eventSource.emit('chat_completion_settings_ready', {
            type: 'normal',
            chat_completion_source: 'custom',
            messages: [{ role: 'user', content: 'hello' }],
        });

        await Promise.resolve();
        assert.equal(captures.length, 1);
        assert.equal(captures[0].ok, true);
        assert.equal(captures[0].requestType, 'normal');
    } finally {
        session.stop();
        global.window = originalWindow;
    }
});

test('createArmCaptureSession keeps the capture armed when a fresh character chat gains its saved chat id on first send', async () => {
    const originalWindow = global.window;

    const handlers = new Map();
    const eventSource = {
        on(eventName, handler) {
            const bucket = handlers.get(eventName) || [];
            bucket.push(handler);
            handlers.set(eventName, bucket);
        },
        off(eventName, handler) {
            const bucket = handlers.get(eventName) || [];
            handlers.set(eventName, bucket.filter((entry) => entry !== handler));
        },
        emit(eventName, payload) {
            const bucket = handlers.get(eventName) || [];
            for (const handler of bucket) {
                handler(payload);
            }
        },
    };

    let currentChatId = '';
    const context = {
        chat: [
            {
                is_user: true,
                mes: 'first live send',
            },
        ],
        eventTypes: {
            GENERATE_AFTER_DATA: 'generate_after_data',
            CHAT_CHANGED: 'chat_changed',
            CHAT_DELETED: 'chat_deleted',
        },
        eventSource,
        getCurrentChatId() {
            return currentChatId;
        },
        characters: [
            {
                name: '凯琳1',
                avatar: 'kailin.png',
            },
        ],
        characterId: 0,
        groupId: null,
        name2: '凯琳1',
    };

    global.window = {
        SillyTavern: {
            getContext() {
                return context;
            },
        },
    };

    const captures = [];
    const events = [];
    const cancellations = [];
    const session = createArmCaptureSession({
        chatIdentity: {
            kind: 'character',
            chatId: '',
            fileName: '',
            groupId: null,
            avatarUrl: 'kailin.png',
            assistantName: '凯琳1',
        },
        onCapture(result) {
            captures.push(result);
        },
        onCancel(error) {
            cancellations.push(error);
        },
        onEvent(eventName, summary) {
            events.push([eventName, summary]);
        },
    });

    try {
        currentChatId = '凯琳1 - 2026-04-22 @10h 00m 00s';
        eventSource.emit('chat_changed');
        eventSource.emit('generate_after_data', {
            type: 'normal',
            chat_completion_source: 'custom',
            messages: [{ role: 'user', content: 'hello' }],
        });

        await Promise.resolve();

        assert.equal(cancellations.length, 0);
        assert.equal(captures.length, 1);
        assert.equal(captures[0].ok, true);
        assert.equal(captures[0].fingerprint.chatIdentity.chatId, currentChatId);
        assert.deepEqual(events, [
            ['CHAT_CHANGED_IGNORED', 'Ignored CHAT_CHANGED while the armed chat was stabilizing its saved identity.'],
        ]);
    } finally {
        session.stop();
        global.window = originalWindow;
    }
});
