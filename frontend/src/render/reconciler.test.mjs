import test from 'node:test';
import assert from 'node:assert/strict';

import { createChatReconciler } from './reconciler.js';

test('applyStatus forwards accepted-output payloads', async () => {
    const calls = [];
    const reconciler = createChatReconciler({
        async applyAcceptedOutputFn(payload) {
            calls.push(payload);
            return { ok: true, targetMessageVersion: 3 };
        },
    });

    const result = await reconciler.applyStatus({
        kind: 'accepted_output',
        status: { targetMessageVersion: 3 },
    });
    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].status.targetMessageVersion, 3);
});

test('flushPending returns not-ok for empty payloads', async () => {
    const reconciler = createChatReconciler({
        async applyAcceptedOutputFn() {
            return { ok: true };
        },
    });

    const result = await reconciler.flushPending(null);
    assert.deepEqual(result, { ok: false });
});

test('applyTerminal does not reload on failed apply (FSM owns last-resort reload)', async () => {
    const calls = [];
    const reconciler = createChatReconciler({
        async applyAcceptedOutputFn() {
            return { ok: false, error: { code: 'client_target_dom_missing' } };
        },
    });

    const result = await reconciler.applyTerminal({
        kind: 'accepted_output',
        status: { state: 'completed' },
    });
    assert.equal(result.ok, false);
    assert.deepEqual(calls, []);
});

test('reconcileAfterRestore retries up to 4 times before giving up, never reloads', async () => {
    const calls = [];
    const reconciler = createChatReconciler({
        async applyAcceptedOutputFn() {
            calls.push('apply');
            // recoveryRequired: true means ST is still loading — keep retrying
            return { ok: false, recoveryRequired: true, error: { code: 'client_target_dom_missing' } };
        },
    });

    const result = await reconciler.reconcileAfterRestore({
        kind: 'accepted_output',
        status: { state: 'running', targetMessageVersion: 5 },
    });
    assert.equal(result.ok, false);
    // 4 attempts: immediate + 3 delayed retries (350ms, 750ms, 1400ms)
    assert.equal(calls.length, 4);
    assert.ok(!calls.includes('reload'));
});

test('reconcileAfterRestore stops retrying when recoveryRequired is false (chat changed)', async () => {
    const calls = [];
    const reconciler = createChatReconciler({
        async applyAcceptedOutputFn() {
            calls.push('apply');
            return { ok: false, recoveryRequired: false, error: { code: 'client_chat_changed' } };
        },
    });

    const result = await reconciler.reconcileAfterRestore({
        kind: 'accepted_output',
        status: { state: 'completed', targetMessageVersion: 2 },
    });
    assert.equal(result.ok, false);
    // Stops after first attempt because recoveryRequired === false
    assert.equal(calls.length, 1);
});

test('reconcileAfterRestore succeeds on second attempt when chat settles', async () => {
    let callCount = 0;
    const reconciler = createChatReconciler({
        async applyAcceptedOutputFn() {
            callCount += 1;
            if (callCount < 2) {
                return { ok: false, recoveryRequired: true, error: { code: 'client_target_missing' } };
            }
            return { ok: true, targetMessageVersion: 1 };
        },
    });

    const result = await reconciler.reconcileAfterRestore({
        kind: 'accepted_output',
        status: { state: 'completed', targetMessageVersion: 1 },
    });
    assert.equal(result.ok, true);
    assert.equal(callCount, 2);
});

test('reconciler active state toggles for FSM invariants', () => {
    const reconciler = createChatReconciler({
        async applyAcceptedOutputFn() {
            return { ok: true };
        },
    });
    assert.equal(reconciler.isActive(), false);
    reconciler.setActive(true);
    assert.equal(reconciler.isActive(), true);
    reconciler.setActive(false);
    assert.equal(reconciler.isActive(), false);
});
