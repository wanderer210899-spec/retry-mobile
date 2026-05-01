import test from 'node:test';
import assert from 'node:assert/strict';

import { createStructuredError } from './retry-error.js';

test('CURRENTLY FAILING (pre-fix): frontend cannot coin backend_write_failed in dev mode', () => {
    const previousDev = globalThis.__RM_DEV__;
    globalThis.__RM_DEV__ = true;
    try {
        assert.throws(() => {
            createStructuredError('backend_write_failed', 'should fail');
        }, /reserved for backend errors/);
    } finally {
        globalThis.__RM_DEV__ = previousDev;
    }
});

test('CURRENTLY PASSING (pre-fix): client-prefixed structured errors remain valid', () => {
    const result = createStructuredError('client_patch_failed', 'patch failed', 'detail');
    assert.equal(result.code, 'client_patch_failed');
    assert.equal(result.message, 'patch failed');
    assert.equal(result.detail, 'detail');
});

test('allowlisted non-client code stays valid in dev mode', () => {
    const previousDev = globalThis.__RM_DEV__;
    globalThis.__RM_DEV__ = true;
    try {
        const result = createStructuredError('render_apply_failed', 'visible apply failed');
        assert.equal(result.code, 'render_apply_failed');
    } finally {
        globalThis.__RM_DEV__ = previousDev;
    }
});

test('unknown unprefixed code throws in dev mode', () => {
    const previousDev = globalThis.__RM_DEV__;
    globalThis.__RM_DEV__ = true;
    try {
        assert.throws(() => {
            createStructuredError('mystery_code', 'bad');
        }, /must use client_\*/);
    } finally {
        globalThis.__RM_DEV__ = previousDev;
    }
});

test('unknown unprefixed code does not throw in non-dev mode', () => {
    const previousDev = globalThis.__RM_DEV__;
    delete globalThis.__RM_DEV__;
    try {
        const result = createStructuredError('mystery_code', 'allowed in prod');
        assert.equal(result.code, 'mystery_code');
    } finally {
        globalThis.__RM_DEV__ = previousDev;
    }
});
