import test from 'node:test';
import assert from 'node:assert/strict';

import { chooseVisibleRetryLogStatus } from './system-controller.js';

test('chooseVisibleRetryLogStatus falls back to the latest job when no active status is present', () => {
    const latest = {
        jobId: 'job-latest',
        updatedAt: '2026-04-23T22:13:55.567Z',
    };

    assert.equal(chooseVisibleRetryLogStatus(null, latest), latest);
});

test('chooseVisibleRetryLogStatus keeps the active status when it is at least as recent as the latest job', () => {
    const active = {
        jobId: 'job-active',
        updatedAt: '2026-04-23T22:14:00.000Z',
    };
    const latest = {
        jobId: 'job-latest',
        updatedAt: '2026-04-23T22:13:55.567Z',
    };

    assert.equal(chooseVisibleRetryLogStatus(active, latest), active);
});

test('chooseVisibleRetryLogStatus prefers the newer latest job over a stale active status', () => {
    const active = {
        jobId: 'job-old',
        updatedAt: '2026-04-23T22:08:58.091Z',
    };
    const latest = {
        jobId: 'job-new',
        updatedAt: '2026-04-23T22:13:55.567Z',
    };

    assert.equal(chooseVisibleRetryLogStatus(active, latest), latest);
});
