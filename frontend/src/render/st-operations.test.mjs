import test from 'node:test';
import assert from 'node:assert/strict';

import { assistantTargetMatches } from './st-operations.js';

test('assistantTargetMatches accepts a live turn that already carries the expected anchor', () => {
    assert.equal(assistantTargetMatches({
        mes: 'Native reply',
        extra: {
            retryMobileAssistantAnchorId: 'anchor-1',
        },
    }, {
        mes: 'Native reply',
    }, 'anchor-1'), true);
});

test('assistantTargetMatches accepts an unanchored native seed whose visible text still matches backend truth', () => {
    assert.equal(assistantTargetMatches({
        mes: 'Native reply',
        extra: {},
        swipes: ['Native reply'],
        swipe_info: [],
    }, {
        mes: 'Native reply',
        swipes: ['Native reply', 'Accepted retry swipe'],
        swipe_info: [
            {
                extra: {
                    retryMobileAssistantAnchorId: 'anchor-1',
                },
            },
        ],
    }, 'anchor-1'), true);
});

test('assistantTargetMatches accepts an empty placeholder before the first backend write stamps anchors', () => {
    assert.equal(assistantTargetMatches({
        mes: '',
        extra: {},
        swipes: [],
        swipe_info: [],
    }, {
        mes: 'Accepted retry swipe',
        swipes: ['Accepted retry swipe'],
        swipe_info: [
            {
                extra: {
                    retryMobileAssistantAnchorId: 'anchor-1',
                },
            },
        ],
    }, 'anchor-1'), true);
});

test('assistantTargetMatches still rejects an unanchored assistant turn with mismatched text', () => {
    assert.equal(assistantTargetMatches({
        mes: 'Different assistant row',
        extra: {},
        swipes: ['Different assistant row'],
        swipe_info: [],
    }, {
        mes: 'Native reply',
        swipes: ['Native reply', 'Accepted retry swipe'],
        swipe_info: [
            {
                extra: {
                    retryMobileAssistantAnchorId: 'anchor-1',
                },
            },
        ],
    }, 'anchor-1'), false);
});
