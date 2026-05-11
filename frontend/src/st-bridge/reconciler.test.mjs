import test from 'node:test';
import assert from 'node:assert/strict';

import { createChatReconciler } from './reconciler.js';

test('apply forwards accepted-output payloads', async () => {
    const calls = [];
    const reconciler = createChatReconciler({
        async applyAcceptedOutputFn(payload) {
            calls.push(payload);
            return { ok: true, targetMessageVersion: 3 };
        },
    });

    const result = await reconciler.apply({
        status: { targetMessageVersion: 3 },
    });
    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].status.targetMessageVersion, 3);
});

test('apply returns not-ok for null payloads', async () => {
    const reconciler = createChatReconciler({
        async applyAcceptedOutputFn() {
            return { ok: true };
        },
    });

    const result = await reconciler.apply(null);
    assert.deepEqual(result, { ok: false });
});

test('apply returns not-ok when applyAcceptedOutput fails', async () => {
    const reconciler = createChatReconciler({
        async applyAcceptedOutputFn() {
            return { ok: false, error: { code: 'client_target_dom_missing' } };
        },
    });

    const result = await reconciler.apply({
        status: { state: 'completed' },
    });
    assert.equal(result.ok, false);
});

test('reconciler exposes no restore-specific apply path', () => {
    const reconciler = createChatReconciler({
        async applyAcceptedOutputFn() {
            return { ok: true };
        },
    });

    assert.equal('reconcileAfterRestore' in reconciler, false);
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
