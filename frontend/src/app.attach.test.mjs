import test from 'node:test';
import assert from 'node:assert/strict';

import { handleStartJobFailure } from './app-ports.js';
import { RetryState } from './retry-fsm.js';

test('handleStartJobFailure surfaces rejected attach conflicts through jobFailed instead of leaving CAPTURING stuck', () => {
    const chatIdentity = { kind: 'character', chatId: 'chat-1', groupId: null };
    const target = { chatIdentity, assistantAnchorId: 'assistant-anchor-1' };
    const calls = [];
    const retryFsm = {
        getContext() {
            return {
                runId: 'run-current',
                chatIdentity,
                target,
            };
        },
        getState() {
            return RetryState.CAPTURING;
        },
        restoreRunning(payload) {
            calls.push({ method: 'restoreRunning', payload });
        },
        jobFailed(payload) {
            calls.push({ method: 'jobFailed', payload });
        },
    };

    handleStartJobFailure({
        error: {
            status: 409,
            payload: {
                reason: 'job_running',
                job: {
                    jobId: 'job-conflict',
                    runId: 'run-other',
                    state: 'running',
                    chatIdentity,
                },
            },
        },
        payload: {
            runId: 'run-start',
            chatIdentity,
            target,
        },
        retryFsm,
        updateActiveJob(status, jobId) {
            calls.push({ method: 'updateActiveJob', args: [status, jobId] });
        },
        syncRuntimeFromFsm(fsm) {
            calls.push({ method: 'syncRuntimeFromFsm', args: [fsm] });
        },
        render() {
            calls.push({ method: 'render', args: [] });
        },
        flushPendingNativeOutcome() {
            calls.push({ method: 'flushPendingNativeOutcome', args: [] });
        },
    });

    assert.equal(calls.some((entry) => entry.method === 'restoreRunning'), false);
    assert.equal(calls.some((entry) => entry.method === 'updateActiveJob'), false);
    assert.equal(calls.some((entry) => entry.method === 'flushPendingNativeOutcome'), false);
    assert.equal(calls.filter((entry) => entry.method === 'syncRuntimeFromFsm').length, 1);
    assert.equal(calls.filter((entry) => entry.method === 'render').length, 1);

    const failedCall = calls.find((entry) => entry.method === 'jobFailed');
    assert.ok(failedCall, 'expected the rejected attach conflict to fail the start path');
    assert.deepEqual(failedCall.payload.chatIdentity, chatIdentity);
    assert.equal(failedCall.payload.error.code, 'attach_conflict_rejected');
    assert.match(failedCall.payload.error.detail || '', /conflict_job_id=job-conflict/);
    assert.match(failedCall.payload.error.detail || '', /capture_run_id=run-start/);
});
