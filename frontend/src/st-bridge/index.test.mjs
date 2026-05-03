import test from 'node:test';
import assert from 'node:assert/strict';

import { createStPort } from './index.js';

test('clearGeneratingIndicator restores the currently viewed target chat', () => {
    const originalWindow = global.window;
    const originalDocument = global.document;

    const calls = [];
    const context = {
        activateSendButtons() {
            calls.push('activateSendButtons');
        },
        swipe: {
            refresh(force) {
                calls.push(['swipe.refresh', force]);
            },
        },
        getCurrentChatId() {
            return 'chat-visible';
        },
    };

    global.window = {
        SillyTavern: {
            getContext() {
                return context;
            },
        },
    };
    global.document = {
        visibilityState: 'visible',
        hasFocus() {
            return true;
        },
    };

    try {
        const stPort = createStPort();
        const restored = stPort.clearGeneratingIndicator({
            kind: 'character',
            chatId: 'chat-visible',
            groupId: null,
        });

        assert.equal(restored, true);
        assert.deepEqual(calls, [
            'activateSendButtons',
            ['swipe.refresh', true],
        ]);
    } finally {
        global.window = originalWindow;
        global.document = originalDocument;
    }
});

test('clearGeneratingIndicator does not touch a different visible chat', () => {
    const originalWindow = global.window;
    const originalDocument = global.document;

    const calls = [];
    const context = {
        activateSendButtons() {
            calls.push('activateSendButtons');
        },
        swipe: {
            refresh(force) {
                calls.push(['swipe.refresh', force]);
            },
        },
        getCurrentChatId() {
            return 'chat-visible';
        },
    };

    global.window = {
        SillyTavern: {
            getContext() {
                return context;
            },
        },
    };
    global.document = {
        visibilityState: 'visible',
        hasFocus() {
            return true;
        },
    };

    try {
        const stPort = createStPort();
        const restored = stPort.clearGeneratingIndicator({
            kind: 'character',
            chatId: 'chat-target',
            groupId: null,
        });

        assert.equal(restored, false);
        assert.deepEqual(calls, []);
    } finally {
        global.window = originalWindow;
        global.document = originalDocument;
    }
});

test('setLockdown(true) calls deactivateSendButtons on ST context (Phase 3 cooperation)', () => {
    const originalWindow = global.window;
    const originalDocument = global.document;

    const calls = [];
    const context = {
        getCurrentChatId() { return 'chat-visible'; },
        deactivateSendButtons() { calls.push('deactivateSendButtons'); },
        activateSendButtons() { calls.push('activateSendButtons'); },
    };

    global.window = {
        SillyTavern: { getContext() { return context; } },
    };
    global.document = {
        visibilityState: 'visible',
        addEventListener() {},
        removeEventListener() {},
        body: { dataset: {} },
    };

    try {
        const stPort = createStPort();
        stPort.setLockdown(true);
        assert.ok(
            calls.includes('deactivateSendButtons'),
            'setLockdown(true) must call deactivateSendButtons to cooperate with ST send-button mechanism',
        );
    } finally {
        global.window = originalWindow;
        global.document = originalDocument;
    }
});

test('setLockdown(false) calls activateSendButtons on ST context (Phase 3 cooperation)', () => {
    const originalWindow = global.window;
    const originalDocument = global.document;

    const calls = [];
    const context = {
        getCurrentChatId() { return 'chat-visible'; },
        deactivateSendButtons() { calls.push('deactivateSendButtons'); },
        activateSendButtons() { calls.push('activateSendButtons'); },
    };

    global.window = {
        SillyTavern: { getContext() { return context; } },
    };
    global.document = {
        visibilityState: 'visible',
        addEventListener() {},
        removeEventListener() {},
        body: { dataset: {} },
    };

    try {
        const stPort = createStPort();
        stPort.setLockdown(true);
        calls.length = 0;
        stPort.setLockdown(false);
        assert.ok(
            calls.includes('activateSendButtons'),
            'setLockdown(false) must call activateSendButtons to restore ST send-button state',
        );
    } finally {
        global.window = originalWindow;
        global.document = originalDocument;
    }
});

test('setLockdown still blocks last-message overswipe-right that would regenerate', () => {
    const originalWindow = global.window;
    const originalDocument = global.document;

    const calls = [];
    let clickHandler = null;
    let keydownHandler = null;
    const context = {
        getCurrentChatId() { return 'chat-visible'; },
        deactivateSendButtons() {},
        activateSendButtons() {},
        chat: [
            { is_user: true, mes: 'u' },
            // Last swipe — only one candidate, next swipe would regenerate
            { is_user: false, is_system: false, swipe_id: 0, swipes: ['one'], mes: 'one' },
        ],
        chatMetadata: { tainted: true },
    };

    global.window = {
        toastr: {
            warning(message, title) { calls.push(['toastr.warning', title, message]); },
        },
        SillyTavern: { getContext() { return context; } },
    };
    global.document = {
        visibilityState: 'visible',
        addEventListener(name, handler, opts) {
            const capture = opts === true || opts?.capture === true;
            if (!capture) return;
            if (name === 'click') clickHandler = handler;
            if (name === 'keydown') keydownHandler = handler;
        },
        removeEventListener() {},
        body: { dataset: {} },
        getElementById() { return null; },
    };

    try {
        const stPort = createStPort();
        stPort.setLockdown(true);
        assert.ok(clickHandler, 'must register capture-phase click handler');
        assert.ok(keydownHandler, 'must register capture-phase keydown handler');

        // Clicking the swipe_right chevron on the last message MUST be blocked.
        clickHandler({
            target: {
                closest(candidate) {
                    return candidate === '.last_mes .swipe_right' ? this : null;
                },
            },
            preventDefault() { calls.push(['preventDefault', 'swipe_right_gen']); },
            stopImmediatePropagation() {},
            stopPropagation() {},
        });
        assert.ok(
            calls.some((c) => Array.isArray(c) && c[0] === 'preventDefault' && c[1] === 'swipe_right_gen'),
            'last-message swipe_right that would regenerate must be blocked',
        );

        // swipe_left (back navigation) must NOT be blocked.
        const leftCalls = [];
        clickHandler({
            target: {
                closest(candidate) {
                    return candidate === '.last_mes .swipe_left' ? this : null;
                },
            },
            preventDefault() { leftCalls.push('prevented'); },
            stopImmediatePropagation() {},
            stopPropagation() {},
        });
        assert.equal(leftCalls.length, 0, 'swipe_left must not be blocked');

        // ArrowRight keyboard shortcut on empty textarea MUST be blocked.
        keydownHandler({
            key: 'ArrowRight',
            shiftKey: false, ctrlKey: false, metaKey: false, altKey: false,
            target: { closest() { return null; } },
            preventDefault() { calls.push(['preventDefault', 'arrow_right']); },
            stopImmediatePropagation() {},
            stopPropagation() {},
        });
        assert.ok(
            calls.some((c) => Array.isArray(c) && c[0] === 'preventDefault' && c[1] === 'arrow_right'),
            'ArrowRight with empty textarea and generation-causing overswipe must be blocked',
        );

        // Enter key must NOT be blocked (Phase 3 removes the Enter gate).
        const enterCalls = [];
        keydownHandler({
            key: 'Enter',
            shiftKey: false, ctrlKey: false, metaKey: false, altKey: false,
            target: { closest() { return null; } },
            preventDefault() { enterCalls.push('prevented'); },
            stopImmediatePropagation() {},
            stopPropagation() {},
        });
        assert.equal(enterCalls.length, 0, 'Enter key must not be blocked by Phase 3 lockdown');

        assert.ok(
            calls.some((c) => Array.isArray(c) && c[0] === 'toastr.warning'),
            'blocked interaction must emit a warning toast',
        );
    } finally {
        global.window = originalWindow;
        global.document = originalDocument;
    }
});

test('setLockdown does not mutate send button icon classes', () => {
    const originalWindow = global.window;
    const originalDocument = global.document;

    const makeEl = (classes) => {
        const set = new Set(classes);
        return {
            classList: {
                add(name) {
                    set.add(name);
                },
                remove(name) {
                    set.delete(name);
                },
                contains(name) {
                    return set.has(name);
                },
                [Symbol.iterator]() {
                    return set[Symbol.iterator]();
                },
            },
            _classes() {
                return Array.from(set).sort();
            },
        };
    };

    const sendBut = makeEl(['fa-solid', 'fa-paper-plane', 'interactable']);

    global.window = {
        SillyTavern: {
            getContext() {
                return {
                    getCurrentChatId() {
                        return 'chat-visible';
                    },
                };
            },
        },
    };
    global.document = {
        visibilityState: 'visible',
        addEventListener() {},
        removeEventListener() {},
        body: {},
        getElementById(id) {
            return id === 'send_but' ? sendBut : null;
        },
    };
    try {
        const stPort = createStPort();
        assert.equal(stPort.setLockdown(true), true);
        assert.deepEqual(sendBut._classes().sort(), ['fa-paper-plane', 'fa-solid', 'interactable'].sort());

        assert.equal(stPort.setLockdown(false), true);
        assert.deepEqual(sendBut._classes().sort(), ['fa-paper-plane', 'fa-solid', 'interactable'].sort());
    } finally {
        global.window = originalWindow;
        global.document = originalDocument;
    }
});

test('isVisible treats visible tabs as visible even without focus', () => {
    const originalWindow = global.window;
    const originalDocument = global.document;

    global.window = {
        SillyTavern: {
            getContext() {
                return {
                    getCurrentChatId() {
                        return 'chat-1';
                    },
                };
            },
        },
    };
    global.document = {
        visibilityState: 'visible',
        hasFocus() {
            return false;
        },
    };

    try {
        const stPort = createStPort();
        assert.equal(stPort.isVisible(), true);
    } finally {
        global.window = originalWindow;
        global.document = originalDocument;
    }
});
