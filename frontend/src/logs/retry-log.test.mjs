import test from 'node:test';
import assert from 'node:assert/strict';

import { buildFrontendStatusSnapshot, sendFrontendLogEvent } from './retry-log.js';

test('buildFrontendStatusSnapshot keeps a compact race-debugging snapshot', () => {
    const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'document', {
        value: { visibilityState: 'hidden' },
        configurable: true,
        writable: true,
    });
    Object.defineProperty(globalThis, 'navigator', {
        value: { onLine: false },
        configurable: true,
        writable: true,
    });

    try {
        const snapshot = buildFrontendStatusSnapshot({
            activeJobId: 'job-1',
            activeJobStatus: {
                jobId: 'job-1',
                runId: 'run-1',
                state: 'running',
                phase: 'writing_chat',
                revision: 7,
                acceptedCount: 1,
                targetAcceptedCount: 2,
                attemptCount: 3,
                maxAttempts: 10,
                targetMessageVersion: 4,
                nativeState: 'confirmed',
                frontendVisibilityState: 'hidden',
            },
            retryFsm: {
                getState() { return 'running'; },
                getContext() {
                    return {
                        jobId: 'job-1',
                        runId: 'run-1',
                        lastStatusRevision: 7,
                        lastKnownTargetMessageVersion: 4,
                        lastAppliedVersion: 3,
                        pendingVisibleRender: {
                            status: {
                                targetMessageVersion: 4,
                            },
                        },
                        reloadAttempted: true,
                        runError: { code: 'render_apply_failed' },
                    };
                },
            },
            log: {
                jobId: 'job-1',
                entryCount: 5,
                updatedAt: '2026-05-11T12:00:00.000Z',
            },
        });

        assert.deepEqual(snapshot, {
            fsmState: 'running',
            fsmJobId: 'job-1',
            fsmRunId: 'run-1',
            fsmLastStatusRevision: 7,
            runtimeActiveJobId: 'job-1',
            runtimeMirrorJobId: 'job-1',
            runtimeMirrorRunId: 'run-1',
            runtimeMirrorState: 'running',
            runtimeMirrorPhase: 'writing_chat',
            runtimeMirrorRevision: 7,
            runtimeAcceptedCount: 1,
            runtimeTargetAcceptedCount: 2,
            runtimeAttemptCount: 3,
            runtimeMaxAttempts: 10,
            runtimeTargetMessageVersion: 4,
            runtimeNativeState: 'confirmed',
            runtimeFrontendVisibilityState: 'hidden',
            lastKnownTargetMessageVersion: 4,
            lastAppliedVersion: 3,
            pendingVisibleRenderVersion: 4,
            reloadAttempted: true,
            runErrorCode: 'render_apply_failed',
            browserVisibilityState: 'hidden',
            browserOnline: false,
            logJobId: 'job-1',
            logEntryCount: 5,
            logUpdatedAt: '2026-05-11T12:00:00.000Z',
        });
    } finally {
        restoreGlobalProperty('document', previousDocument);
        restoreGlobalProperty('navigator', previousNavigator);
    }
});

test('sendFrontendLogEvent posts the frontend status snapshot with the breadcrumb', async () => {
    const previousFetch = globalThis.fetch;
    const requests = [];
    globalThis.fetch = async (url, options) => {
        requests.push({
            url,
            body: JSON.parse(options.body),
        });
        return {
            ok: true,
            text: async () => JSON.stringify({ ok: true }),
        };
    };

    try {
        const sent = await sendFrontendLogEvent({
            activeJobId: 'job-2',
            activeJobStatus: {
                jobId: 'job-2',
                runId: 'run-2',
                state: 'running',
                phase: 'awaiting_retry_results',
                revision: 11,
                acceptedCount: 2,
                targetAcceptedCount: 3,
                attemptCount: 4,
                maxAttempts: 12,
                targetMessageVersion: 6,
            },
            retryFsm: {
                getState() { return 'running'; },
                getContext() {
                    return {
                        jobId: 'job-2',
                        runId: 'run-2',
                        lastStatusRevision: 11,
                        lastKnownTargetMessageVersion: 6,
                        lastAppliedVersion: 6,
                        pendingVisibleRender: null,
                        reloadAttempted: false,
                    };
                },
            },
            log: {
                jobId: 'job-2',
                entryCount: 8,
                updatedAt: '2026-05-11T12:30:00.000Z',
            },
        }, {
            event: 'job_response_rejected',
            summary: 'Ignored stale backend response.',
            detail: {
                reason: 'run_id_mismatch',
                expectedRunId: 'run-2',
                responseRunId: 'run-old',
            },
        });

        assert.equal(sent, true);
        assert.equal(requests.length, 1);
        assert.equal(requests[0].url, '/api/plugins/retry-mobile/log-event/job-2');
        assert.equal(requests[0].body.event, 'job_response_rejected');
        assert.equal(requests[0].body.detail.reason, 'run_id_mismatch');
        assert.equal(requests[0].body.frontendStatus.fsmState, 'running');
        assert.equal(requests[0].body.frontendStatus.fsmLastStatusRevision, 11);
        assert.equal(requests[0].body.frontendStatus.runtimeMirrorRevision, 11);
        assert.equal(requests[0].body.frontendStatus.runtimeTargetMessageVersion, 6);
        assert.equal(Object.prototype.hasOwnProperty.call(requests[0].body.frontendStatus, 'capturedRequest'), false);
    } finally {
        globalThis.fetch = previousFetch;
    }
});

function restoreGlobalProperty(name, descriptor) {
    if (descriptor) {
        Object.defineProperty(globalThis, name, descriptor);
        return;
    }
    delete globalThis[name];
}
