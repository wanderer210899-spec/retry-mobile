import test from 'node:test';
import assert from 'node:assert/strict';

import {
    clearInternalChatReloadMarker,
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
