import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const retryFsmSource = readFileSync(new URL('./retry-fsm.js', import.meta.url), 'utf8');

test('retry-fsm stays isolated from concrete adapters and the legacy job control path', () => {
    const forbiddenImports = [
        "./intent.js",
        "./st-adapter.js",
        "./backend-client.js",
        "./job/job-machine.js",
        "./job/job-reducer.js",
        "./job/job-effects.js",
    ];

    for (const specifier of forbiddenImports) {
        assert.doesNotMatch(
            retryFsmSource,
            new RegExp(`from ['"]${escapeForRegExp(specifier)}['"]`),
            `retry-fsm.js must not import ${specifier}`,
        );
    }
});

test('retry-fsm is created through injected ports instead of concrete module imports', () => {
    assert.match(
        retryFsmSource,
        /createRetryFsm\(\s*\{\s*[\s\S]*intentPort\s*=/,
    );
    assert.match(
        retryFsmSource,
        /createRetryFsm\(\s*\{\s*[\s\S]*stPort\s*=/,
    );
    assert.match(
        retryFsmSource,
        /createRetryFsm\(\s*\{\s*[\s\S]*backendPort\s*=/,
    );
});

function escapeForRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
