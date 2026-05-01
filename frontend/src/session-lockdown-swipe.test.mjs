import test from 'node:test';
import assert from 'node:assert/strict';
import { wouldLastMessageRightSwipeCauseGeneration } from './ui/session-lockdown.js';

test('wouldLastMessageRightSwipeCauseGeneration is false when next swipe is an existing candidate', () => {
    const ctx = {
        chat: [
            { is_user: true, mes: 'u' },
            { is_user: false, is_system: false, swipe_id: 0, swipes: ['a', 'b'], mes: 'a' },
        ],
        chatMetadata: { tainted: true },
    };
    assert.equal(wouldLastMessageRightSwipeCauseGeneration(ctx), false);
});

test('wouldLastMessageRightSwipeCauseGeneration is true on last swipe with regenerate overswipe', () => {
    const ctx = {
        chat: [
            { is_user: true, mes: 'u' },
            { is_user: false, is_system: false, swipe_id: 0, swipes: ['only'], mes: 'only' },
        ],
        chatMetadata: { tainted: true },
    };
    assert.equal(wouldLastMessageRightSwipeCauseGeneration(ctx), true);
});

test('wouldLastMessageRightSwipeCauseGeneration is false for user last message', () => {
    const ctx = {
        chat: [{ is_user: true, mes: 'u' }],
        chatMetadata: { tainted: true },
    };
    assert.equal(wouldLastMessageRightSwipeCauseGeneration(ctx), false);
});
