import test from 'node:test';
import assert from 'node:assert/strict';

import { createStPort, normalizePendingVisibleRender } from './st-adapter.js';

test('normalizePendingVisibleRender upgrades queued terminal outcomes to terminal cleanup payloads', () => {
    const original = {
        kind: 'accepted_output',
        terminalOutcome: 'completed',
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
        type: 'terminal',
        payload: {
            kind: 'accepted_output',
            terminalOutcome: 'completed',
            outcome: 'completed',
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

test('clearGeneratingIndicator restores the currently viewed chat even after a chat switch', () => {
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
