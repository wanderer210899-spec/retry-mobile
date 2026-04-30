import test from 'node:test';
import assert from 'node:assert/strict';

import { adoptTargetMessageForVisibleHost, assistantTargetMatches, buildPatchedAssistantMessage } from './st-operations.js';

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

test('buildPatchedAssistantMessage preserves the currently selected live swipe when backend appends new swipes', () => {
    const patched = buildPatchedAssistantMessage({
        mes: 'Current swipe',
        swipe_id: 1,
        swipes: ['Older swipe', 'Current swipe'],
        swipe_info: [
            {
                send_date: '2026-04-30T09:00:00.000Z',
                gen_started: '2026-04-30T09:00:00.000Z',
                gen_finished: '2026-04-30T09:00:00.000Z',
                extra: { slot: 'older' },
            },
            {
                send_date: '2026-04-30T09:01:00.000Z',
                gen_started: '2026-04-30T09:01:00.000Z',
                gen_finished: '2026-04-30T09:01:00.000Z',
                extra: { slot: 'current' },
            },
        ],
        extra: { slot: 'current' },
        send_date: '2026-04-30T09:01:00.000Z',
        gen_started: '2026-04-30T09:01:00.000Z',
        gen_finished: '2026-04-30T09:01:00.000Z',
    }, {
        mes: 'Newest retry swipe',
        swipe_id: 2,
        swipes: ['Older swipe', 'Current swipe', 'Newest retry swipe'],
        swipe_info: [
            {
                send_date: '2026-04-30T09:00:00.000Z',
                gen_started: '2026-04-30T09:00:00.000Z',
                gen_finished: '2026-04-30T09:00:00.000Z',
                extra: { slot: 'older', retryMobileAssistantAnchorId: 'new-anchor' },
            },
            {
                send_date: '2026-04-30T09:01:00.000Z',
                gen_started: '2026-04-30T09:01:00.000Z',
                gen_finished: '2026-04-30T09:01:00.000Z',
                extra: { slot: 'current', retryMobileAssistantAnchorId: 'new-anchor' },
            },
            {
                send_date: '2026-04-30T09:02:00.000Z',
                gen_started: '2026-04-30T09:02:00.000Z',
                gen_finished: '2026-04-30T09:02:00.000Z',
                extra: { slot: 'newest', retryMobileAssistantAnchorId: 'new-anchor' },
            },
        ],
        extra: { slot: 'newest', retryMobileAssistantAnchorId: 'new-anchor' },
        send_date: '2026-04-30T09:02:00.000Z',
        gen_started: '2026-04-30T09:02:00.000Z',
        gen_finished: '2026-04-30T09:02:00.000Z',
    });

    assert.equal(patched.swipe_id, 1);
    assert.equal(patched.mes, 'Current swipe');
    assert.deepEqual(patched.extra, {
        slot: 'current',
        retryMobileAssistantAnchorId: 'new-anchor',
    });
    assert.equal(patched.send_date, '2026-04-30T09:01:00.000Z');
});

test('buildPatchedAssistantMessage falls back to backend-selected swipe when the live selected swipe no longer matches', () => {
    const patched = buildPatchedAssistantMessage({
        mes: 'Different live swipe',
        swipe_id: 1,
        swipes: ['Older swipe', 'Different live swipe'],
        swipe_info: [],
        extra: { slot: 'different' },
    }, {
        mes: 'Newest retry swipe',
        swipe_id: 2,
        swipes: ['Older swipe', 'Current swipe', 'Newest retry swipe'],
        swipe_info: [
            { extra: { slot: 'older', retryMobileAssistantAnchorId: 'new-anchor' } },
            { extra: { slot: 'current', retryMobileAssistantAnchorId: 'new-anchor' } },
            { extra: { slot: 'newest', retryMobileAssistantAnchorId: 'new-anchor' } },
        ],
        extra: { slot: 'newest', retryMobileAssistantAnchorId: 'new-anchor' },
    });

    assert.equal(patched.swipe_id, 2);
    assert.equal(patched.mes, 'Newest retry swipe');
});

test('adoptTargetMessageForVisibleHost keeps the native visible swipe selected when backend appends retry swipes under a new anchor', () => {
    const adopted = adoptTargetMessageForVisibleHost({
        mes: 'Native reply visible text',
        swipe_id: 0,
        swipes: ['Native reply visible text'],
        swipe_info: [
            {
                send_date: '2026-04-30T10:00:00.000Z',
                gen_started: '2026-04-30T10:00:00.000Z',
                gen_finished: '2026-04-30T10:00:00.000Z',
                extra: {},
            },
        ],
        extra: {},
        send_date: '2026-04-30T10:00:00.000Z',
        gen_started: '2026-04-30T10:00:00.000Z',
        gen_finished: '2026-04-30T10:00:00.000Z',
    }, {
        mes: 'Retry 1 visible text',
        swipe_id: 0,
        swipes: ['Retry 1 visible text', 'Retry 2 visible text', 'Retry 3 visible text'],
        swipe_info: [
            {
                send_date: '2026-04-30T10:01:00.000Z',
                gen_started: '2026-04-30T10:01:00.000Z',
                gen_finished: '2026-04-30T10:01:00.000Z',
                extra: { retryMobileAssistantAnchorId: 'new-anchor', slot: 'retry-1' },
            },
            {
                send_date: '2026-04-30T10:02:00.000Z',
                gen_started: '2026-04-30T10:02:00.000Z',
                gen_finished: '2026-04-30T10:02:00.000Z',
                extra: { retryMobileAssistantAnchorId: 'new-anchor', slot: 'retry-2' },
            },
            {
                send_date: '2026-04-30T10:03:00.000Z',
                gen_started: '2026-04-30T10:03:00.000Z',
                gen_finished: '2026-04-30T10:03:00.000Z',
                extra: { retryMobileAssistantAnchorId: 'new-anchor', slot: 'retry-3' },
            },
        ],
        extra: { retryMobileAssistantAnchorId: 'new-anchor', slot: 'retry-3' },
    }, 'new-anchor');

    assert.equal(adopted.swipe_id, 0);
    assert.equal(adopted.mes, 'Retry 1 visible text');
    assert.equal(adopted.swipes.length, 3);
    assert.equal(adopted.extra.retryMobileAssistantAnchorId, 'new-anchor');
});
