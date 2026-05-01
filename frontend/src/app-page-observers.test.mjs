import test from 'node:test';
import assert from 'node:assert/strict';

import { bindPageObservers, unbindPageObservers } from './app.js';

function createEventTarget() {
    const listeners = new Map();

    return {
        addEventListener(type, handler) {
            const current = listeners.get(type) || [];
            current.push(handler);
            listeners.set(type, current);
        },
        removeEventListener(type, handler) {
            const current = listeners.get(type) || [];
            listeners.set(type, current.filter((entry) => entry !== handler));
        },
        dispatch(type) {
            for (const handler of listeners.get(type) || []) {
                handler();
            }
        },
        listenerCount(type) {
            return (listeners.get(type) || []).length;
        },
    };
}

test('bindPageObservers registers once, tears down cleanly, and rebinds without duplicate dispatches', () => {
    const documentRef = createEventTarget();
    const windowRef = createEventTarget();
    documentRef.visibilityState = 'visible';

    const runtime = {};
    const dispatched = [];
    const logged = [];
    const hooks = {
        documentRef,
        windowRef,
        dispatch(type) {
            dispatched.push(type);
        },
        logEvent(event, summary, detail) {
            logged.push([event, summary, detail]);
        },
    };

    bindPageObservers(runtime, hooks);
    bindPageObservers(runtime, hooks);
    assert.equal(documentRef.listenerCount('visibilitychange'), 1);
    assert.equal(windowRef.listenerCount('focus'), 1);
    assert.equal(windowRef.listenerCount('online'), 1);

    documentRef.visibilityState = 'hidden';
    documentRef.dispatch('visibilitychange');
    windowRef.dispatch('focus');
    windowRef.dispatch('online');

    assert.deepEqual(dispatched, ['page.hidden', 'window.focused', 'network.online']);
    assert.equal(logged.length, 3);

    assert.equal(unbindPageObservers(runtime), true);
    documentRef.visibilityState = 'visible';
    documentRef.dispatch('visibilitychange');
    windowRef.dispatch('focus');
    windowRef.dispatch('online');
    assert.deepEqual(dispatched, ['page.hidden', 'window.focused', 'network.online']);

    bindPageObservers(runtime, hooks);
    documentRef.visibilityState = 'visible';
    documentRef.dispatch('visibilitychange');
    windowRef.dispatch('focus');

    assert.deepEqual(dispatched, [
        'page.hidden',
        'window.focused',
        'network.online',
        'page.visible',
        'window.focused',
    ]);
    assert.equal(documentRef.listenerCount('visibilitychange'), 1);
    assert.equal(windowRef.listenerCount('focus'), 1);
});
