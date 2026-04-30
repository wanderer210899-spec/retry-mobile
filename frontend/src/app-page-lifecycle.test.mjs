import test from 'node:test';
import assert from 'node:assert/strict';

import { bindPageObservers, unbindPageObservers } from './app-page-lifecycle.js';

function createEventTarget() {
    const listeners = new Map();

    return {
        addEventListener(type, handler, options) {
            const current = listeners.get(type) || [];
            current.push({ handler, options });
            listeners.set(type, current);
        },
        removeEventListener(type, handler) {
            const current = listeners.get(type) || [];
            listeners.set(type, current.filter((entry) => entry.handler !== handler));
        },
        dispatch(type, event) {
            for (const { handler } of listeners.get(type) || []) {
                handler(event);
            }
        },
        listenerCount(type) {
            return (listeners.get(type) || []).length;
        },
        listenerOptions(type) {
            return (listeners.get(type) || []).map((entry) => entry.options);
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
    assert.equal(windowRef.listenerCount('pageshow'), 1);

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

test('BFCache pageshow with persisted=true dispatches page.visible and logs bfcache_restore', () => {
    const documentRef = createEventTarget();
    const windowRef = createEventTarget();
    documentRef.visibilityState = 'visible';

    const runtime = {};
    const dispatched = [];
    const logged = [];
    bindPageObservers(runtime, {
        documentRef,
        windowRef,
        dispatch(type) { dispatched.push(type); },
        logEvent(event, summary, detail) { logged.push([event, summary, detail]); },
    });

    windowRef.dispatch('pageshow', { persisted: true });
    assert.deepEqual(dispatched, ['page.visible']);
    assert.equal(logged.length, 1);
    assert.equal(logged[0][0], 'bfcache_restore');
});

test('pageshow with persisted=false is ignored (normal page load)', () => {
    const documentRef = createEventTarget();
    const windowRef = createEventTarget();
    documentRef.visibilityState = 'visible';

    const runtime = {};
    const dispatched = [];
    const logged = [];
    bindPageObservers(runtime, {
        documentRef,
        windowRef,
        dispatch(type) { dispatched.push(type); },
        logEvent(event, summary, detail) { logged.push([event, summary, detail]); },
    });

    windowRef.dispatch('pageshow', { persisted: false });
    assert.deepEqual(dispatched, []);
    assert.deepEqual(logged, []);
});

test('all bound listeners are passive (none veto scrolling)', () => {
    const documentRef = createEventTarget();
    const windowRef = createEventTarget();
    documentRef.visibilityState = 'visible';

    bindPageObservers({}, {
        documentRef,
        windowRef,
        dispatch() {},
        logEvent() {},
    });

    for (const options of documentRef.listenerOptions('visibilitychange')) {
        assert.equal(options?.passive, true, 'visibilitychange listener must be passive');
    }
    for (const eventName of ['focus', 'online', 'pageshow']) {
        for (const options of windowRef.listenerOptions(eventName)) {
            assert.equal(options?.passive, true, `${eventName} listener must be passive`);
        }
    }
});
