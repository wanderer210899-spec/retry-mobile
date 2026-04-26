import test from 'node:test';
import assert from 'node:assert/strict';

import { shouldToastPluginOff, shouldToastPluginOn } from './plugin-toggle-toast.js';

test('shouldToastPluginOn fires only when newly armed', () => {
    assert.equal(shouldToastPluginOn('idle', 'armed'), true);
    assert.equal(shouldToastPluginOn('armed', 'armed'), false);
    assert.equal(shouldToastPluginOn('running', 'armed'), true);
    assert.equal(shouldToastPluginOn('idle', 'running'), false);
});

test('shouldToastPluginOff fires only when leaving running-like state to idle', () => {
    assert.equal(shouldToastPluginOff('armed', 'idle'), true);
    assert.equal(shouldToastPluginOff('running', 'idle'), true);
    assert.equal(shouldToastPluginOff('capturing', 'idle'), true);
    assert.equal(shouldToastPluginOff('idle', 'idle'), false);
    assert.equal(shouldToastPluginOff('armed', 'armed'), false);
});

