import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionLockdown, wouldLastMessageRightSwipeCauseGeneration } from './lockdown.js';

function makeDocument() {
    const listeners = {};
    const body = { dataset: {}, _observer: null };
    const doc = {
        body,
        addEventListener(name, fn, opts) {
            const capture = opts === true || opts?.capture === true;
            listeners[`${name}:${capture}`] = fn;
        },
        removeEventListener(name, fn, opts) {
            const capture = opts === true || opts?.capture === true;
            const key = `${name}:${capture}`;
            if (listeners[key] === fn) delete listeners[key];
        },
        getElementById() { return null; },
        _listeners: listeners,
    };
    return doc;
}

function makeContextWith(methods = {}) {
    return () => ({
        getCurrentChatId() { return 'chat-1'; },
        ...methods,
    });
}

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

// E6: After saveReply adds a new swipe and advances swipe_id to the last position,
// clicking swipe_right should still be blocked (still at the last available candidate).
test('wouldLastMessageRightSwipeCauseGeneration is true after apply extends swipes and swipe_id is at last (E6)', () => {
    // Simulates the post-apply state: backend wrote swipe 2, saveReply updated swipes and swipe_id.
    const ctx = {
        chat: [
            { is_user: true, mes: 'u' },
            { is_user: false, is_system: false, swipe_id: 1, swipes: ['native', 'retry1'], mes: 'retry1' },
        ],
        chatMetadata: { tainted: true },
    };
    assert.equal(wouldLastMessageRightSwipeCauseGeneration(ctx), true, 'at the last swipe after apply: right-swipe still causes generation');
});

test('lockdown click handler blocks swipe_right immediately after apply extends swipes and swipe_id is at last (E6)', () => {
    const calls = [];
    let clickHandler = null;
    const doc = makeDocument();
    doc.addEventListener = (name, fn, opts) => {
        const capture = opts === true || opts?.capture === true;
        if (name === 'click' && capture) clickHandler = fn;
    };
    doc.removeEventListener = () => {};

    // Post-apply state: 2 swipes, swipe_id at last.
    const chat = [
        { is_user: true, mes: 'u' },
        { is_user: false, is_system: false, swipe_id: 1, swipes: ['native', 'retry1'], mes: 'retry1' },
    ];

    const lockdown = createSessionLockdown({
        getContext: makeContextWith({
            deactivateSendButtons() {},
            chat,
            chatMetadata: { tainted: true },
        }),
        showToast() {},
        documentRef: doc,
    });
    lockdown.enable();

    clickHandler({
        target: { closest(sel) { return sel === '.last_mes .swipe_right' ? this : null; } },
        preventDefault() { calls.push('prevented'); },
        stopImmediatePropagation() {},
        stopPropagation() {},
    });
    assert.ok(calls.includes('prevented'), 'click handler must block swipe_right when at last swipe after apply');
    lockdown.disable();
});
