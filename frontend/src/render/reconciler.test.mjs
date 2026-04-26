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
        async reloadSessionUiFn() {
            throw new Error('reloadSessionUi should not be called on success');
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
        async reloadSessionUiFn() {},
    });

    const result = await reconciler.flushPending(null);
    assert.deepEqual(result, { ok: false });
});

test('applyTerminal performs fallback reload on failed apply', async () => {
    const calls = [];
    const reconciler = createChatReconciler({
        async applyAcceptedOutputFn() {
            return { ok: false, error: { code: 'client_target_dom_missing' } };
        },
        async reloadSessionUiFn() {
            calls.push('reload');
        },
    });

    const result = await reconciler.applyTerminal({
        kind: 'accepted_output',
        status: { state: 'completed' },
    });
    assert.equal(result.ok, false);
    assert.deepEqual(calls, ['reload']);
});

test('reconcileAfterRestore retries once then reloads on repeated failures', async () => {
    const calls = [];
    const reconciler = createChatReconciler({
        waitMs: 0,
        async applyAcceptedOutputFn() {
            calls.push('apply');
            return { ok: false, error: { code: 'client_target_dom_missing' } };
        },
        async reloadSessionUiFn() {
            calls.push('reload');
        },
    });

    const result = await reconciler.reconcileAfterRestore({
        kind: 'accepted_output',
        status: { state: 'running', targetMessageVersion: 5 },
    });
    assert.equal(result.ok, false);
    assert.deepEqual(calls, ['apply', 'apply', 'reload']);
});

test('reconciler active state toggles for FSM invariants', () => {
    const reconciler = createChatReconciler({
        async applyAcceptedOutputFn() {
            return { ok: true };
        },
        async reloadSessionUiFn() {},
    });
    assert.equal(reconciler.isActive(), false);
    reconciler.setActive(true);
    assert.equal(reconciler.isActive(), true);
    reconciler.setActive(false);
    assert.equal(reconciler.isActive(), false);
});
