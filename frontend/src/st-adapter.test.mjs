import test from 'node:test';
import assert from 'node:assert/strict';

import { createStPort, normalizePendingVisibleRender } from './st-adapter.js';

test('normalizePendingVisibleRender keeps queued completed payloads on accepted-output path', () => {
    const original = {
        kind: 'accepted_output',
        chatIdentity: {
            kind: 'character',
            chatId: 'chat-1',
            groupId: null,
        },
        status: {
            jobId: 'job-1',
            state: 'completed',
        },
    };

    const normalized = normalizePendingVisibleRender(original);

    assert.deepEqual(normalized, {
        type: 'accepted_output',
        payload: {
            kind: 'accepted_output',
            chatIdentity: {
                kind: 'character',
                chatId: 'chat-1',
                groupId: null,
            },
            status: {
                jobId: 'job-1',
                state: 'completed',
            },
        },
    });
    assert.notStrictEqual(normalized.payload, original);
    assert.equal(Object.prototype.hasOwnProperty.call(normalized.payload, 'terminalOutcome'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(normalized.payload, 'outcome'), false);
});

test('normalizePendingVisibleRender leaves normal accepted-output patches on the incremental path', () => {
    const original = {
        kind: 'accepted_output',
        chatIdentity: {
            kind: 'character',
            chatId: 'chat-1',
            groupId: null,
        },
        status: {
            jobId: 'job-1',
            state: 'running',
            targetMessageVersion: 2,
        },
    };

    const normalized = normalizePendingVisibleRender(original);

    assert.deepEqual(normalized, {
        type: 'accepted_output',
        payload: {
            kind: 'accepted_output',
            chatIdentity: {
                kind: 'character',
                chatId: 'chat-1',
                groupId: null,
            },
            status: {
                jobId: 'job-1',
                state: 'running',
                targetMessageVersion: 2,
            },
        },
    });
    assert.notStrictEqual(normalized.payload, original);
});

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

test('interaction guard is silent (tap hijack owns user warnings)', () => {
    const originalWindow = global.window;
    const originalDocument = global.document;

    const calls = [];
    const handlers = new Map();
    const context = {
        eventTypes: {
            CHAT_COMPLETION_SETTINGS_READY: 'CHAT_COMPLETION_SETTINGS_READY',
        },
        eventSource: {
            on(name, handler) {
                handlers.set(name, handler);
            },
            off(name) {
                handlers.delete(name);
            },
        },
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
        hasFocus() {
            return true;
        },
    };

    try {
        const stPort = createStPort();
        stPort.enableInteractionGuard();
        const handler = handlers.get('CHAT_COMPLETION_SETTINGS_READY');
        assert.ok(handler, 'expected guard to subscribe to CHAT_COMPLETION_SETTINGS_READY');
        handler({ dryRun: false, type: 'swipe' });

        assert.equal(calls.length, 0);
    } finally {
        global.window = originalWindow;
        global.document = originalDocument;
    }
});

test('tap hijack blocks send clicks and shows interactionBlocked toast', () => {
    const originalWindow = global.window;
    const originalDocument = global.document;

    const calls = [];
    let clickHandler = null;

    const context = {
        getCurrentChatId() {
            return 'chat-visible';
        },
    };

    const makeElement = (matchesSelector) => ({
        closest(selector) {
            return matchesSelector(selector) ? this : null;
        },
    });

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
            if (name === 'click' && capture === true) {
                clickHandler = handler;
            }
        },
        removeEventListener() {},
        hasFocus() {
            return true;
        },
    };

    try {
        const stPort = createStPort();
        stPort.enableTapHijack();
        assert.ok(clickHandler, 'expected tap hijack to register capture click handler');

        const event = {
            target: makeElement((selector) => selector === '#send_but'),
            preventDefault() {
                calls.push('preventDefault');
            },
            stopImmediatePropagation() {
                calls.push('stopImmediatePropagation');
            },
            stopPropagation() {
                calls.push('stopPropagation');
            },
        };
        clickHandler(event);

        assert.equal(calls.includes('preventDefault'), true);
        assert.equal(calls.includes('stopImmediatePropagation'), true);
        assert.equal(calls.includes('stopPropagation'), true);
        assert.equal(calls.some((entry) => Array.isArray(entry) && entry[0] === 'toastr.warning'), true);
    } finally {
        global.window = originalWindow;
        global.document = originalDocument;
    }
});

test('setSendBusy swaps send icon to spinner and restores', () => {
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
        getElementById(id) {
            return id === 'send_but' ? sendBut : null;
        },
        hasFocus() {
            return true;
        },
    };

    try {
        const stPort = createStPort();
        assert.equal(stPort.setSendBusy(true), true);
        assert.equal(sendBut._classes().includes('fa-spinner'), true);
        assert.equal(sendBut._classes().includes('fa-spin'), true);

        assert.equal(stPort.setSendBusy(false), true);
        assert.equal(sendBut._classes().includes('fa-paper-plane'), true);
        assert.equal(sendBut._classes().includes('fa-spinner'), false);
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
