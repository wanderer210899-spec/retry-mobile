import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const backendClientSource = readFileSync(new URL('./backend-client.js', import.meta.url), 'utf8');
const stBridgeIndexSource = readFileSync(new URL('./st-bridge/index.js', import.meta.url), 'utf8');
const intentSource = readFileSync(new URL('./intent.js', import.meta.url), 'utf8');

test('backend client and st-bridge factory do not import each other directly', () => {
    assert.doesNotMatch(
        backendClientSource,
        /from ['"](\.\.?\/)+st-bridge(\/index\.js)?['"]/,
        'backend-client.js must not import the ST bridge',
    );
    assert.doesNotMatch(
        stBridgeIndexSource,
        /from ['"](\.\.?\/)+backend-client\.js['"]/,
        'st-bridge/index.js must not import the backend client',
    );
});

test('intent storage stays decoupled from concrete backend and st-bridge factories', () => {
    assert.doesNotMatch(
        intentSource,
        /from ['"](\.\.?\/)+backend-client\.js['"]/,
        'intent.js must not import backend-client.js',
    );
    assert.doesNotMatch(
        intentSource,
        /from ['"](\.\.?\/)+st-bridge(\/index\.js)?['"]/,
        'intent.js must not import the ST bridge',
    );
});
