import test from 'node:test';
import assert from 'node:assert/strict';

import {
    createTargetMutationGuard,
    inspectWatchedTarget,
} from './target-mutation.js';

test('target mutation guard reports active assistant deletion after re-inspecting anchors', async () => {
    const eventSource = createEventSource();
    const context = createContext(eventSource);
    const reports = [];
    const guard = createTargetMutationGuard({
        getContext: () => context,
        onMutation(payload) {
            reports.push(payload);
        },
    });

    guard.watch(createStatus());
    context.chat = [context.chat[0]];
    eventSource.emit('message_deleted', context.chat.length);

    assert.equal(reports.length, 1);
    assert.equal(reports[0].jobId, 'job-1');
    assert.equal(reports[0].sourceEvent, 'MESSAGE_DELETED');
    assert.equal(reports[0].mutationType, 'message_deleted');
    assert.equal(reports[0].reason, 'assistant_missing_after_delete');
});

test('target mutation guard ignores edits to unrelated messages', () => {
    const eventSource = createEventSource();
    const context = createContext(eventSource);
    context.chat.push({ is_user: false, mes: 'Other assistant', extra: {} });
    const reports = [];
    const guard = createTargetMutationGuard({
        getContext: () => context,
        onMutation(payload) {
            reports.push(payload);
        },
    });

    guard.watch(createStatus());
    eventSource.emit('message_edited', 2);

    assert.equal(reports.length, 0);
});

test('target mutation guard ignores delete events when the assistant target was never resolved', () => {
    const eventSource = createEventSource();
    const context = createContext(eventSource);
    context.chat = [
        {
            is_user: true,
            mes: 'Hello',
            extra: { retryMobileUserAnchorId: 'user-anchor-1' },
        },
        {
            is_user: false,
            mes: 'Unrelated assistant',
            extra: {},
        },
    ];
    const reports = [];
    const guard = createTargetMutationGuard({
        getContext: () => context,
        onMutation(payload) {
            reports.push(payload);
        },
    });

    guard.watch(createStatus({
        targetMessageIndex: null,
        targetMessageVersion: 0,
    }));
    context.chat.pop();
    eventSource.emit('message_deleted', context.chat.length);

    assert.equal(reports.length, 0);
});

test('target mutation guard ignores delete events when watch-time chat identity was not verifiable', () => {
    const eventSource = createEventSource();
    const context = createContext(eventSource);
    let currentChatId = 'other-chat';
    context.chatId = currentChatId;
    context.getCurrentChatId = () => currentChatId;
    const reports = [];
    const guard = createTargetMutationGuard({
        getContext: () => context,
        onMutation(payload) {
            reports.push(payload);
        },
    });

    guard.watch(createStatus());
    currentChatId = 'chat-1';
    context.chatId = currentChatId;
    context.chat = [context.chat[0]];
    eventSource.emit('message_deleted', context.chat.length);

    assert.equal(reports.length, 0);
});

test('target mutation guard reports swipe deletion on the watched assistant target', () => {
    const eventSource = createEventSource();
    const context = createContext(eventSource);
    const reports = [];
    const guard = createTargetMutationGuard({
        getContext: () => context,
        onMutation(payload) {
            reports.push(payload);
        },
    });

    guard.watch(createStatus({ targetMessageVersion: 3 }));
    eventSource.emit('message_swipe_deleted', { messageId: 1, swipeId: 2, newSwipeId: 1 });

    assert.equal(reports.length, 1);
    assert.equal(reports[0].sourceEvent, 'MESSAGE_SWIPE_DELETED');
    assert.equal(reports[0].mutationType, 'swipe_deleted');
    assert.equal(reports[0].targetMessageVersion, 3);
});

test('inspectWatchedTarget treats user edits as user intent', () => {
    const status = createStatus();
    const result = inspectWatchedTarget({
        status,
        chat: createContext(createEventSource()).chat,
        sourceEvent: 'MESSAGE_EDITED',
        eventMessageId: 0,
    });

    assert.equal(result.affected, true);
    assert.equal(result.mutationType, 'message_edited');
    assert.equal(result.reason, 'user_message_edited');
});

function createStatus(overrides = {}) {
    return {
        jobId: 'job-1',
        runId: 'run-1',
        state: 'running',
        chatIdentity: { kind: 'character', chatId: 'chat-1', groupId: null },
        targetUserAnchorId: 'user-anchor-1',
        targetAssistantAnchorId: 'assistant-anchor-1',
        targetMessageIndex: 1,
        targetMessageVersion: 1,
        targetFingerprint: { userMessageIndex: 0 },
        ...overrides,
    };
}

function createContext(eventSource) {
    return {
        chatId: 'chat-1',
        name2: 'Hero',
        getCurrentChatId() {
            return 'chat-1';
        },
        eventTypes: {
            MESSAGE_DELETED: 'message_deleted',
            MESSAGE_EDITED: 'message_edited',
            MESSAGE_UPDATED: 'message_updated',
            MESSAGE_SWIPED: 'message_swiped',
            MESSAGE_SWIPE_DELETED: 'message_swipe_deleted',
        },
        eventSource,
        chat: [
            {
                is_user: true,
                mes: 'Hello',
                extra: { retryMobileUserAnchorId: 'user-anchor-1' },
            },
            {
                is_user: false,
                mes: 'Reply',
                extra: { retryMobileAssistantAnchorId: 'assistant-anchor-1' },
                swipe_info: [
                    { extra: { retryMobileAssistantAnchorId: 'assistant-anchor-1' } },
                ],
            },
        ],
    };
}

function createEventSource() {
    const listeners = new Map();
    return {
        on(name, handler) {
            if (!listeners.has(name)) {
                listeners.set(name, new Set());
            }
            listeners.get(name).add(handler);
        },
        off(name, handler) {
            listeners.get(name)?.delete(handler);
        },
        emit(name, ...args) {
            for (const handler of listeners.get(name) || []) {
                handler(...args);
            }
        },
    };
}
