// Single source of truth for the structured clone helper used across the
// frontend. All seven previous duplicates were byte-identical apart from
// their function name; this module exists so a future fallback adjustment
// only has to touch one file.

export function cloneValue(value) {
    if (value == null) {
        return value ?? null;
    }

    if (typeof globalThis.structuredClone === 'function') {
        return globalThis.structuredClone(value);
    }

    return JSON.parse(JSON.stringify(value));
}
