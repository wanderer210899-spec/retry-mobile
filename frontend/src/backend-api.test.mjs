import test from 'node:test';
import assert from 'node:assert/strict';

import { fetchJobStatus, startBackendJob } from './backend-api.js';

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
    assert.equal('cache' in seen[0], false);
});

test('startBackendJob falls back to JSON headers when SillyTavern headers are unavailable', async (t) => {
    const originalFetch = global.fetch;
    const originalGetRequestHeaders = global.getRequestHeaders;
    const originalWindow = global.window;

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
        global.window = originalWindow;
    });

    const result = await startBackendJob({ hello: 'fallback' });

    assert.equal(result.jobId, 'job-2');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].headers['Content-Type'], 'application/json');
    assert.equal('X-CSRF-Token' in seen[0].headers, false);
});

test('startBackendJob uses SillyTavern context request headers when the global helper is unavailable', async (t) => {
    const originalFetch = global.fetch;
    const originalGetRequestHeaders = global.getRequestHeaders;
    const originalWindow = global.window;

    const seen = [];
    global.getRequestHeaders = undefined;
    global.window = {
        SillyTavern: {
            getContext() {
                return {
                    getRequestHeaders() {
                        return {
                            'Content-Type': 'application/json',
                            'X-CSRF-Token': 'csrf-from-context',
                        };
                    },
                };
            },
        },
    };
    global.fetch = async (_url, options = {}) => {
        seen.push(options);
        return new Response(JSON.stringify({ jobId: 'job-ctx' }), {
            status: 200,
            headers: {
                'Content-Type': 'application/json',
            },
        });
    };

    t.after(() => {
        global.fetch = originalFetch;
        global.getRequestHeaders = originalGetRequestHeaders;
        global.window = originalWindow;
    });

    const result = await startBackendJob({ hello: 'context' });

    assert.equal(result.jobId, 'job-ctx');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].headers['X-CSRF-Token'], 'csrf-from-context');
});

test('startBackendJob retries another helper when the first request-header helper throws', async (t) => {
    const originalFetch = global.fetch;
    const originalGetRequestHeaders = global.getRequestHeaders;
    const originalWindow = global.window;

    const seen = [];
    global.getRequestHeaders = () => {
        throw new Error('token unavailable');
    };
    global.window = {
        SillyTavern: {
            getContext() {
                return {
                    getRequestHeaders() {
                        return {
                            'Content-Type': 'application/json',
                            'X-CSRF-Token': 'csrf-after-fallback',
                        };
                    },
                };
            },
        },
    };
    global.fetch = async (_url, options = {}) => {
        seen.push(options);
        return new Response(JSON.stringify({ jobId: 'job-fallback' }), {
            status: 200,
            headers: {
                'Content-Type': 'application/json',
            },
        });
    };

    t.after(() => {
        global.fetch = originalFetch;
        global.getRequestHeaders = originalGetRequestHeaders;
        global.window = originalWindow;
    });

    const result = await startBackendJob({ hello: 'retry-headers' });

    assert.equal(result.jobId, 'job-fallback');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].headers['X-CSRF-Token'], 'csrf-after-fallback');
});

test('startBackendJob includes request-header diagnostics on 403 failures', async (t) => {
    const originalFetch = global.fetch;
    const originalGetRequestHeaders = global.getRequestHeaders;
    const originalConsoleWarn = console.warn;

    global.getRequestHeaders = undefined;
    global.fetch = async () => new Response(JSON.stringify({
        error: 'Forbidden',
    }), {
        status: 403,
        headers: {
            'Content-Type': 'application/json',
        },
    });
    console.warn = () => {};

    t.after(() => {
        global.fetch = originalFetch;
        global.getRequestHeaders = originalGetRequestHeaders;
        console.warn = originalConsoleWarn;
    });

    await assert.rejects(
        () => startBackendJob({ hello: 'forbidden' }),
        (error) => {
            assert.equal(error.status, 403);
            assert.match(error.detail, /request=POST \/api\/plugins\/retry-mobile\/start/u);
            assert.match(error.detail, /header_source=fallback_json/u);
            assert.match(error.detail, /csrf=missing/u);
            return true;
        },
    );
});

test('fetchJobStatus disables browser caching for polling requests', async (t) => {
    const originalFetch = global.fetch;
    const originalGetRequestHeaders = global.getRequestHeaders;

    const seen = [];
    global.getRequestHeaders = () => ({
        'Content-Type': 'application/json',
        'X-CSRF-Token': 'csrf-123',
    });
    global.fetch = async (_url, options = {}) => {
        seen.push(options);
        return new Response(JSON.stringify({
            jobId: 'job-status',
            state: 'running',
        }), {
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

    const result = await fetchJobStatus('job-status');

    assert.equal(result.jobId, 'job-status');
    assert.equal(result.state, 'running');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].method, 'GET');
    assert.equal(seen[0].cache, 'no-store');
    assert.equal(seen[0].headers['X-CSRF-Token'], 'csrf-123');
});
