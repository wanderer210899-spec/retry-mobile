// panel-bindings.test.mjs
//
// Regression tests for panel mount / remount behaviour.
// Minimal DOM stubs — no third-party DOM library needed.

import test from 'node:test';
import assert from 'node:assert/strict';

// ─── minimal DOM stubs ────────────────────────────────────────────────────────

function makeInput(attrs = {}) {
    return {
        id: attrs.id || '',
        name: attrs.name || '',
        tagName: 'INPUT',
        className: attrs.class || '',
        value: '',
        checked: false,
        disabled: false,
        dataset: { ...(attrs.dataset || {}) },
        _listeners: {},
        addEventListener(type, fn) { this._listeners[type] = fn; },
        children: [],
    };
}

function makeElement(tag = 'div', attrs = {}) {
    const el = {
        tagName: tag.toUpperCase(),
        id: attrs.id || '',
        name: attrs.name || '',
        className: attrs.class || '',
        innerHTML: '',
        textContent: '',
        hidden: false,
        disabled: false,
        value: '',
        checked: false,
        dataset: { ...(attrs.dataset || {}) },
        children: [],
        _listeners: {},
        querySelector(selector) { return queryIn(this, selector); },
        querySelectorAll(selector) { return queryAllIn(this, selector); },
        addEventListener(type, fn) { this._listeners[type] = fn; },
        prepend(child) { this.children.unshift(child); child.parentElement = this; },
        appendChild(child) { this.children.push(child); child.parentElement = this; },
    };
    return el;
}

function queryIn(root, selector) {
    for (const child of root.children || []) {
        if (matchesSelector(child, selector)) return child;
        const found = queryIn(child, selector);
        if (found) return found;
    }
    return null;
}

function queryAllIn(root, selector) {
    const results = [];
    for (const child of root.children || []) {
        if (matchesSelector(child, selector)) results.push(child);
        results.push(...queryAllIn(child, selector));
    }
    return results;
}

function matchesSelector(el, selector) {
    if (!el || typeof selector !== 'string') return false;
    // [data-role="x"] or [data-action="x"] or [data-setting] etc.
    const attrValMatch = selector.match(/^\[([^\]=]+)="([^"]+)"\]$/);
    if (attrValMatch) {
        const [, attr, value] = attrValMatch;
        if (attr.startsWith('data-')) {
            return el.dataset?.[attr.slice(5)] === value;
        }
        return el[attr] === value;
    }
    // [data-setting] — presence only
    const attrPresenceMatch = selector.match(/^\[([^\]]+)\]$/);
    if (attrPresenceMatch) {
        const attr = attrPresenceMatch[1];
        if (attr.startsWith('data-')) {
            return el.dataset?.[attr.slice(5)] !== undefined;
        }
        return el[attr] !== undefined;
    }
    // #id
    if (selector.startsWith('#')) return el.id === selector.slice(1);
    // .class
    if (selector.startsWith('.')) {
        return (el.className || '').split(' ').includes(selector.slice(1));
    }
    return false;
}

const EXT = 'retry-mobile';

// Build a drawer that includes all DOM nodes cachePanelElements and hydrateForm
// query so mountPanel can run to completion without throwing.
function makeDrawer(id = `${EXT}-panel`) {
    const drawer = makeElement('div', { id });

    const roleSlots = [
        'state-pill', 'stats', 'retry-log-shell', 'retry-log-box',
        'release-info', 'error-box', 'main-pane', 'system-pane', 'qr-status',
    ];
    for (const role of roleSlots) {
        drawer.children.push(makeElement('div', { dataset: { role } }));
    }

    // Action buttons
    for (const action of ['toggle-run', 'toggle-qr', 'toggle-log', 'sync-status']) {
        drawer.children.push(makeElement('button', { dataset: { action } }));
    }
    // Tab button
    drawer.children.push(makeElement('span', { class: 'rm-tab' }));

    // Form inputs hydrateForm expects to set .value on
    for (const id of [
        `${EXT}-target`, `${EXT}-attempts`, `${EXT}-timeout`,
        `${EXT}-native-grace`, `${EXT}-tokens`,
        `${EXT}-notification-template`, `${EXT}-ui-language`,
        `${EXT}-counter-mode`,
    ]) {
        drawer.children.push(makeInput({ id }));
    }

    return drawer;
}

function makeRuntime(overrides = {}) {
    return {
        ui: { statsRenderKey: 'stale|0|0|0', ...overrides.ui },
        mountRetryHandle: 0,
        settings: {
            targetAcceptedCount: 3,
            maxAttempts: 10,
            attemptTimeoutSeconds: 30,
            nativeGraceSeconds: 15,
            minWords: 0,
            minCharacters: 0,
            minTokens: 0,
            notificationMessageTemplate: '',
            uiLanguage: 'en',
            counterMode: 'auto',
            runMode: 'toggle',
            validationMode: 'characters',
            ...overrides.settings,
        },
    };
}

// ─── module under test ────────────────────────────────────────────────────────

const { mountPanel } = await import('./panel-bindings.js');

// ─── tests ────────────────────────────────────────────────────────────────────

test('cachePanelElements resets statsRenderKey to empty string on first mount', () => {
    const drawer = makeDrawer();
    const runtime = makeRuntime({ ui: {} });

    const origDoc = globalThis.document;
    globalThis.document = { getElementById: (id) => drawer.id === id ? drawer : null };
    try {
        mountPanel(runtime, { render: () => {}, persistSettings: () => {}, actions: {}, onMissingHost: () => {} });
    } finally {
        globalThis.document = origDoc;
    }

    assert.equal(
        runtime.ui.statsRenderKey,
        '',
        'statsRenderKey must be empty after mount so render() writes stats DOM on first tick',
    );
});

test('cachePanelElements resets statsRenderKey after remount (existing drawer path)', () => {
    const drawer = makeDrawer();
    // Simulate a stale key left over from a previous run — this is the bug
    const runtime = makeRuntime({ ui: { statsRenderKey: '2|5|3|30' } });

    const origDoc = globalThis.document;
    globalThis.document = { getElementById: (id) => drawer.id === id ? drawer : null };
    try {
        // mountPanel takes the existingDrawer branch, calls cachePanelElements again
        mountPanel(runtime, { render: () => {}, persistSettings: () => {}, actions: {}, onMissingHost: () => {} });
    } finally {
        globalThis.document = origDoc;
    }

    assert.equal(
        runtime.ui.statsRenderKey,
        '',
        'stale statsRenderKey must be cleared on remount — otherwise render() skips writing stats into the fresh empty element',
    );
});
