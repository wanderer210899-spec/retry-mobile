import test from 'node:test';
import assert from 'node:assert/strict';

import { waitForNativeCompletion } from './st-lifecycle.js';

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
