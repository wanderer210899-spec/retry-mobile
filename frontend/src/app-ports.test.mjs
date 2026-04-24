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

    assert.equal(calls.length, 4);
    assert.deepEqual(calls[0], ['updateActiveJob', status, 'job-1']);
    assert.deepEqual(calls[1], ['onStatus', status]);
    assert.deepEqual(calls[2], ['syncRuntimeFromFsm', retryFsm]);
    assert.deepEqual(calls[3], ['render']);
    assert.equal(calls.filter(([method]) => method === 'render').length, 1);
});

test('handleJobPortResponse renders once when a backend response materially changes active job status', () => {
    const calls = [];
    const result = {
        job: {
            jobId: 'job-1',
            state: 'running',
        },
    };

    const returned = handleJobPortResponse({
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

test('handleJobPortResponse skips rendering when the backend response does not change visible job state', () => {
    const calls = [];
    const result = {
        job: {
            jobId: 'job-1',
            state: 'running',
        },
    };

    const returned = handleJobPortResponse({
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
