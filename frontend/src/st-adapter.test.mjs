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

test('interaction guard stops native generation attempts and fires a warning toast', () => {
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
        stopGeneration() {
            calls.push('stopGeneration');
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

        assert.equal(calls.includes('stopGeneration'), true);
        assert.equal(calls.some((entry) => Array.isArray(entry) && entry[0] === 'toastr.warning'), true);
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
