// When the user updates the plugin, the backend has already cleared its own
// persisted job state (see install.cjs and the boot-time skip in
// server/index.js's restoreSinglePersistedJob). The frontend keeps two pieces
// of state across reloads that the backend cannot reset for it:
//   - intent.engaged (in extension settings) — whether toggle/single mode is on
//   - retry-mobile:active-run:* (in localStorage) — per-chat job bindings
// Without this gate, the previous install's "armed" state would survive an
// update and re-arm the user automatically when they return to the browser.
// We compare the backend's installedVersion against the last-seen value in
// localStorage; on first boot we just record the version, but any later
// version change clears engaged and the active-run bindings so the user
// returns to a fresh, unarmed plugin.

const VERSION_STORAGE_KEY = 'retry-mobile:last-seen-installed-version';
const ACTIVE_RUN_STORAGE_PREFIX = 'retry-mobile:active-run:';

export function applyInstallVersionGate({
    installedVersion,
    intentPort,
    storage = getLocalStorage(),
} = {}) {
    const current = String(installedVersion || '').trim();
    const result = {
        changed: false,
        previous: '',
        current,
        clearedBindings: 0,
    };

    if (!current || !storage) {
        return result;
    }

    let previous = '';
    try {
        previous = String(storage.getItem(VERSION_STORAGE_KEY) || '').trim();
    } catch {
        previous = '';
    }
    result.previous = previous;

    if (previous === current) {
        return result;
    }

    // First-time boot has no recorded version — just stamp the current one.
    // We deliberately do NOT clear engaged on first boot because there is
    // nothing meaningful to clear yet, and a fresh install should not race
    // an early Start press.
    if (previous !== '') {
        try {
            intentPort?.writeIntent?.({ engaged: false });
        } catch {
            // Non-fatal: extension settings may be unavailable mid-boot.
        }
        result.clearedBindings = clearActiveRunBindings(storage);
        result.changed = true;
    }

    try {
        storage.setItem(VERSION_STORAGE_KEY, current);
    } catch {
        // Non-fatal: localStorage may be full or sandboxed.
    }

    return result;
}

function clearActiveRunBindings(storage) {
    const matchingKeys = [];
    try {
        for (let index = 0; index < storage.length; index += 1) {
            const key = storage.key(index);
            if (key && key.startsWith(ACTIVE_RUN_STORAGE_PREFIX)) {
                matchingKeys.push(key);
            }
        }
    } catch {
        return 0;
    }

    let removed = 0;
    for (const key of matchingKeys) {
        try {
            storage.removeItem(key);
            removed += 1;
        } catch {
            // Ignore per-key removal failures.
        }
    }
    return removed;
}

function getLocalStorage() {
    try {
        return globalThis.localStorage ?? null;
    } catch {
        return null;
    }
}
