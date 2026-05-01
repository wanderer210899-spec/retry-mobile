import test from 'node:test';
import assert from 'node:assert/strict';

import { createBackendPort } from './backend-client.js';
import {
    POLL_INTERVAL_FAST_MS,
    POLL_INTERVAL_SLOW_MS,
    POLL_INTERVAL_STEADY_MS,
} from './constants.js';

test('startPolling uses callback arguments and stops after a terminal status', async (t) => {
    const originalWindow = global.window;
    const originalFetch = global.fetch;

    const responses = [
        { state: 'running' },
        { state: 'completed' },
    ];

    global.window = {
        setTimeout(callback) {
            queueMicrotask(callback);
            return 1;
        },
        clearTimeout() {},
    };
    global.fetch = async () => new Response(JSON.stringify(responses.shift() || { state: 'completed' }), {
        status: 200,
        headers: {
            'Content-Type': 'application/json',
        },
    });

    t.after(() => {
        global.window = originalWindow;
        global.fetch = originalFetch;
    });

    const backendPort = createBackendPort();
    const seenStates = [];

    await new Promise((resolve, reject) => {
        const token = backendPort.startPolling(
            'job-1',
            async (status) => {
                seenStates.push(status.state);
                if (status.state === 'completed') {
                    resolve();
                }
            },
            async (error) => {
                reject(error);
            },
        );

        assert.equal(typeof token, 'string');
    });

    assert.deepEqual(seenStates, ['running', 'completed']);
});

test('startPolling re-evaluates the cadence selector on each loop', async (t) => {
    const originalWindow = global.window;
    const originalFetch = global.fetch;

    const responses = [
        { state: 'running' },
        { state: 'running' },
        { state: 'completed' },
    ];
    const timerDelays = [];
    const cadenceSequence = ['fast', 'steady', 'slow'];

    global.window = {
        setTimeout(callback, delay) {
            timerDelays.push(delay);
            queueMicrotask(callback);
            return timerDelays.length;
        },
        clearTimeout() {},
    };
    global.fetch = async () => new Response(JSON.stringify(responses.shift() || { state: 'completed' }), {
        status: 200,
        headers: {
            'Content-Type': 'application/json',
        },
    });

    t.after(() => {
        global.window = originalWindow;
        global.fetch = originalFetch;
    });

    const backendPort = createBackendPort();

    await new Promise((resolve, reject) => {
        backendPort.startPolling(
            'job-1',
            async (status) => {
                if (status.state === 'completed') {
                    resolve();
                }
            },
            async (error) => {
                reject(error);
            },
            () => cadenceSequence.shift() || 'slow',
        );
    });

    assert.deepEqual(timerDelays, [
        POLL_INTERVAL_FAST_MS,
        POLL_INTERVAL_STEADY_MS,
        POLL_INTERVAL_SLOW_MS,
    ]);
});
