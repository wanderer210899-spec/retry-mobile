import test from 'node:test';
import assert from 'node:assert/strict';

import {
    chooseOperationalChatIdentity,
    resolveExpectedPreviousGeneration,
} from './start-payload.js';

test('chooseOperationalChatIdentity prefers a compatible identity with a stable chat id', () => {
    const result = chooseOperationalChatIdentity(
        {
            kind: 'character',
            chatId: '',
            groupId: null,
            assistantName: 'Kai',
        },
        {
            kind: 'character',
            chatId: 'Kai - 2026-04-23 @10h 00m 00s',
            groupId: null,
            assistantName: 'Kai',
        },
    );

    assert.equal(result.chatId, 'Kai - 2026-04-23 @10h 00m 00s');
});

test('chooseOperationalChatIdentity rejects incompatible live identities from another chat', () => {
    const result = chooseOperationalChatIdentity(
        {
            kind: 'character',
            chatId: 'chat-a',
            groupId: null,
            assistantName: 'Kai',
        },
        {
            kind: 'character',
            chatId: 'chat-b',
            groupId: null,
            assistantName: 'Kai',
        },
    );

    assert.equal(result.chatId, 'chat-a');
});

test('resolveExpectedPreviousGeneration skips backend state lookup until the chat id is ready', async () => {
    let called = false;
    const result = await resolveExpectedPreviousGeneration(async () => {
        called = true;
        return { currentGeneration: 99 };
    }, {
        kind: 'character',
        chatId: '',
        groupId: null,
    });

    assert.equal(called, false);
    assert.equal(result.currentGeneration, 0);
    assert.deepEqual(result.meta, {
        source: 'identity_fallback',
        reason: 'chat_id_missing',
    });
});

test('resolveExpectedPreviousGeneration falls back cleanly when backend state rejects a missing identity query', async () => {
    const result = await resolveExpectedPreviousGeneration(async () => {
        const error = new Error('Missing chat identity query.');
        error.status = 400;
        error.payload = {
            error: 'Missing chat identity query.',
        };
        throw error;
    }, {
        kind: 'character',
        chatId: 'chat-ready',
        groupId: null,
    });

    assert.equal(result.currentGeneration, 0);
    assert.deepEqual(result.meta, {
        source: 'identity_fallback',
        reason: 'backend_missing_chat_identity',
    });
});

test('resolveExpectedPreviousGeneration rethrows unrelated backend failures', async () => {
    await assert.rejects(
        () => resolveExpectedPreviousGeneration(async () => {
            const error = new Error('Forbidden');
            error.status = 403;
            throw error;
        }, {
            kind: 'character',
            chatId: 'chat-ready',
            groupId: null,
        }),
        /Forbidden/u,
    );
});
