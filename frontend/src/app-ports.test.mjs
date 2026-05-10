import test from 'node:test';
import assert from 'node:assert/strict';

import { handleJobPortResponse, handlePollingPortStatus } from './app-ports.js';

test('handlePollingPortStatus renders once after the status and FSM sync complete', async () => {
    const calls = [];
    const retryFsm = { id: 'fsm-1' };
    const status = { jobId: 'job-1', state: 'running' };

    await handlePollingPortStatus({
        status,
        jobId: 'job-1',
        updateActiveJob(nextStatus, nextJobId) {
            calls.push(['updateActiveJob', nextStatus, nextJobId]);
            return true;
        },
        async onStatus(nextStatus) {
            calls.push(['onStatus', nextStatus]);
        },
        syncRuntimeFromFsm(fsm) {
            calls.push(['syncRuntimeFromFsm', fsm]);
        },
        retryFsm,
        render() {
            calls.push(['render']);
        },
    });

    assert.equal(calls.length, 3);
    assert.deepEqual(calls[0], ['updateActiveJob', status, 'job-1']);
    assert.deepEqual(calls[1], ['syncRuntimeFromFsm', retryFsm]);
    assert.deepEqual(calls[2], ['render']);
    assert.equal(calls.some(([method]) => method === 'onStatus'), false);
    assert.equal(calls.filter(([method]) => method === 'render').length, 1);
});

test('handlePollingPortStatus waits for async FSM ingestion before projecting and rendering', async () => {
    const calls = [];
    let releaseUpdate;
    const updateDone = new Promise((resolve) => {
        releaseUpdate = resolve;
    });

    const promise = handlePollingPortStatus({
        status: { jobId: 'job-async', state: 'completed' },
        jobId: 'job-async',
        async updateActiveJob() {
            calls.push(['update-start']);
            await updateDone;
            calls.push(['update-finish']);
            return true;
        },
        async onStatus() {
            calls.push(['onStatus']);
        },
        syncRuntimeFromFsm() {
            calls.push(['sync']);
        },
        retryFsm: {},
        render() {
            calls.push(['render']);
        },
    });

    await Promise.resolve();
    assert.deepEqual(calls, [['update-start']]);

    releaseUpdate();
    await promise;

    assert.deepEqual(calls, [
        ['update-start'],
        ['update-finish'],
        ['sync'],
        ['render'],
    ]);
});

test('handleJobPortResponse renders once when a backend response materially changes active job status', async () => {
    const calls = [];
    const result = {
        job: {
            jobId: 'job-1',
            state: 'running',
        },
    };

    const returned = await handleJobPortResponse({
        result,
        jobId: 'job-1',
        updateActiveJob(job, jobId) {
            calls.push(['updateActiveJob', job, jobId]);
            return true;
        },
        render() {
            calls.push(['render']);
        },
    });

    assert.equal(returned, result);
    assert.deepEqual(calls, [
        ['updateActiveJob', result.job, 'job-1'],
        ['render'],
    ]);
});

test('handlePollingPortStatus silently drops a status whose jobId does not match the polling jobId', async () => {
    const calls = [];

    await handlePollingPortStatus({
        status: { jobId: 'job-STALE', state: 'completed' },
        jobId: 'job-CURRENT',
        updateActiveJob(nextStatus, nextJobId) {
            calls.push(['updateActiveJob', nextStatus, nextJobId]);
            return true;
        },
        async onStatus(nextStatus) {
            calls.push(['onStatus', nextStatus]);
        },
        syncRuntimeFromFsm(fsm) {
            calls.push(['syncRuntimeFromFsm', fsm]);
        },
        retryFsm: {},
        render() {
            calls.push(['render']);
        },
    });

    assert.equal(calls.length, 0, 'all downstream calls must be skipped when status jobId does not match polling jobId');
});

test('handleJobPortResponse skips rendering when the backend response does not change visible job state', async () => {
    const calls = [];
    const result = {
        job: {
            jobId: 'job-1',
            state: 'running',
        },
    };

    const returned = await handleJobPortResponse({
        result,
        jobId: 'job-1',
        updateActiveJob(job, jobId) {
            calls.push(['updateActiveJob', job, jobId]);
            return false;
        },
        render() {
            calls.push(['render']);
        },
    });

    assert.equal(returned, result);
    assert.deepEqual(calls, [
        ['updateActiveJob', result.job, 'job-1'],
    ]);
});
