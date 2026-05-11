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

test('reconcileLatestForCurrentChat routes latest completed output through FSM ingest', async () => {
    const calls = [];
    const latest = {
        jobId: 'job-complete',
        state: 'completed',
        targetMessageVersion: 2,
        chatIdentity: {
            kind: 'character',
            chatId: 'chat-1',
            groupId: null,
        },
    };
    const controller = createRestoreController({
        runtime: {},
        retryFsm: {
            getState() {
                return 'armed';
            },
        },
        intentPort: {},
        baseBackendPort: {
            async fetchLatestJob(identity) {
                calls.push({ method: 'fetchLatestJob', identity });
                return latest;
            },
        },
        stPort: {},
        updateActiveJob(status, jobId, options) {
            calls.push({ method: 'updateActiveJob', status, jobId, options });
            return true;
        },
        render() {
            calls.push({ method: 'render' });
        },
        syncRuntimeFromFsm() {},
        getCurrentChatIdentity() {
            return latest.chatIdentity;
        },
        toStructuredError(error) {
            return error;
        },
    });

    const result = await controller.reconcileLatestForCurrentChat({ reason: 'focus' });

    assert.equal(result.ok, true);
    assert.equal(calls[0].method, 'fetchLatestJob');
    assert.equal(calls.some((call) => call.method === 'updateActiveJob' && call.jobId === 'job-complete'), true);
    const updateCall = calls.find((call) => call.method === 'updateActiveJob');
    assert.equal(updateCall.options.recoverTerminal, true);
    assert.equal(calls.some((call) => call.method === 'reconcileAfterRestore'), false);
});

test('reconcileLatestForCurrentChat does not patch chat outside FSM ingest', async () => {
    const calls = [];
    const latest = {
        jobId: 'job-complete',
        state: 'completed',
        targetMessageVersion: 1,
        chatIdentity: {
            kind: 'character',
            chatId: 'chat-1',
            groupId: null,
        },
    };
    const controller = createRestoreController({
        runtime: {},
        retryFsm: {
            getState() {
                return 'armed';
            },
        },
        intentPort: {},
        baseBackendPort: {
            async fetchLatestJob() {
                return latest;
            },
        },
        stPort: {},
        updateActiveJob(status, jobId, options) {
            calls.push({ method: 'updateActiveJob', status, jobId, options });
            return true;
        },
        render() {
            calls.push({ method: 'render' });
        },
        syncRuntimeFromFsm() {},
        getCurrentChatIdentity() {
            return latest.chatIdentity;
        },
        toStructuredError(error) {
            return error;
        },
    });

    const result = await controller.reconcileLatestForCurrentChat({
        reason: 'manual_sync',
        allowReload: true,
    });

    assert.equal(result.ok, true);
    assert.deepEqual(calls.map((call) => call.method), ['updateActiveJob', 'render']);
    assert.equal(calls[0].options.recoverTerminal, true);
});

// E5: restore controller subscribes to CHAT_LOADED (character chat reloads) in addition to CHAT_CHANGED.
test('restore controller subscribes to CHAT_LOADED when available (E5)', async () => {
    const subscribedNames = [];
    let capturedHandler = null;
    const controller = createRestoreController({
        runtime: {},
        retryFsm: { getState() { return 'idle'; } },
        intentPort: {},
        baseBackendPort: {},
        stPort: {},
        updateActiveJob() {},
        render() {},
        syncRuntimeFromFsm() {},
        getCurrentChatIdentity() { return { kind: 'character', chatId: 'chat-1', groupId: null }; },
        toStructuredError(e) { return e; },
        subscribeEvent(eventName, callback) {
            subscribedNames.push(eventName);
            capturedHandler = callback;
            return () => {};
        },
        eventTypes: {
            CHAT_CHANGED: 'chat_changed',
            CHAT_LOADED: 'chat_loaded',
        },
    });

    controller.subscribeChatChangedRestore();
    assert.ok(subscribedNames.includes('chat_changed'), 'must subscribe to CHAT_CHANGED');
    assert.ok(subscribedNames.includes('chat_loaded'), 'must subscribe to CHAT_LOADED');
    assert.equal(typeof capturedHandler, 'function');
});

test('restore controller CHAT_LOADED fires same handler as CHAT_CHANGED (E5)', async () => {
    const handlers = {};
    const controller = createRestoreController({
        runtime: {},
        retryFsm: { getState() { return 'idle'; } },
        intentPort: {},
        baseBackendPort: {},
        stPort: {},
        updateActiveJob() {},
        render() {},
        syncRuntimeFromFsm() {},
        getCurrentChatIdentity() { return { kind: 'character', chatId: 'chat-2', groupId: null }; },
        toStructuredError(e) { return e; },
        subscribeEvent(eventName, callback) {
            handlers[eventName] = callback;
            return () => {};
        },
        eventTypes: {
            CHAT_CHANGED: 'chat_changed',
            CHAT_LOADED: 'chat_loaded',
        },
    });

    controller.subscribeChatChangedRestore();
    assert.equal(handlers['chat_changed'], handlers['chat_loaded'], 'CHAT_CHANGED and CHAT_LOADED must share the same handler function');
});

test('restore controller unsubscribes both CHAT_CHANGED and CHAT_LOADED (E5)', () => {
    const stopped = [];
    const controller = createRestoreController({
        runtime: {},
        retryFsm: { getState() { return 'idle'; } },
        intentPort: {},
        baseBackendPort: {},
        stPort: {},
        updateActiveJob() {},
        render() {},
        syncRuntimeFromFsm() {},
        getCurrentChatIdentity() { return null; },
        toStructuredError(e) { return e; },
        subscribeEvent(eventName) {
            return () => { stopped.push(eventName); };
        },
        eventTypes: {
            CHAT_CHANGED: 'chat_changed',
            CHAT_LOADED: 'chat_loaded',
        },
    });

    controller.subscribeChatChangedRestore();
    controller.unsubscribeChatChangedRestore();
    assert.ok(stopped.includes('chat_changed'), 'must unsubscribe CHAT_CHANGED');
    assert.ok(stopped.includes('chat_loaded'), 'must unsubscribe CHAT_LOADED');
});
