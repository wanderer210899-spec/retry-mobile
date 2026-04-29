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

test('assistantTargetMatches adopts the same live turn when a new job restamps an older retry anchor', () => {
    assert.equal(assistantTargetMatches({
        mes: 'Swipe 2',
        extra: {
            retryMobileAssistantAnchorId: 'old-anchor',
        },
        swipes: ['Native reply', 'Swipe 2'],
        swipe_info: [
            { extra: { retryMobileAssistantAnchorId: 'old-anchor' } },
            { extra: { retryMobileAssistantAnchorId: 'old-anchor' } },
        ],
    }, {
        mes: 'Swipe 2',
        swipes: ['Native reply', 'Swipe 2', 'Accepted retry swipe'],
        swipe_info: [
            { extra: { retryMobileAssistantAnchorId: 'new-anchor' } },
            { extra: { retryMobileAssistantAnchorId: 'new-anchor' } },
            { extra: { retryMobileAssistantAnchorId: 'new-anchor' } },
        ],
    }, 'new-anchor'), true);
});

test('assistantTargetMatches compares display-equivalent persisted raw swipes when adopting an older retry anchor', () => {
    assert.equal(assistantTargetMatches({
        mes: 'Native visible reply',
        extra: {
            retryMobileAssistantAnchorId: 'old-anchor',
        },
        swipes: ['Native visible reply', 'Second visible reply'],
        swipe_info: [
            { extra: { retryMobileAssistantAnchorId: 'old-anchor' } },
            { extra: { retryMobileAssistantAnchorId: 'old-anchor' } },
        ],
    }, {
        mes: '<thinking>hidden</thinking>\n<content>Second visible reply</content>\n<report>summary</report>',
        swipes: [
            '<thinking>hidden</thinking>\n<content>Native visible reply</content>\n<report>summary</report>',
            '<thinking>hidden</thinking>\n<content>Second visible reply</content>\n<report>summary</report>',
            'Accepted retry swipe',
        ],
        swipe_info: [
            { extra: { retryMobileAssistantAnchorId: 'new-anchor' } },
            { extra: { retryMobileAssistantAnchorId: 'new-anchor' } },
            { extra: { retryMobileAssistantAnchorId: 'new-anchor' } },
        ],
    }, 'new-anchor'), true);
});

test('assistantTargetMatches rejects a mismatched old anchor when the live swipes are not the backend target prefix', () => {
    assert.equal(assistantTargetMatches({
        mes: 'Different assistant row',
        extra: {
            retryMobileAssistantAnchorId: 'old-anchor',
        },
        swipes: ['Different assistant row'],
        swipe_info: [
            { extra: { retryMobileAssistantAnchorId: 'old-anchor' } },
        ],
    }, {
        mes: 'Native reply',
        swipes: ['Native reply', 'Accepted retry swipe'],
        swipe_info: [
            { extra: { retryMobileAssistantAnchorId: 'new-anchor' } },
            { extra: { retryMobileAssistantAnchorId: 'new-anchor' } },
        ],
    }, 'new-anchor'), false);
});
