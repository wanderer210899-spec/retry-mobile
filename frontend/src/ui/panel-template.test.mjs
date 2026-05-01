import test from 'node:test';
import assert from 'node:assert/strict';

import { buildPanelTemplate } from './panel-template.js';

test('buildPanelTemplate keeps idle state pill contract and avoids leaking run-state symbols', () => {
    const template = buildPanelTemplate();

    assert.match(template, /data-role="state-pill"[^>]*data-state="idle"/);
    assert.doesNotMatch(template, /RUN_STATE/);
});

test('buildPanelTemplate uses collapsible blocks for configuration and notifications (default closed)', () => {
    const template = buildPanelTemplate();

    const detailsTags = template.match(/<details class="rm-fieldset rm-collapsible">/g) || [];
    assert.equal(detailsTags.length, 2, 'expected configuration + notifications collapsibles');
    assert.doesNotMatch(template, /<details class="rm-fieldset rm-collapsible" open>/);
    assert.match(template, /rm-collapsible__summary/);
});

test('buildPanelTemplate places UI language control in the system pane only', () => {
    const template = buildPanelTemplate();

    const systemIdx = template.indexOf('data-role="system-pane"');
    const mainIdx = template.indexOf('data-role="main-pane"');
    const langIdx = template.indexOf('id="retry-mobile-ui-language"');

    assert.ok(systemIdx > 0 && mainIdx > 0 && langIdx > 0);
    assert.ok(langIdx > systemIdx, 'language select should appear after system pane start');

    const mainSlice = template.slice(mainIdx, systemIdx);
    assert.doesNotMatch(mainSlice, /retry-mobile-ui-language/, 'language select must not be in main pane');

    const idMatches = template.match(/id="retry-mobile-ui-language"/g) || [];
    assert.equal(idMatches.length, 1);
});
