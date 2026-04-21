import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const backendClientSource = readFileSync(new URL('./backend-client.js', import.meta.url), 'utf8');
const stAdapterSource = readFileSync(new URL('./st-adapter.js', import.meta.url), 'utf8');
const intentSource = readFileSync(new URL('./intent.js', import.meta.url), 'utf8');

test('backend and ST adapters do not import each other directly', () => {
    assert.doesNotMatch(
        backendClientSource,
        /from ['"]\.\/st-adapter\.js['"]/,
    );
    assert.doesNotMatch(
        stAdapterSource,
        /from ['"]\.\/backend-client\.js['"]/,
    );
});

test('intent storage stays decoupled from concrete backend and ST adapters', () => {
    assert.doesNotMatch(
        intentSource,
        /from ['"]\.\/backend-client\.js['"]/,
    );
    assert.doesNotMatch(
        intentSource,
        /from ['"]\.\/st-adapter\.js['"]/,
    );
});
