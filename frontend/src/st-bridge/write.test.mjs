import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { applyAcceptedOutput, assistantTargetMatches } from './write.js';

const WRITE_SOURCE_PATH = fileURLToPath(new URL('./write.js', import.meta.url));
const WRITE_SOURCE = readFileSync(WRITE_SOURCE_PATH, 'utf8');

// ---------------------------------------------------------------------------
// Source-shape assertions: the legacy saveReply/full-message mutation path must
// be gone; writes go through direct push + saveChat() plus swipe-control refresh.
// ---------------------------------------------------------------------------

test('write.js does not splice the live chat array directly (chat[i] = patched is gone)', () => {
    // Strip line + block comments first so the historical "// liveChat[i] = ..."
    // header note doesn't trip the assertion. Then look for any executable
    // `<...>chat[<expr>] = <expr>` assignment — the legacy mutation pattern.
    const sourceWithoutComments = WRITE_SOURCE
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
    const directChatSplice = /\b\w*[cC]hat\s*\[\s*[^\]]+\s*\]\s*=\s*/m;
    assert.equal(
        directChatSplice.test(sourceWithoutComments),
        false,
        'Phase 3 forbids direct chat[i] = patched mutation; direct push + saveChat() must own swipe writes.',
    );
});

test('write.js does not call updateMessageBlock in the apply path', () => {
    assert.equal(
        /\bupdateMessageBlock\s*\?\.\s*\(/.test(WRITE_SOURCE),
        false,
        'updateMessageBlock must not appear (Phase 3: direct push; no DOM re-render).',
    );
});

test('write.js drops the manual scroll-restore hack (addOneMessage handles scroll)', () => {
    assert.equal(
        /scrollTop\s*=\s*prevScrollTop/.test(WRITE_SOURCE),
        false,
        'Phase 2 drops the scroll-preservation hack; addOneMessage(type:swipe) handles scroll.',
    );
});

test('write.js appends swipes directly and persists via context.saveChat (no saveReply)', () => {
    assert.doesNotMatch(
        WRITE_SOURCE,
        /context\.saveReply/,
        'Phase 3: applyAcceptedOutput must not call saveReply (foreground API causes DOM mutation + scroll).',
    );
    assert.match(
        WRITE_SOURCE,
        /context\.saveChat\?\.\(\)/,
        'applyAcceptedOutput must persist via saveChat() for a silent background append.',
    );
    assert.match(
        WRITE_SOURCE,
        /lastMessage\.swipes\.push/,
        'applyAcceptedOutput must push swipe text directly into the live array.',
    );
    assert.match(
        WRITE_SOURCE,
        /\bswipe\s*\?\.\s*refresh\s*\?\.\s*\(\s*true\s*\)/,
        'applyAcceptedOutput must refresh ST swipe controls after appending so the live counter/navigation updates.',
    );
});

// ---------------------------------------------------------------------------
// Runtime tests: stand up a fake SillyTavern context (window.SillyTavern) and
// drive applyAcceptedOutput end-to-end. The boundary test forbids ST event
// literals/selectors outside the bridge, but write.test.mjs is inside the
// bridge directory so it may freely poke at the same surface write.js owns.
// ---------------------------------------------------------------------------

const ANCHOR_ID = 'anchor-phase2';
// Match the shape returned by st-bridge/internal/ctx.js:getChatIdentity so
// isSameChat passes (it compares kind, chatId, and groupId).
const CHAT_IDENTITY = { kind: 'character', chatId: 'chat-1', groupId: null };

function buildMessageElementHost(targetIndex) {
    const text = { textContent: '' };
    const wrapper = {
        querySelector(selector) {
            if (selector === '.mes_text') return text;
            return null;
        },
    };
    return {
        wrapper,
        text,
        querySelector(selector) {
            if (selector === `.mes[mesid="${targetIndex}"]`) {
                return wrapper;
            }
            if (selector === '#chat') {
                return null;
            }
            if (selector === '.mes.last_mes') {
                return wrapper;
            }
            return null;
        },
        getElementById(id) {
            if (id === 'chat') return null;
            return null;
        },
        body: { dataset: {} },
    };
}

function installFakeStEnvironment({ chat, contextOverrides = {}, identity = CHAT_IDENTITY }) {
    const saveChatCalls = [];
    const updateMessageBlockCalls = [];
    const swipeRefreshCalls = [];

    const context = {
        chatId: identity.chatId,
        characterId: 0,
        characters: [{ avatar: 'a.png', name: 'Assistant' }],
        groupId: identity.groupId || undefined,
        chat,
        eventTypes: {
            CHAT_COMPLETION_SETTINGS_READY: 'CHAT_COMPLETION_SETTINGS_READY',
            TEXT_COMPLETION_SETTINGS_READY: 'TEXT_COMPLETION_SETTINGS_READY',
            GENERATE_AFTER_DATA: 'GENERATE_AFTER_DATA',
            GENERATION_ENDED: 'GENERATION_ENDED',
            GENERATION_STOPPED: 'GENERATION_STOPPED',
            CHARACTER_MESSAGE_RENDERED: 'CHARACTER_MESSAGE_RENDERED',
            CHAT_CHANGED: 'CHAT_CHANGED',
            MESSAGE_SENT: 'MESSAGE_SENT',
            MESSAGE_RECEIVED: 'MESSAGE_RECEIVED',
        },
        eventSource: { on() {}, removeListener() {} },
        async saveChat() {
            saveChatCalls.push({ swipesSnapshot: chat.map((m) => ({ swipes: m.swipes?.slice() })) });
        },
        updateMessageBlock(...args) {
            updateMessageBlockCalls.push(args);
        },
        swipe: {
            refresh(...args) {
                swipeRefreshCalls.push(args);
            },
        },
        activateSendButtons() {},
        deactivateSendButtons() {},
        ...contextOverrides,
    };

    const dom = buildMessageElementHost(chat.length - 1);
    const originalDocument = globalThis.document;
    const originalWindow = globalThis.window;
    globalThis.document = dom;
    globalThis.window = { SillyTavern: { getContext: () => context } };

    return {
        context,
        saveChatCalls,
        updateMessageBlockCalls,
        swipeRefreshCalls,
        teardown() {
            globalThis.document = originalDocument;
            globalThis.window = originalWindow;
        },
    };
}

test('applyAcceptedOutput appends missing backend swipes directly and calls saveChat once', async () => {
    const chat = [
        {
            is_user: true,
            mes: 'User turn',
            extra: {},
        },
        {
            is_user: false,
            mes: 'Native reply',
            swipe_id: 0,
            swipes: ['Native reply'],
            swipe_info: [{ send_date: 't0', extra: {} }],
            extra: { retryMobileAssistantAnchorId: ANCHOR_ID },
        },
    ];

    const env = installFakeStEnvironment({ chat });

    try {

        const status = {
            jobId: 'job-1',
            targetMessageVersion: 3,
            targetMessageIndex: 1,
            targetAssistantAnchorId: ANCHOR_ID,
            targetMessage: {
                is_user: false,
                mes: 'Native reply',
                swipe_id: 0,
                swipes: ['Native reply', 'Accepted retry 1', 'Accepted retry 2', 'Accepted retry 3'],
                swipe_info: [
                    { send_date: 't0', extra: { retryMobileAssistantAnchorId: ANCHOR_ID } },
                    { send_date: 't1', extra: { retryMobileAssistantAnchorId: ANCHOR_ID } },
                    { send_date: 't2', extra: { retryMobileAssistantAnchorId: ANCHOR_ID } },
                    { send_date: 't3', extra: { retryMobileAssistantAnchorId: ANCHOR_ID } },
                ],
                extra: { retryMobileAssistantAnchorId: ANCHOR_ID },
            },
        };

        const result = await applyAcceptedOutput({ chatIdentity: CHAT_IDENTITY, status });

        assert.equal(result.ok, true, 'apply should succeed when anchor matches');
        assert.equal(result.targetMessageVersion, 3);
        assert.equal(env.saveChatCalls.length, 1, 'saveChat called exactly once after all swipes are appended');
        assert.equal(env.updateMessageBlockCalls.length, 0, 'updateMessageBlock must not be called in the apply path');
        assert.deepEqual(env.swipeRefreshCalls, [[true]], 'swipe.refresh(true) updates the visible counter/navigation without changing swipe_id');

        const lastMessage = chat[chat.length - 1];
        assert.equal(lastMessage.swipes.length, 4, 'live chat now has all backend swipes');
        assert.deepEqual(
            lastMessage.swipes.slice(1),
            ['Accepted retry 1', 'Accepted retry 2', 'Accepted retry 3'],
            'backend swipes appended in order after the native seed',
        );
        assert.equal(lastMessage.swipe_id, 0, 'swipe_id is never advanced (user stays on their current swipe)');
        assert.equal(
            lastMessage.swipe_info[3].extra.retryMobileAssistantAnchorId,
            ANCHOR_ID,
            'new swipe_info entry inherits the anchor stamp from the live row',
        );
    } finally {
        env.teardown();
    }
});

test('applyAcceptedOutput is idempotent when live chat already matches backend swipes', async () => {
    const chat = [
        { is_user: true, mes: 'User', extra: {} },
        {
            is_user: false,
            mes: 'Accepted retry 1',
            swipe_id: 1,
            swipes: ['Native', 'Accepted retry 1'],
            swipe_info: [
                { send_date: 't0', extra: { retryMobileAssistantAnchorId: ANCHOR_ID } },
                { send_date: 't1', extra: { retryMobileAssistantAnchorId: ANCHOR_ID } },
            ],
            extra: { retryMobileAssistantAnchorId: ANCHOR_ID },
        },
    ];
    const env = installFakeStEnvironment({ chat });

    try {

        const status = {
            jobId: 'job-2',
            targetMessageVersion: 1,
            targetMessageIndex: 1,
            targetAssistantAnchorId: ANCHOR_ID,
            targetMessage: {
                is_user: false,
                mes: 'Accepted retry 1',
                swipe_id: 1,
                swipes: ['Native', 'Accepted retry 1'],
                swipe_info: [
                    { send_date: 't0', extra: { retryMobileAssistantAnchorId: ANCHOR_ID } },
                    { send_date: 't1', extra: { retryMobileAssistantAnchorId: ANCHOR_ID } },
                ],
                extra: { retryMobileAssistantAnchorId: ANCHOR_ID },
            },
        };

        const result = await applyAcceptedOutput({ chatIdentity: CHAT_IDENTITY, status });
        assert.equal(result.ok, true);
        assert.equal(env.saveChatCalls.length, 0, 'no saveChat call when no missing swipes');
    } finally {
        env.teardown();
    }
});

test('applyAcceptedOutput stamps the anchor onto the unanchored native seed before appending swipes', async () => {
    const chat = [
        { is_user: true, mes: 'User', extra: {} },
        {
            is_user: false,
            mes: 'Native reply',
            swipe_id: 0,
            swipes: ['Native reply'],
            swipe_info: [{ send_date: 't0', extra: {} }],
            extra: {},
        },
    ];
    const env = installFakeStEnvironment({ chat });

    try {

        const status = {
            jobId: 'job-3',
            targetMessageVersion: 1,
            targetMessageIndex: 1,
            targetAssistantAnchorId: ANCHOR_ID,
            targetMessage: {
                is_user: false,
                mes: 'Native reply',
                swipe_id: 0,
                swipes: ['Native reply', 'Accepted retry'],
                swipe_info: [
                    { send_date: 't0', extra: { retryMobileAssistantAnchorId: ANCHOR_ID } },
                    { send_date: 't1', extra: { retryMobileAssistantAnchorId: ANCHOR_ID } },
                ],
                extra: { retryMobileAssistantAnchorId: ANCHOR_ID },
            },
        };

        const result = await applyAcceptedOutput({ chatIdentity: CHAT_IDENTITY, status });
        assert.equal(result.ok, true);
        assert.equal(env.saveChatCalls.length, 1, 'saveChat called once to persist the appended swipe');

        const lastMessage = chat[chat.length - 1];
        assert.equal(lastMessage.extra.retryMobileAssistantAnchorId, ANCHOR_ID,
            'row-level extra must carry the anchor before swipes are appended');
        assert.equal(lastMessage.swipe_info[0].extra.retryMobileAssistantAnchorId, ANCHOR_ID,
            'existing swipe_info[0] must be back-stamped with the anchor');
        assert.equal(lastMessage.swipe_info[1].extra.retryMobileAssistantAnchorId, ANCHOR_ID,
            'newly added swipe_info[1] must inherit the anchor');
    } finally {
        env.teardown();
    }
});

test('applyAcceptedOutput surfaces a client_chat_changed structured error when chat identity drifts', async () => {
    const chat = [
        { is_user: false, mes: 'A', swipe_id: 0, swipes: ['A'], swipe_info: [{ extra: {} }],
          extra: { retryMobileAssistantAnchorId: ANCHOR_ID } },
    ];
    const env = installFakeStEnvironment({ chat });

    try {

        const result = await applyAcceptedOutput({
            chatIdentity: { kind: 'character', chatId: 'different-chat', groupId: null },
            status: {
                targetAssistantAnchorId: ANCHOR_ID,
                targetMessage: { is_user: false, mes: 'A', swipes: ['A', 'B'], swipe_info: [], extra: {} },
            },
        });

        assert.equal(result.ok, false);
        assert.equal(result.recoveryRequired, false, 'chat-changed errors are non-recoverable (user navigated away)');
        assert.equal(result.error.code, 'client_chat_changed');
        assert.equal(env.saveChatCalls.length, 0, 'must not call saveChat when chat identity drifts');
    } finally {
        env.teardown();
    }
});

test('applyAcceptedOutput surfaces client_anchor_mismatch when the live last row is a different turn', async () => {
    const chat = [
        { is_user: true, mes: 'U', extra: {} },
        {
            is_user: false,
            mes: 'Different reply text entirely',
            swipe_id: 0,
            swipes: ['Different reply text entirely'],
            swipe_info: [{ send_date: 't0', extra: { retryMobileAssistantAnchorId: 'unrelated-anchor' } }],
            extra: { retryMobileAssistantAnchorId: 'unrelated-anchor' },
        },
    ];
    const env = installFakeStEnvironment({ chat });

    try {

        const result = await applyAcceptedOutput({
            chatIdentity: CHAT_IDENTITY,
            status: {
                jobId: 'job-mismatch',
                targetMessageIndex: 1,
                targetMessageVersion: 1,
                targetAssistantAnchorId: ANCHOR_ID,
                targetMessage: {
                    is_user: false,
                    mes: 'Backend assistant reply',
                    swipe_id: 0,
                    swipes: ['Backend assistant reply', 'Backend swipe 2'],
                    swipe_info: [
                        { send_date: 't0', extra: { retryMobileAssistantAnchorId: ANCHOR_ID } },
                        { send_date: 't1', extra: { retryMobileAssistantAnchorId: ANCHOR_ID } },
                    ],
                    extra: { retryMobileAssistantAnchorId: ANCHOR_ID },
                },
            },
        });

        assert.equal(result.ok, false);
        assert.equal(result.recoveryRequired, true);
        assert.equal(result.error.code, 'client_anchor_mismatch');
        assert.equal(env.saveChatCalls.length, 0, 'must not call saveChat when anchor drifts');
    } finally {
        env.teardown();
    }
});

test('applyAcceptedOutput surfaces client_patch_failed when saveChat throws', async () => {
    const chat = [
        { is_user: true, mes: 'U', extra: {} },
        {
            is_user: false,
            mes: 'Native',
            swipe_id: 0,
            swipes: ['Native'],
            swipe_info: [{ send_date: 't0', extra: { retryMobileAssistantAnchorId: ANCHOR_ID } }],
            extra: { retryMobileAssistantAnchorId: ANCHOR_ID },
        },
    ];

    const env = installFakeStEnvironment({
        chat,
        contextOverrides: {
            async saveChat() {
                throw new Error('simulated saveChat failure');
            },
        },
    });

    try {

        const result = await applyAcceptedOutput({
            chatIdentity: CHAT_IDENTITY,
            status: {
                jobId: 'job-fail',
                targetMessageIndex: 1,
                targetMessageVersion: 1,
                targetAssistantAnchorId: ANCHOR_ID,
                targetMessage: {
                    is_user: false,
                    mes: 'Native',
                    swipe_id: 0,
                    swipes: ['Native', 'New accepted'],
                    swipe_info: [
                        { send_date: 't0', extra: { retryMobileAssistantAnchorId: ANCHOR_ID } },
                        { send_date: 't1', extra: { retryMobileAssistantAnchorId: ANCHOR_ID } },
                    ],
                    extra: { retryMobileAssistantAnchorId: ANCHOR_ID },
                },
            },
        });

        assert.equal(result.ok, false);
        assert.equal(result.recoveryRequired, true);
        assert.equal(result.error.code, 'client_patch_failed');
        assert.match(result.error.message, /simulated saveChat failure/);
    } finally {
        env.teardown();
    }
});

// ---------------------------------------------------------------------------
// Pure helper coverage — assistantTargetMatches stays the load-bearing anchor-
// verification gate that protects in-memory swipe appends.
// ---------------------------------------------------------------------------

test('assistantTargetMatches accepts a live turn that already carries the expected anchor', () => {
    assert.equal(assistantTargetMatches({
        mes: 'Native reply',
        extra: { retryMobileAssistantAnchorId: 'anchor-1' },
    }, { mes: 'Native reply' }, 'anchor-1'), true);
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
        swipe_info: [{ extra: { retryMobileAssistantAnchorId: 'anchor-1' } }],
    }, 'anchor-1'), true);
});

test('assistantTargetMatches accepts an empty placeholder before the first backend write stamps anchors', () => {
    assert.equal(assistantTargetMatches({
        mes: '', extra: {}, swipes: [], swipe_info: [],
    }, {
        mes: 'Accepted retry swipe',
        swipes: ['Accepted retry swipe'],
        swipe_info: [{ extra: { retryMobileAssistantAnchorId: 'anchor-1' } }],
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
        swipe_info: [{ extra: { retryMobileAssistantAnchorId: 'anchor-1' } }],
    }, 'anchor-1'), false);
});

test('assistantTargetMatches adopts the same live turn when a new job restamps an older retry anchor', () => {
    assert.equal(assistantTargetMatches({
        mes: 'Swipe 2',
        extra: { retryMobileAssistantAnchorId: 'old-anchor' },
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
        extra: { retryMobileAssistantAnchorId: 'old-anchor' },
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
        extra: { retryMobileAssistantAnchorId: 'old-anchor' },
        swipes: ['Different assistant row'],
        swipe_info: [{ extra: { retryMobileAssistantAnchorId: 'old-anchor' } }],
    }, {
        mes: 'Native reply',
        swipes: ['Native reply', 'Accepted retry swipe'],
        swipe_info: [
            { extra: { retryMobileAssistantAnchorId: 'new-anchor' } },
            { extra: { retryMobileAssistantAnchorId: 'new-anchor' } },
        ],
    }, 'new-anchor'), false);
});

test('applyAcceptedOutput stamps retryMobileTargetVersion on the live message after successful apply', async () => {
    const chat = [
        { is_user: true, mes: 'User turn', extra: {} },
        {
            is_user: false,
            mes: 'Native reply',
            swipe_id: 0,
            swipes: ['Native reply'],
            swipe_info: [{ send_date: 't0', extra: { retryMobileAssistantAnchorId: ANCHOR_ID } }],
            extra: { retryMobileAssistantAnchorId: ANCHOR_ID },
        },
    ];
    const { teardown } = installFakeStEnvironment({ chat });
    try {
        const status = {
            jobId: 'job-ver',
            targetAssistantAnchorId: ANCHOR_ID,
            targetMessageVersion: 2,
            chatIdentity: CHAT_IDENTITY,
            targetMessage: {
                swipes: ['Native reply', 'Retry swipe 1'],
                extra: { retryMobileAssistantAnchorId: ANCHOR_ID },
            },
        };
        const result = await applyAcceptedOutput({ chatIdentity: CHAT_IDENTITY, status });
        assert.equal(result.ok, true);
        const lastMessage = chat[chat.length - 1];
        assert.equal(lastMessage.extra.retryMobileTargetVersion, 2, 'version stamped after apply');
    } finally {
        teardown();
    }
});

test('applyAcceptedOutput returns client_target_version_drift when live version is more than one write behind', async () => {
    // Live message has been previously stamped at version 1 (first apply succeeded),
    // but backend now reports version 3 (two backend writes done). Since liveVersion(1)
    // < targetMessageVersion(3) - 1 = 2, the gap indicates mid-run drift.
    const chat = [
        { is_user: true, mes: 'User turn', extra: {} },
        {
            is_user: false,
            mes: 'Native reply',
            swipe_id: 0,
            swipes: ['Native reply'],
            swipe_info: [{ send_date: 't0', extra: { retryMobileAssistantAnchorId: ANCHOR_ID } }],
            extra: { retryMobileAssistantAnchorId: ANCHOR_ID, retryMobileTargetVersion: 1 },
        },
    ];
    const { teardown } = installFakeStEnvironment({ chat });
    try {
        const status = {
            jobId: 'job-drift',
            targetAssistantAnchorId: ANCHOR_ID,
            targetMessageVersion: 3,
            chatIdentity: CHAT_IDENTITY,
            targetMessage: {
                swipes: ['Native reply', 'Retry swipe 1', 'Retry swipe 2'],
                extra: { retryMobileAssistantAnchorId: ANCHOR_ID },
            },
        };
        const result = await applyAcceptedOutput({ chatIdentity: CHAT_IDENTITY, status });
        assert.equal(result.ok, false);
        assert.equal(result.recoveryRequired, true);
        assert.equal(result.error?.code, 'client_target_version_drift');
    } finally {
        teardown();
    }
});

test('applyAcceptedOutput does not flag version drift when gap is exactly one (normal next-write case)', async () => {
    // liveVersion = 1, targetMessageVersion = 2: gap is exactly 1, this is normal
    const chat = [
        { is_user: true, mes: 'User turn', extra: {} },
        {
            is_user: false,
            mes: 'Native reply',
            swipe_id: 0,
            swipes: ['Native reply'],
            swipe_info: [{ send_date: 't0', extra: { retryMobileAssistantAnchorId: ANCHOR_ID } }],
            extra: { retryMobileAssistantAnchorId: ANCHOR_ID, retryMobileTargetVersion: 1 },
        },
    ];
    const { teardown } = installFakeStEnvironment({ chat });
    try {
        const status = {
            jobId: 'job-normal-gap',
            targetAssistantAnchorId: ANCHOR_ID,
            targetMessageVersion: 2,
            chatIdentity: CHAT_IDENTITY,
            targetMessage: {
                swipes: ['Native reply', 'Retry swipe 1'],
                extra: { retryMobileAssistantAnchorId: ANCHOR_ID },
            },
        };
        const result = await applyAcceptedOutput({ chatIdentity: CHAT_IDENTITY, status });
        assert.equal(result.ok, true, 'gap of exactly 1 is the normal apply case, not drift');
    } finally {
        teardown();
    }
});
