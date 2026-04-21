import test from 'node:test';
import assert from 'node:assert/strict';

import { startBackendJob } from './backend-api.js';

test('startBackendJob uses SillyTavern request headers when available', async (t) => {
    const originalFetch = global.fetch;
    const originalGetRequestHeaders = global.getRequestHeaders;

    const seen = [];
    global.getRequestHeaders = () => ({
        'Content-Type': 'application/json',
        'X-CSRF-Token': 'csrf-123',
    });
    global.fetch = async (_url, options = {}) => {
        seen.push(options);
        return new Response(JSON.stringify({ jobId: 'job-1' }), {
            status: 200,
            headers: {
                'Content-Type': 'application/json',
            },
        });
    };

    t.after(() => {
        global.fetch = originalFetch;
        global.getRequestHeaders = originalGetRequestHeaders;
    });

    const result = await startBackendJob({ hello: 'world' });

    assert.equal(result.jobId, 'job-1');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].headers['X-CSRF-Token'], 'csrf-123');
    assert.equal(seen[0].headers['Content-Type'], 'application/json');
});

test('startBackendJob falls back to JSON headers when SillyTavern headers are unavailable', async (t) => {
    const originalFetch = global.fetch;
    const originalGetRequestHeaders = global.getRequestHeaders;

    const seen = [];
    global.getRequestHeaders = undefined;
    global.fetch = async (_url, options = {}) => {
        seen.push(options);
        return new Response(JSON.stringify({ jobId: 'job-2' }), {
            status: 200,
            headers: {
                'Content-Type': 'application/json',
            },
        });
    };

    t.after(() => {
        global.fetch = originalFetch;
        global.getRequestHeaders = originalGetRequestHeaders;
    });

    const result = await startBackendJob({ hello: 'fallback' });

    assert.equal(result.jobId, 'job-2');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].headers['Content-Type'], 'application/json');
    assert.equal('X-CSRF-Token' in seen[0].headers, false);
});
