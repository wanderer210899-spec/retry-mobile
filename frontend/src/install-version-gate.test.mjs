import test from 'node:test';
import assert from 'node:assert/strict';

import { applyInstallVersionGate } from './install-version-gate.js';

function createFakeStorage(initial = {}) {
    const map = new Map(Object.entries(initial));
    return {
        get length() {
            return map.size;
        },
        getItem(key) {
            return map.has(key) ? map.get(key) : null;
        },
        setItem(key, value) {
            map.set(String(key), String(value));
        },
        removeItem(key) {
            map.delete(String(key));
        },
        key(index) {
            return [...map.keys()][index] ?? null;
        },
        _snapshot() {
            return Object.fromEntries(map.entries());
        },
    };
}

function createIntentPort() {
    const writes = [];
    return {
        writes,
        writeIntent(patch) {
            writes.push(patch);
        },
    };
}

test('applyInstallVersionGate stamps the version on first boot without clearing engaged', () => {
    const storage = createFakeStorage();
    const intentPort = createIntentPort();

    const result = applyInstallVersionGate({
        installedVersion: '0.1.7',
        intentPort,
        storage,
    });

    assert.equal(result.changed, false);
    assert.equal(result.previous, '');
    assert.equal(result.current, '0.1.7');
    assert.equal(intentPort.writes.length, 0);
    assert.equal(storage.getItem('retry-mobile:last-seen-installed-version'), '0.1.7');
});

test('applyInstallVersionGate is a no-op when the version matches', () => {
    const storage = createFakeStorage({
        'retry-mobile:last-seen-installed-version': '0.1.7',
        'retry-mobile:active-run:character::chat-1::': JSON.stringify({ jobId: 'j1' }),
    });
    const intentPort = createIntentPort();

    const result = applyInstallVersionGate({
        installedVersion: '0.1.7',
        intentPort,
        storage,
    });

    assert.equal(result.changed, false);
    assert.equal(intentPort.writes.length, 0);
    assert.ok(storage.getItem('retry-mobile:active-run:character::chat-1::'));
});

test('applyInstallVersionGate clears engaged + active-run bindings when version changes', () => {
    const storage = createFakeStorage({
        'retry-mobile:last-seen-installed-version': '0.1.6',
        'retry-mobile:active-run:character::chat-1::': JSON.stringify({ jobId: 'j1' }),
        'retry-mobile:active-run:character::chat-2::': JSON.stringify({ jobId: 'j2' }),
        'retry-mobile:session-id': 'session-keep-me',
        'unrelated-key': 'should-be-untouched',
    });
    const intentPort = createIntentPort();

    const result = applyInstallVersionGate({
        installedVersion: '0.1.7',
        intentPort,
        storage,
    });

    assert.equal(result.changed, true);
    assert.equal(result.previous, '0.1.6');
    assert.equal(result.current, '0.1.7');
    assert.equal(result.clearedBindings, 2);
    assert.deepEqual(intentPort.writes, [{ engaged: false }]);
    assert.equal(storage.getItem('retry-mobile:active-run:character::chat-1::'), null);
    assert.equal(storage.getItem('retry-mobile:active-run:character::chat-2::'), null);
    assert.equal(storage.getItem('retry-mobile:session-id'), 'session-keep-me');
    assert.equal(storage.getItem('unrelated-key'), 'should-be-untouched');
    assert.equal(storage.getItem('retry-mobile:last-seen-installed-version'), '0.1.7');
});

test('applyInstallVersionGate is a no-op when installedVersion is empty (capabilities fetch failed)', () => {
    const storage = createFakeStorage({
        'retry-mobile:last-seen-installed-version': '0.1.6',
        'retry-mobile:active-run:character::chat-1::': JSON.stringify({ jobId: 'j1' }),
    });
    const intentPort = createIntentPort();

    const result = applyInstallVersionGate({
        installedVersion: '',
        intentPort,
        storage,
    });

    assert.equal(result.changed, false);
    assert.equal(intentPort.writes.length, 0);
    assert.ok(storage.getItem('retry-mobile:active-run:character::chat-1::'));
});

test('applyInstallVersionGate handles missing storage gracefully', () => {
    const intentPort = createIntentPort();
    const result = applyInstallVersionGate({
        installedVersion: '0.1.7',
        intentPort,
        storage: null,
    });

    assert.equal(result.changed, false);
    assert.equal(intentPort.writes.length, 0);
});

test('applyInstallVersionGate tolerates a thrown error from intentPort.writeIntent', () => {
    const storage = createFakeStorage({
        'retry-mobile:last-seen-installed-version': '0.1.6',
    });
    const intentPort = {
        writeIntent() {
            throw new Error('settings unavailable');
        },
    };

    const result = applyInstallVersionGate({
        installedVersion: '0.1.7',
        intentPort,
        storage,
    });

    assert.equal(result.changed, true);
    assert.equal(storage.getItem('retry-mobile:last-seen-installed-version'), '0.1.7');
});
