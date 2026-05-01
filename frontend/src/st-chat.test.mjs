import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildFingerprint,
    clearInternalChatReloadMarker,
    confirmTargetTurn,
    markInternalChatReload,
    reloadCurrentChatSafe,
    wasInternalChatReloadRecentlyTriggered,
} from './st-chat.js';

test('internal reload markers are scoped to the current chat identity', () => {
    clearInternalChatReloadMarker();

    const chatA = {
        kind: 'character',
        chatId: 'chat-a',
        groupId: null,
    };
    const chatB = {
        kind: 'character',
        chatId: 'chat-b',
        groupId: null,
    };

    markInternalChatReload(chatA);

    assert.equal(wasInternalChatReloadRecentlyTriggered(chatA), true);
    assert.equal(wasInternalChatReloadRecentlyTriggered(chatB), false);

    clearInternalChatReloadMarker();
});

test('reloadCurrentChatSafe marks a successful canonical reload as internal', async () => {
    clearInternalChatReloadMarker();

    const context = {
        chatId: 'chat-c',
        reloadCurrentChat: async () => {},
    };

    const reloaded = await reloadCurrentChatSafe(context);

    assert.equal(reloaded, true);
    assert.equal(wasInternalChatReloadRecentlyTriggered({
        kind: 'character',
        chatId: 'chat-c',
        groupId: null,
    }), true);

    clearInternalChatReloadMarker();
});

test('buildFingerprint keeps a bounded tail anchor instead of scanning the whole chat', () => {
    const chat = [
        { is_user: true, mes: 'Old repeated line' },
        { is_user: false, mes: 'Assistant old' },
        { is_user: true, mes: 'Old repeated line' },
        { is_user: false, mes: 'Assistant mid' },
        { is_user: true, mes: 'Newest repeated line' },
    ];

    const fingerprint = buildFingerprint({
        chatIdentity: {
            kind: 'character',
            chatId: 'chat-anchor',
            groupId: null,
        },
        chat,
        requestType: 'normal',
        messageIdHint: null,
    });

    assert.equal(fingerprint.userMessageText, 'Newest repeated line');
    assert.equal(fingerprint.userIndexAtCapture, 4);
    assert.equal(fingerprint.capturedChatLength, 5);
});

test('confirmTargetTurn accepts a nearby assistant index when the observed id drifts slightly', () => {
    const originalWindow = globalThis.window;
    globalThis.window = {
        SillyTavern: {
            getContext() {
                return {
                    chatId: 'chat-confirm',
                    chat: [
                        { is_user: true, mes: 'Repeat me' },
                        { is_user: false, mes: 'Older answer' },
                        { is_user: true, mes: 'Repeat me' },
                        { is_user: false, mes: 'Fresh answer' },
                    ],
                };
            },
        },
    };

    try {
        const fingerprint = {
            chatIdentity: {
                kind: 'character',
                chatId: 'chat-confirm',
                groupId: null,
            },
            userMessageIndex: 2,
            userIndexAtCapture: 2,
            userMessageText: 'Repeat me',
            precedingMessageText: 'Older answer',
            capturedChatLength: 4,
            messageIdHint: null,
        };

        const result = confirmTargetTurn(fingerprint, 2);
        assert.equal(result.ok, true);
        assert.equal(result.assistantMessageIndex, 3);
        assert.equal(result.assistantMessage?.mes, 'Fresh answer');
    } finally {
        globalThis.window = originalWindow;
    }
});
