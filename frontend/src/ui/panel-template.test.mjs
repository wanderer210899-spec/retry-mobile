import test from 'node:test';
import assert from 'node:assert/strict';

import { buildPanelTemplate } from './panel-template.js';

test('buildPanelTemplate hardcodes the idle state pill for the live FSM state contract', () => {
    const template = buildPanelTemplate();

    assert.match(template, /data-role="state-pill" data-state="idle">Idle<\/div>/);
    assert.doesNotMatch(template, /RUN_STATE/);
});
