import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildCommittedReloadKey,
    clearCommittedReloads,
    shouldCommitStatusReload,
} from './chat-sync.js';

test('reload keys are job-and-version scoped', () => {
    assert.equal(buildCommittedReloadKey({
        jobId: 'job-1',
        targetMessageVersion: 3,
    }), 'job-1:3');

    assert.equal(buildCommittedReloadKey({
        jobId: 'job-1',
        targetMessageVersion: 0,
    }), '');
});

test('same job/version only commits once, but later versions still reload', () => {
    const runtime = {
        committedReloadKeys: new Set(),
    };

    const first = {
        jobId: 'job-1',
        targetMessageVersion: 2,
    };
    const later = {
        jobId: 'job-1',
        targetMessageVersion: 3,
    };

    assert.equal(shouldCommitStatusReload(first, runtime), true);
    runtime.committedReloadKeys.add(buildCommittedReloadKey(first));
    assert.equal(shouldCommitStatusReload(first, runtime), false);
    assert.equal(shouldCommitStatusReload(later, runtime), true);
});

test('clearing committed reloads resets the idempotency gate', () => {
    const runtime = {
        committedReloadKeys: new Set(['job-1:2']),
    };

    clearCommittedReloads(runtime);
    assert.deepEqual([...runtime.committedReloadKeys], []);
});
