// lockdown.test.mjs
//
// Phase 3 unit tests: enable/disable ST cooperation, MutationObserver re-enforcement.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionLockdown } from './lockdown.js';

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeDocument({ bodyDataset = {} } = {}) {
    const listeners = {};
    const body = {
        dataset: bodyDataset,
        _observer: null,
    };
    const doc = {
        body,
        addEventListener(name, fn, opts) {
            const capture = opts === true || opts?.capture === true;
            listeners[`${name}:${capture}`] = fn;
        },
        removeEventListener(name, fn, opts) {
            const capture = opts === true || opts?.capture === true;
            const key = `${name}:${capture}`;
            if (listeners[key] === fn) {
                delete listeners[key];
            }
        },
        getElementById() { return null; },
        _listeners: listeners,
        _body: body,
    };
    return doc;
}

function makeContextWith(methods = {}) {
    return () => ({
        getCurrentChatId() { return 'chat-1'; },
        ...methods,
    });
}

// ─── enable / disable cooperation tests ──────────────────────────────────────

test('enable() calls deactivateSendButtons on ST context', () => {
    const calls = [];
    const lockdown = createSessionLockdown({
        getContext: makeContextWith({ deactivateSendButtons() { calls.push('deactivate'); } }),
        documentRef: makeDocument(),
    });

    lockdown.enable();
    assert.ok(calls.includes('deactivate'), 'enable() must call deactivateSendButtons');
    lockdown.disable();
});

test('disable() calls activateSendButtons on ST context', () => {
    const calls = [];
    const lockdown = createSessionLockdown({
        getContext: makeContextWith({
            deactivateSendButtons() {},
            activateSendButtons() { calls.push('activate'); },
        }),
        documentRef: makeDocument(),
    });

    lockdown.enable();
    lockdown.disable();
    assert.ok(calls.includes('activate'), 'disable() must call activateSendButtons');
});

test('enable() is idempotent — second call does not re-bind or re-call deactivate', () => {
    const calls = [];
    const doc = makeDocument();
    const lockdown = createSessionLockdown({
        getContext: makeContextWith({ deactivateSendButtons() { calls.push('deactivate'); } }),
        documentRef: doc,
    });

    lockdown.enable();
    const countAfterFirst = calls.length;
    lockdown.enable();
    assert.equal(calls.length, countAfterFirst, 'second enable() must not call deactivateSendButtons again');
    lockdown.disable();
});

test('disable() is idempotent — second call does not re-call activateSendButtons', () => {
    const calls = [];
    const lockdown = createSessionLockdown({
        getContext: makeContextWith({
            deactivateSendButtons() {},
            activateSendButtons() { calls.push('activate'); },
        }),
        documentRef: makeDocument(),
    });

    lockdown.enable();
    lockdown.disable();
    const countAfterFirst = calls.length;
    lockdown.disable();
    assert.equal(calls.length, countAfterFirst, 'second disable() must not call activateSendButtons again');
});

test('isActive() tracks enable/disable state', () => {
    const lockdown = createSessionLockdown({
        getContext: makeContextWith({ deactivateSendButtons() {}, activateSendButtons() {} }),
        documentRef: makeDocument(),
    });

    assert.equal(lockdown.isActive(), false);
    lockdown.enable();
    assert.equal(lockdown.isActive(), true);
    lockdown.disable();
    assert.equal(lockdown.isActive(), false);
});

// ─── MutationObserver re-enforcement test ────────────────────────────────────

test('MutationObserver re-enforces body.dataset.generating when ST clears it during lockdown', () => {
    const calls = [];

    // Capture the observer so we can manually trigger it.
    let capturedObserver = null;
    const originalMO = globalThis.MutationObserver;
    globalThis.MutationObserver = class {
        constructor(cb) { this._cb = cb; }
        observe(target) { this._target = target; capturedObserver = this; }
        disconnect() { capturedObserver = null; }
        // Helper: simulate ST calling activateSendButtons() which deletes the flag
        simulateFlagCleared() {
            delete this._target.dataset.generating;
            this._cb([]);
        }
    };

    const doc = makeDocument();

    try {
        const lockdown = createSessionLockdown({
            getContext: makeContextWith({
                deactivateSendButtons() { calls.push('deactivate'); },
                activateSendButtons() { calls.push('activate'); },
            }),
            documentRef: doc,
        });

        lockdown.enable();
        assert.ok(capturedObserver, 'MutationObserver must be started on enable()');
        calls.length = 0;

        // Simulate ST clearing the flag (e.g. native generation completed).
        capturedObserver.simulateFlagCleared();

        assert.ok(
            calls.includes('deactivate'),
            'MutationObserver must call deactivateSendButtons when flag is cleared while lockdown is active',
        );
        lockdown.disable();
    } finally {
        globalThis.MutationObserver = originalMO;
    }
});

test('MutationObserver does NOT re-enforce when lockdown has been disabled', () => {
    const calls = [];

    let capturedObserver = null;
    const originalMO = globalThis.MutationObserver;
    globalThis.MutationObserver = class {
        constructor(cb) { this._cb = cb; }
        observe(target) { this._target = target; capturedObserver = this; }
        disconnect() { capturedObserver = null; }
        simulateFlagCleared() {
            delete this._target.dataset.generating;
            this._cb([]);
        }
    };

    try {
        const lockdown = createSessionLockdown({
            getContext: makeContextWith({
                deactivateSendButtons() { calls.push('deactivate'); },
                activateSendButtons() {},
            }),
            documentRef: makeDocument(),
        });

        lockdown.enable();
        lockdown.disable();

        // Observer was disconnected by disable(). capturedObserver is null.
        // Even if we had a stale reference and fired it, the active guard would prevent re-enforcement.
        assert.equal(capturedObserver, null, 'observer must be disconnected after disable()');
    } finally {
        globalThis.MutationObserver = originalMO;
    }
});

// ─── overswipe gate tests ─────────────────────────────────────────────────────

test('click on .last_mes .swipe_right is blocked when it would cause generation', () => {
    const calls = [];
    let clickHandler = null;
    const doc = makeDocument();
    doc.addEventListener = (name, fn, opts) => {
        const capture = opts === true || opts?.capture === true;
        if (name === 'click' && capture) clickHandler = fn;
    };
    doc.removeEventListener = () => {};

    const lockdown = createSessionLockdown({
        getContext: makeContextWith({
            deactivateSendButtons() {},
            chat: [
                { is_user: true, mes: 'u' },
                { is_user: false, is_system: false, swipe_id: 0, swipes: ['only'], mes: 'only' },
            ],
            chatMetadata: { tainted: true },
        }),
        showToast() {},
        documentRef: doc,
    });
    lockdown.enable();

    clickHandler({
        target: { closest(sel) { return sel === '.last_mes .swipe_right' ? this : null; } },
        preventDefault() { calls.push('prevented'); },
        stopImmediatePropagation() {},
        stopPropagation() {},
    });
    assert.ok(calls.includes('prevented'), 'generation-causing overswipe click must be blocked');
    lockdown.disable();
});

test('click on .last_mes .swipe_right is NOT blocked when next swipe exists (no generation)', () => {
    const calls = [];
    let clickHandler = null;
    const doc = makeDocument();
    doc.addEventListener = (name, fn, opts) => {
        const capture = opts === true || opts?.capture === true;
        if (name === 'click' && capture) clickHandler = fn;
    };
    doc.removeEventListener = () => {};

    const lockdown = createSessionLockdown({
        getContext: makeContextWith({
            deactivateSendButtons() {},
            chat: [
                { is_user: true, mes: 'u' },
                // Two swipes — swipe_id 0 of 2 — advancing doesn't cause generation
                { is_user: false, is_system: false, swipe_id: 0, swipes: ['a', 'b'], mes: 'a' },
            ],
            chatMetadata: { tainted: true },
        }),
        documentRef: doc,
    });
    lockdown.enable();

    clickHandler({
        target: { closest(sel) { return sel === '.last_mes .swipe_right' ? this : null; } },
        preventDefault() { calls.push('prevented'); },
        stopImmediatePropagation() {},
        stopPropagation() {},
    });
    assert.equal(calls.length, 0, 'navigating to an existing candidate must not be blocked');
    lockdown.disable();
});

// ─── parallel CSS lockdown class (E3) ─────────────────────────────────────────

test('enable() sets body.dataset.retryMobileLockdown', () => {
    const doc = makeDocument();
    const calls = [];
    const lockdown = createSessionLockdown({
        getContext: makeContextWith({
            deactivateSendButtons() { calls.push('deactivate'); },
            activateSendButtons() { calls.push('activate'); },
        }),
        documentRef: doc,
    });
    lockdown.enable();
    assert.equal(doc.body.dataset.retryMobileLockdown, 'true', 'enable() must set body.dataset.retryMobileLockdown');
    lockdown.disable();
});

test('disable() removes body.dataset.retryMobileLockdown', () => {
    const doc = makeDocument();
    const lockdown = createSessionLockdown({
        getContext: makeContextWith({
            deactivateSendButtons() {},
            activateSendButtons() {},
        }),
        documentRef: doc,
    });
    lockdown.enable();
    lockdown.disable();
    assert.equal(doc.body.dataset.retryMobileLockdown, undefined, 'disable() must remove body.dataset.retryMobileLockdown');
});

test('MutationObserver re-enforces retryMobileLockdown when ST clears body.dataset.generating during lockdown', () => {
    let capturedObserver = null;
    const bodyDataset = {};
    const body = {
        dataset: bodyDataset,
        observe: undefined,
    };
    const doc = {
        body,
        addEventListener() {},
        removeEventListener() {},
        getElementById() { return null; },
    };

    const OriginalMutationObserver = globalThis.MutationObserver;
    globalThis.MutationObserver = class {
        constructor(cb) {
            this._cb = cb;
            capturedObserver = this;
        }
        observe(target, opts) {
            this._target = target;
            this._opts = opts;
        }
        disconnect() {
            capturedObserver = null;
        }
    };

    try {
        const lockdown = createSessionLockdown({
            getContext: makeContextWith({
                deactivateSendButtons() {
                    bodyDataset.generating = 'true';
                },
                activateSendButtons() {
                    delete bodyDataset.generating;
                },
            }),
            documentRef: doc,
        });

        lockdown.enable();
        assert.equal(bodyDataset.retryMobileLockdown, 'true', 'retryMobileLockdown set on enable');

        // Simulate ST clearing body.dataset.generating and retryMobileLockdown
        delete bodyDataset.generating;
        delete bodyDataset.retryMobileLockdown;

        // Fire the observer
        capturedObserver._cb([{ type: 'attributes' }]);

        assert.equal(bodyDataset.retryMobileLockdown, 'true', 'retryMobileLockdown re-enforced after observer fires');

        lockdown.disable();
        assert.equal(bodyDataset.retryMobileLockdown, undefined, 'retryMobileLockdown cleared on disable');
    } finally {
        globalThis.MutationObserver = OriginalMutationObserver;
    }
});
