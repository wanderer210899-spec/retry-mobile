import test from 'node:test';
import assert from 'node:assert/strict';

import { createStPort } from './st-adapter.js';

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

test('setLockdown blocks all configured click selectors and Enter send', () => {
    const originalWindow = global.window;
    const originalDocument = global.document;

    const calls = [];
    let clickHandler = null;
    let keydownHandler = null;
    const context = {
        getCurrentChatId() {
            return 'chat-visible';
        },
        chat: [
            { is_user: true, mes: 'u' },
            { is_user: false, is_system: false, swipe_id: 0, swipes: ['a', 'b'], mes: 'a' },
        ],
        chatMetadata: { tainted: true },
    };

    global.window = {
        toastr: {
            warning(message, title) {
                calls.push(['toastr.warning', title, message]);
            },
        },
        SillyTavern: {
            getContext() {
                return context;
            },
        },
    };
    global.document = {
        visibilityState: 'visible',
        addEventListener(name, handler, capture) {
            if (capture !== true) {
                return;
            }
            if (name === 'click') {
                clickHandler = handler;
            }
            if (name === 'keydown') {
                keydownHandler = handler;
            }
        },
        removeEventListener() {},
        body: {},
        getElementById(id) {
            if (id !== 'send_but') {
                return null;
            }
            return {
                classList: {
                    _set: new Set(['fa-solid', 'fa-paper-plane']),
                    add(name) { this._set.add(name); },
                    remove(name) { this._set.delete(name); },
                    contains(name) { return this._set.has(name); },
                    [Symbol.iterator]() { return this._set[Symbol.iterator](); },
                },
            };
        },
    };
    // Generation-triggering controls — must be blocked while retry owns the
    // session.
    const blockedSelectors = [
        '#send_but',
        '#option_regenerate',
        '#option_continue',
        '#mes_continue',
        '#mes_impersonate',
    ];
    // Pure-navigation controls — must NOT be blocked, otherwise the user can't
    // step back through existing swipes during a retry.
    const unblockedSelectors = [
        '.last_mes .swipe_left',
        // Last row but not on the newest candidate — right chevron still exists
        // for stepping forward without regenerate; must not match lockdown.
        '.last_mes .swipe_right',
    ];

    try {
        const stPort = createStPort();
        stPort.setLockdown(true);
        assert.ok(clickHandler, 'expected tap hijack to register capture click handler');
        assert.ok(keydownHandler, 'expected tap hijack to register capture keydown handler');

        for (const selector of blockedSelectors) {
            const event = {
                target: {
                    closest(candidate) {
                        return candidate === selector ? this : null;
                    },
                },
                preventDefault() { calls.push(['preventDefault', selector]); },
                stopImmediatePropagation() { calls.push(['stopImmediatePropagation', selector]); },
                stopPropagation() { calls.push(['stopPropagation', selector]); },
            };
            clickHandler(event);
        }

        for (const selector of unblockedSelectors) {
            const event = {
                target: {
                    closest(candidate) {
                        return candidate === selector ? this : null;
                    },
                },
                preventDefault() { calls.push(['preventDefault', selector]); },
                stopImmediatePropagation() { calls.push(['stopImmediatePropagation', selector]); },
                stopPropagation() { calls.push(['stopPropagation', selector]); },
            };
            clickHandler(event);
        }

        keydownHandler({
            key: 'Enter',
            shiftKey: false,
            target: {
                closest(candidate) {
                    return candidate === '#send_textarea' ? this : null;
                },
            },
            preventDefault() { calls.push(['preventDefault', 'enter_submit']); },
            stopImmediatePropagation() { calls.push(['stopImmediatePropagation', 'enter_submit']); },
            stopPropagation() { calls.push(['stopPropagation', 'enter_submit']); },
        });
        const blockedHits = calls.filter((entry) => Array.isArray(entry)
            && entry[0] === 'preventDefault'
            && (blockedSelectors.includes(entry[1]) || entry[1] === 'enter_submit'));
        assert.equal(
            blockedHits.length,
            blockedSelectors.length + 1,
            'every generation-triggering selector and the textarea Enter must be blocked',
        );

        context.chat = [
            { is_user: true, mes: 'u' },
            { is_user: false, is_system: false, swipe_id: 0, swipes: ['one'], mes: 'one' },
        ];
        clickHandler({
            target: {
                closest(candidate) {
                    return candidate === '.last_mes .swipe_right' ? this : null;
                },
            },
            preventDefault() { calls.push(['preventDefault', 'swipe_right_gen']); },
            stopImmediatePropagation() { calls.push(['stopImmediatePropagation', 'swipe_right_gen']); },
            stopPropagation() { calls.push(['stopPropagation', 'swipe_right_gen']); },
        });
        assert.ok(
            calls.some((entry) => Array.isArray(entry) && entry[0] === 'preventDefault' && entry[1] === 'swipe_right_gen'),
            'last-message right swipe that would regenerate must be blocked',
        );

        const swipeLeftHits = calls.filter((entry) => Array.isArray(entry)
            && entry[1] === '.last_mes .swipe_left');
        assert.equal(
            swipeLeftHits.length,
            0,
            'swipe_left back-navigation must not be blocked or it cannot be used during retry',
        );

        assert.equal(calls.some((entry) => Array.isArray(entry) && entry[0] === 'toastr.warning'), true);
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
