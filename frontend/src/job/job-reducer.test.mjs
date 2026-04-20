import test from 'node:test';
import assert from 'node:assert/strict';

import {
    JOB_PHASE,
    RENDER_TASK,
    TRANSPORT_STATE,
    createInitialJobState,
    isTerminalStatus,
    reduceJobState,
} from './job-reducer.js';

function makeEnv() {
    return {
        runtime: {
            settings: {
                runMode: 'toggle',
                targetAcceptedCount: 2,
                maxAttempts: 5,
                attemptTimeoutSeconds: 30,
                validationMode: 'characters',
                minCharacters: 20,
                minTokens: 0,
                allowHeuristicTokenFallback: true,
                notifyOnSuccess: false,
                notifyOnComplete: false,
                vibrateOnSuccess: false,
                vibrateOnComplete: false,
                notificationMessageTemplate: '',
                nativeGraceSeconds: 15,
            },
        },
        createRunId() {
            return 'run-1';
        },
        createPollSessionId(runId) {
            return `${runId}-poll-1`;
        },
        getContext() {
            return {
                name1: 'You',
            };
        },
        getChatIdentity() {
            return {
                kind: 'character',
                chatId: 'chat-1',
                groupId: null,
                assistantName: 'Assistant',
            };
        },
    };
}

function armToReserving() {
    const env = makeEnv();
    const armed = reduceJobState(createInitialJobState(), {
        type: 'user.arm_requested',
        payload: {
            chatIdentity: {
                kind: 'character',
                chatId: 'chat-1',
                groupId: null,
            },
        },
    }, env).state;

    return {
        env,
        state: reduceJobState(armed, {
            type: 'capture.completed',
            payload: {
                capturedRequest: { prompt: 'hello' },
                fingerprint: { chatIdentity: armed.chatIdentity },
                requestType: 'normal',
            },
        }, env).state,
    };
}

test('isTerminalStatus only accepts completed, failed, or cancelled states', () => {
    assert.equal(isTerminalStatus({ state: 'completed' }), true);
    assert.equal(isTerminalStatus({ state: 'failed' }), true);
    assert.equal(isTerminalStatus({ state: 'cancelled' }), true);
    assert.equal(isTerminalStatus({ state: 'running' }), false);
    assert.equal(isTerminalStatus({ state: 'completed', error: 'x' }), true);
    assert.equal(isTerminalStatus(null), false);
});

test('idle arm request enters armed phase and emits capture start', () => {
    const result = reduceJobState(createInitialJobState(), {
        type: 'user.arm_requested',
        payload: {
            chatIdentity: {
                kind: 'character',
                chatId: 'chat-1',
                groupId: null,
            },
        },
    }, makeEnv());

    assert.equal(result.state.phase, JOB_PHASE.ARMED);
    assert.equal(result.state.runId, 'run-1');
    assert.deepEqual(result.commands, [{
        type: 'st.start_capture_session',
        payload: {
            runId: 'run-1',
            chatIdentity: {
                kind: 'character',
                chatId: 'chat-1',
                groupId: null,
            },
        },
    }]);
});

test('reserve success enters waiting_native and allocates poll session', () => {
    const { env, state } = armToReserving();
    const result = reduceJobState(state, {
        type: 'backend.reserve_succeeded',
        payload: {
            jobId: 'job-1',
            status: {
                jobId: 'job-1',
                state: 'running',
            },
        },
    }, env);

    assert.equal(result.state.phase, JOB_PHASE.WAITING_NATIVE);
    assert.equal(result.state.jobId, 'job-1');
    assert.equal(result.state.pollSessionId, 'run-1-poll-1');
    assert.equal(result.state.nativeDisposition, 'pending');
    assert.deepEqual(result.commands.map((entry) => entry.type), [
        'backend.start_poll',
        'native.await_readiness',
    ]);
});

test('stale poll responses are ignored when poll session does not match', () => {
    const { env, state } = armToReserving();
    const waiting = reduceJobState(state, {
        type: 'backend.reserve_succeeded',
        payload: {
            jobId: 'job-1',
            status: { jobId: 'job-1', state: 'running' },
        },
    }, env).state;

    const result = reduceJobState(waiting, {
        type: 'backend.status_received',
        payload: {
            runId: 'run-1',
            pollSessionId: 'stale-session',
            status: {
                state: 'running',
                targetMessageVersion: 1,
            },
        },
    }, env);

    assert.equal(result.ignored, true);
    assert.equal(result.state.phase, JOB_PHASE.WAITING_NATIVE);
});

test('backend running with a newer target version emits accepted-output render', () => {
    const { env, state } = armToReserving();
    const running = reduceJobState(reduceJobState(state, {
        type: 'backend.reserve_succeeded',
        payload: {
            jobId: 'job-1',
            status: { jobId: 'job-1', state: 'running' },
        },
    }, env).state, {
        type: 'backend.native_confirm_succeeded',
        payload: {
            status: {
                jobId: 'job-1',
                state: 'running',
            },
        },
    }, env).state;

    const result = reduceJobState(running, {
        type: 'backend.status_received',
        payload: {
            runId: 'run-1',
            pollSessionId: 'run-1-poll-1',
            status: {
                jobId: 'job-1',
                state: 'running',
                targetMessageIndex: 4,
                targetMessageVersion: 2,
                targetMessage: { mes: 'Accepted' },
            },
        },
    }, env);

    assert.equal(result.state.phase, JOB_PHASE.BACKEND_RUNNING);
    assert.equal(result.state.renderTask, RENDER_TASK.APPLYING_OUTPUT);
    assert.equal(result.commands.length, 1);
    assert.equal(result.commands[0].type, 'render.apply_accepted_output');
});

test('successful status polling clears reconnect transport state back to healthy', () => {
    const env = makeEnv();
    const state = {
        ...createInitialJobState(),
        phase: JOB_PHASE.BACKEND_RUNNING,
        runId: 'run-1',
        jobId: 'job-1',
        pollSessionId: 'run-1-poll-1',
        transport: TRANSPORT_STATE.TRANSIENT_ERROR,
    };

    const result = reduceJobState(state, {
        type: 'backend.status_received',
        payload: {
            runId: 'run-1',
            pollSessionId: 'run-1-poll-1',
            status: {
                jobId: 'job-1',
                state: 'running',
                targetMessageVersion: 0,
            },
        },
    }, env);

    assert.equal(result.state.transport, TRANSPORT_STATE.HEALTHY);
});

test('visibility recovery reattaches through backend truth instead of forcing a chat reload command', () => {
    const env = makeEnv();
    const state = {
        ...createInitialJobState(),
        phase: JOB_PHASE.BACKEND_RUNNING,
        runId: 'run-1',
        jobId: 'job-1',
        chatIdentity: {
            kind: 'character',
            chatId: 'chat-1',
            groupId: null,
        },
        transport: TRANSPORT_STATE.DEFERRED_DISCONNECT,
    };

    const result = reduceJobState(state, {
        type: 'page.visible',
        payload: {},
    }, env);

    assert.equal(result.state.phase, JOB_PHASE.RECOVERING);
    assert.equal(result.commands.length, 1);
    assert.equal(result.commands[0].type, 'recover.reconnect_status');
});

test('recovery with a newer backend target version reapplies output after reattachment', () => {
    const env = makeEnv();
    const state = {
        ...createInitialJobState(),
        phase: JOB_PHASE.RECOVERING,
        runId: 'run-1',
        jobId: 'job-1',
        chatIdentity: {
            kind: 'character',
            chatId: 'chat-1',
            groupId: null,
        },
        pollSessionId: 'old-poll',
        lastAppliedVersion: 1,
        transport: TRANSPORT_STATE.DEFERRED_DISCONNECT,
    };

    const result = reduceJobState(state, {
        type: 'recovery.completed',
        payload: {
            status: {
                jobId: 'job-1',
                state: 'running',
                targetMessageVersion: 3,
                nativeState: 'confirmed',
            },
        },
    }, env);

    assert.equal(result.state.phase, JOB_PHASE.BACKEND_RUNNING);
    assert.equal(result.state.renderTask, RENDER_TASK.APPLYING_OUTPUT);
    assert.deepEqual(result.commands.map((entry) => entry.type), [
        'backend.start_poll',
        'render.apply_accepted_output',
    ]);
});

test('stop during reserving preserves stop intent and cancels once reserve succeeds', () => {
    const { env, state } = armToReserving();
    const stopping = reduceJobState(state, {
        type: 'user.stop_requested',
        payload: {},
    }, env).state;

    assert.equal(stopping.phase, JOB_PHASE.STOPPING);
    assert.equal(stopping.pendingStop, true);

    const result = reduceJobState(stopping, {
        type: 'backend.reserve_succeeded',
        payload: {
            jobId: 'job-1',
            status: {
                jobId: 'job-1',
                state: 'running',
            },
        },
    }, env);

    assert.equal(result.state.phase, JOB_PHASE.STOPPING);
    assert.equal(result.state.jobId, 'job-1');
    assert.equal(result.state.pollSessionId, 'run-1-poll-1');
    assert.deepEqual(result.commands.map((entry) => entry.type), [
        'backend.start_poll',
        'backend.cancel_job',
    ]);
});

test('completing to completed clears live run fields on terminal finish', () => {
    const env = makeEnv();
    const state = {
        ...createInitialJobState(),
        phase: JOB_PHASE.COMPLETING,
        runId: 'run-1',
        jobId: 'job-1',
        pollSessionId: 'poll-1',
        capturedRequest: { prompt: 'x' },
        captureFingerprint: { a: 1 },
        assistantMessageIndex: 7,
        renderTask: RENDER_TASK.FINISHING_UI,
        pendingStop: true,
    };

    const result = reduceJobState(state, {
        type: 'render.terminal_ui_finished',
        payload: {
            outcome: 'completed',
        },
    }, env);

    assert.equal(result.state.phase, JOB_PHASE.COMPLETED);
    assert.equal(result.state.runId, null);
    assert.equal(result.state.jobId, null);
    assert.equal(result.state.pollSessionId, null);
    assert.equal(result.state.capturedRequest, null);
    assert.equal(result.state.captureFingerprint, null);
    assert.equal(result.state.assistantMessageIndex, null);
    assert.equal(result.state.pendingStop, false);
});
