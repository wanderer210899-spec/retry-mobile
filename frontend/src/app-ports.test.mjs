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
    const logEvents = [];

    await handlePollingPortStatus({
        status: { jobId: 'job-STALE', runId: 'run-old', state: 'completed', phase: 'done', revision: 9, targetMessageVersion: 4 },
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
        logEvent(event, summary, detail) {
            logEvents.push({ event, summary, detail });
        },
    });

    assert.equal(calls.length, 0, 'all downstream calls must be skipped when status jobId does not match polling jobId');
    assert.equal(logEvents.length, 1);
    assert.equal(logEvents[0].event, 'status_response_rejected');
    assert.equal(logEvents[0].detail.reason, 'job_id_mismatch');
    assert.equal(logEvents[0].detail.expectedJobId, 'job-CURRENT');
    assert.equal(logEvents[0].detail.responseJobId, 'job-STALE');
    assert.equal(logEvents[0].detail.responseRevision, 9);
    assert.equal(logEvents[0].detail.responseTargetMessageVersion, 4);
});

test('handlePollingPortStatus skips projection when FSM ingestion rejects the status', async () => {
    const calls = [];

    const accepted = await handlePollingPortStatus({
        status: { jobId: 'job-1', state: 'running', revision: 1 },
        jobId: 'job-1',
        updateActiveJob(nextStatus, nextJobId) {
            calls.push(['updateActiveJob', nextStatus, nextJobId]);
            return false;
        },
        syncRuntimeFromFsm(fsm) {
            calls.push(['syncRuntimeFromFsm', fsm]);
        },
        retryFsm: {},
        render() {
            calls.push(['render']);
        },
    });

    assert.equal(accepted, false);
    assert.deepEqual(calls, [
        ['updateActiveJob', { jobId: 'job-1', state: 'running', revision: 1 }, 'job-1'],
    ]);
});

test('handleJobPortResponse drops mismatched jobId and runId responses before active-job ingestion', async () => {
    const calls = [];
    const logEvents = [];
    const mismatchedJob = {
        job: {
            jobId: 'job-stale',
            runId: 'run-current',
            state: 'running',
            phase: 'backend_running',
            revision: 3,
        },
    };
    const mismatchedRun = {
        job: {
            jobId: 'job-current',
            runId: 'run-stale',
            state: 'running',
            phase: 'native_confirmed',
            revision: 4,
            targetMessageVersion: 2,
        },
    };

    await handleJobPortResponse({
        result: mismatchedJob,
        jobId: 'job-current',
        runId: 'run-current',
        updateActiveJob() {
            calls.push(['updateActiveJob']);
            return true;
        },
        render() {
            calls.push(['render']);
        },
        logEvent(event, summary, detail) {
            logEvents.push({ event, summary, detail });
        },
        source: 'confirm_native_response',
    });
    await handleJobPortResponse({
        result: mismatchedRun,
        jobId: 'job-current',
        runId: 'run-current',
        updateActiveJob() {
            calls.push(['updateActiveJob']);
            return true;
        },
        render() {
            calls.push(['render']);
        },
        logEvent(event, summary, detail) {
            logEvents.push({ event, summary, detail });
        },
        source: 'frontend_presence_response',
    });

    assert.deepEqual(calls, []);
    assert.equal(logEvents.length, 2);
    assert.equal(logEvents[0].event, 'job_response_rejected');
    assert.equal(logEvents[0].detail.source, 'confirm_native_response');
    assert.equal(logEvents[0].detail.reason, 'job_id_mismatch');
    assert.equal(logEvents[0].detail.expectedJobId, 'job-current');
    assert.equal(logEvents[0].detail.responseJobId, 'job-stale');
    assert.equal(logEvents[0].detail.responseRevision, 3);
    assert.equal(logEvents[1].detail.source, 'frontend_presence_response');
    assert.equal(logEvents[1].detail.reason, 'run_id_mismatch');
    assert.equal(logEvents[1].detail.expectedRunId, 'run-current');
    assert.equal(logEvents[1].detail.responseRunId, 'run-stale');
    assert.equal(logEvents[1].detail.responseTargetMessageVersion, 2);
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
