import test from 'node:test';
import assert from 'node:assert/strict';

import { createIntentPort } from './intent.js';
import { SETTINGS_KEY } from './constants.js';

function makeContext(source = {}) {
    return {
        extensionSettings: {
            [SETTINGS_KEY]: {
                ...source,
            },
        },
        saveCalls: 0,
        saveSettingsDebounced() {
            this.saveCalls += 1;
        },
    };
}

test('writeSettings preserves intent metadata stored beside normalized settings', () => {
    const context = makeContext({
        runMode: 'single',
        targetAcceptedCount: 3,
        engaged: true,
        singleTarget: {
            assistantAnchorId: 'anchor-1',
        },
    });
    const port = createIntentPort({
        getContext() {
            return context;
        },
    });

    port.writeSettings({
        targetAcceptedCount: 5,
    });

    assert.equal(context.extensionSettings[SETTINGS_KEY].targetAcceptedCount, 5);
    assert.equal(context.extensionSettings[SETTINGS_KEY].engaged, true);
    assert.deepEqual(context.extensionSettings[SETTINGS_KEY].singleTarget, {
        assistantAnchorId: 'anchor-1',
    });
});

test('writeIntent updates durable run mode and target without dropping settings', () => {
    const context = makeContext({
        runMode: 'single',
        targetAcceptedCount: 3,
        maxAttempts: 5,
    });
    const port = createIntentPort({
        getContext() {
            return context;
        },
    });

    port.writeIntent({
        mode: 'toggle',
        engaged: true,
        singleTarget: {
            assistantAnchorId: 'anchor-2',
        },
        settings: {
            targetAcceptedCount: 7,
        },
    });

    assert.deepEqual(port.readIntent(), {
        mode: 'toggle',
        engaged: true,
        singleTarget: {
            assistantAnchorId: 'anchor-2',
        },
        settings: {
            ...port.readSettings(),
        },
    });
    assert.equal(context.extensionSettings[SETTINGS_KEY].maxAttempts, 5);
});
