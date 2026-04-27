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
    let mutationCallback = null;
    const context = {
        getCurrentChatId() {
            return 'chat-visible';
        },
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
                    [Symbol.iterator]() { return this._set[Symbol.iterator](); },
                },
            };
        },
    };
    global.MutationObserver = class {
        constructor(callback) {
            mutationCallback = callback;
        }
        observe() {}
        disconnect() {}
    };

    // Generation-triggering controls — must be blocked while retry owns the
    // session.
    const blockedSelectors = [
        '#send_but',
        '.last_mes .swipe_right',
        '#option_regenerate',
        '#option_continue',
        '#mes_continue',
        '#mes_impersonate',
    ];
    // Pure-navigation controls — must NOT be blocked, otherwise the user can't
    // step back through existing swipes during a retry.
    const unblockedSelectors = [
        '.last_mes .swipe_left',
    ];

    try {
        const stPort = createStPort();
        stPort.setLockdown(true);
        assert.ok(clickHandler, 'expected tap hijack to register capture click handler');
        assert.ok(keydownHandler, 'expected tap hijack to register capture keydown handler');
        assert.ok(mutationCallback, 'expected lockdown to register mutation observer');

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
        mutationCallback?.([]);

        const blockedHits = calls.filter((entry) => Array.isArray(entry)
            && entry[0] === 'preventDefault'
            && (blockedSelectors.includes(entry[1]) || entry[1] === 'enter_submit'));
        assert.equal(
            blockedHits.length,
            blockedSelectors.length + 1,
            'every generation-triggering selector and the textarea Enter must be blocked',
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
        delete global.MutationObserver;
    }
});

test('setLockdown toggles send icon to spinner and restores on disable', () => {
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
    global.MutationObserver = class {
        observe() {}
        disconnect() {}
    };

    try {
        const stPort = createStPort();
        assert.equal(stPort.setLockdown(true), true);
        assert.equal(sendBut._classes().includes('fa-spinner'), true);
        assert.equal(sendBut._classes().includes('fa-spin'), true);

        assert.equal(stPort.setLockdown(false), true);
        assert.equal(sendBut._classes().includes('fa-paper-plane'), true);
        assert.equal(sendBut._classes().includes('fa-spinner'), false);
    } finally {
        global.window = originalWindow;
        global.document = originalDocument;
        delete global.MutationObserver;
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
