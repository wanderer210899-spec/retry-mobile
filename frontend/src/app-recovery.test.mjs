import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildBootArmPayload,
    buildRestoreTarget,
    collectBootRestoreChatIdentities,
    createRestoreController,
    getAttachedJobStatusFromStartError,
    resolveCaptureTarget,
    resolveCaptureSubscriptionChatIdentity,
    shouldAttachRunningConflict,
} from './app-recovery.js';

test('getAttachedJobStatusFromStartError returns the running job payload for 409 conflicts', () => {
    const status = {
        jobId: 'job-1',
        runId: 'run-1',
        state: 'running',
    };

    assert.deepEqual(getAttachedJobStatusFromStartError({
        status: 409,
        payload: {
            reason: 'job_running',
            job: status,
        },
    }), status);
});

test('resolveCaptureSubscriptionChatIdentity prefers the durable target chat', () => {
    const targetChatIdentity = {
        kind: 'character',
        chatId: 'target-chat',
        groupId: null,
    };
    const fallbackChatIdentity = {
        kind: 'character',
        chatId: 'visible-chat',
        groupId: null,
    };

    assert.deepEqual(resolveCaptureSubscriptionChatIdentity({
        chatIdentity: fallbackChatIdentity,
        target: {
            chatIdentity: targetChatIdentity,
            assistantAnchorId: 'assistant-anchor-1',
        },
    }, fallbackChatIdentity), targetChatIdentity);
});

test('resolveCaptureSubscriptionChatIdentity follows the live chat for toggle mode', () => {
    const previousChatIdentity = {
        kind: 'character',
        chatId: 'previous-chat',
        groupId: null,
    };
    const fallbackChatIdentity = {
        kind: 'character',
        chatId: 'visible-chat',
        groupId: null,
    };

    assert.deepEqual(resolveCaptureSubscriptionChatIdentity({
        intent: { mode: 'toggle' },
        chatIdentity: previousChatIdentity,
        target: null,
    }, fallbackChatIdentity), fallbackChatIdentity);
});

test('resolveCaptureTarget derives a durable single target from the captured user turn', () => {
    const chatIdentity = {
        kind: 'character',
        chatId: 'single-chat',
        groupId: null,
    };

    assert.deepEqual(resolveCaptureTarget({
        intent: { mode: 'single' },
        target: null,
    }, {
        chatIdentity,
        userMessageIndex: 4,
    }, chatIdentity), {
        chatIdentity,
        userMessageIndex: 4,
    });
});

test('shouldAttachRunningConflict only adopts matching conflicts for the active capture run', () => {
    assert.equal(shouldAttachRunningConflict('capturing', 'run-1', 'run-1'), true);
    assert.equal(shouldAttachRunningConflict('idle', 'run-1', 'run-1'), false);
    assert.equal(shouldAttachRunningConflict('capturing', 'run-1', 'run-2'), false);
});

test('collectBootRestoreChatIdentities prefers the session binding and deduplicates chats', () => {
    const activeRunBinding = {
        chatIdentity: {
            kind: 'character',
            chatId: 'bound-chat',
            groupId: null,
        },
    };
    const currentChatIdentity = {
        kind: 'character',
        chatId: 'bound-chat',
        groupId: null,
    };
    const singleTarget = {
        chatIdentity: {
            kind: 'character',
            chatId: 'single-chat',
            groupId: null,
        },
    };

    assert.deepEqual(collectBootRestoreChatIdentities({
        activeRunBinding,
        currentChatIdentity,
        singleTarget,
    }), [
        activeRunBinding.chatIdentity,
        singleTarget.chatIdentity,
    ]);
});

test('buildBootArmPayload keeps single mode bound to the saved target chat', () => {
    const intent = {
        mode: 'single',
        engaged: true,
        singleTarget: {
            chatIdentity: {
                kind: 'character',
                chatId: 'saved-chat',
                groupId: null,
            },
            assistantAnchorId: 'assistant-anchor-1',
        },
        settings: {},
    };

    assert.deepEqual(buildBootArmPayload(intent, {
        kind: 'character',
        chatId: 'visible-chat',
        groupId: null,
    }), {
        intent,
        target: intent.singleTarget,
        chatIdentity: intent.singleTarget.chatIdentity,
    });
});

test('buildBootArmPayload refuses to re-arm single mode without a durable target identity', () => {
    assert.equal(buildBootArmPayload({
        mode: 'single',
        engaged: true,
        singleTarget: null,
        settings: {},
    }, {
        kind: 'character',
        chatId: 'visible-chat',
        groupId: null,
    }), null);
});

test('buildBootArmPayload refuses to re-arm toggle mode before the visible chat is ready', () => {
    assert.equal(buildBootArmPayload({
        mode: 'toggle',
        engaged: true,
        singleTarget: null,
        settings: {},
    }, {
        kind: 'character',
        chatId: '',
        groupId: null,
    }), null);
});

test('buildRestoreTarget prefers the saved single target when it matches the restored job chat', () => {
    const singleTarget = {
        chatIdentity: {
            kind: 'character',
            chatId: 'chat-1',
            groupId: null,
        },
        assistantAnchorId: 'assistant-anchor-1',
    };

    assert.deepEqual(buildRestoreTarget({
        chatIdentity: {
            kind: 'character',
            chatId: 'chat-1',
            groupId: null,
        },
    }, singleTarget), singleTarget);
});

test('restore controller subscribes to CHAT_CHANGED and ignores internal reload echoes', async () => {
    const events = [];
    let handler = null;
    const controller = createRestoreController({
        runtime: {},
        retryFsm: {
            getState() {
                return 'idle';
            },
        },
        intentPort: {},
        baseBackendPort: {},
        stPort: {},
        updateActiveJob() {},
        render() {},
        syncRuntimeFromFsm() {},
        getCurrentChatIdentity() {
            return {
                kind: 'character',
                chatId: 'chat-1',
                groupId: null,
            };
        },
        toStructuredError(error) {
            return error;
        },
        subscribeEvent(eventName, callback) {
            events.push(eventName);
            handler = callback;
            return () => {};
        },
        eventTypes: {
            CHAT_CHANGED: 'chat_changed',
        },
        logEvent(event) {
            events.push(event);
        },
    });

    controller.subscribeChatChangedRestore();
    assert.deepEqual(events[0], 'chat_changed');
    assert.equal(typeof handler, 'function');
    await handler();
});
