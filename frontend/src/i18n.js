import { fetchI18nCatalog } from './backend-api.js';

const FALLBACK_CATALOG = Object.freeze({
    meta: {
        defaultLanguage: 'en',
        supportedLanguages: ['en', 'zh'],
    },
});

let catalog = FALLBACK_CATALOG;
let activeLanguage = 'en';
let loaded = false;

export async function initializeI18n(preferredLanguage = '') {
    if (!loaded) {
        try {
            const payload = await fetchI18nCatalog();
            const nextCatalog = payload?.strings && typeof payload.strings === 'object'
                ? payload.strings
                : FALLBACK_CATALOG;
            catalog = nextCatalog;
            loaded = true;
        } catch {
            catalog = FALLBACK_CATALOG;
            loaded = true;
        }
    }

    activeLanguage = normalizeLanguage(preferredLanguage);
    return activeLanguage;
}

export function setLanguage(language) {
    activeLanguage = normalizeLanguage(language);
    return activeLanguage;
}

export function getLanguage() {
    return activeLanguage;
}

export function getSupportedLanguages() {
    const values = Array.isArray(catalog?.meta?.supportedLanguages)
        ? catalog.meta.supportedLanguages
        : ['en'];
    return values
        .map((value) => String(value || '').trim().toLowerCase())
        .filter(Boolean);
}

export function t(key, vars = {}, options = {}) {
    const language = normalizeLanguage(options.language || activeLanguage);
    const node = resolveNode(catalog, key);
    if (!node || typeof node !== 'object') {
        return key;
    }

    const fallbackLanguage = normalizeLanguage('en');
    const template = typeof node[language] === 'string'
        ? node[language]
        : (typeof node[fallbackLanguage] === 'string' ? node[fallbackLanguage] : key);
    return interpolate(template, vars);
}

function resolveNode(root, dottedPath) {
    const parts = String(dottedPath || '')
        .split('.')
        .map((value) => value.trim())
        .filter(Boolean);
    if (parts.length === 0) {
        return null;
    }

    let current = root;
    for (const part of parts) {
        if (!current || typeof current !== 'object' || !(part in current)) {
            return null;
        }
        current = current[part];
    }
    return current;
}

function normalizeLanguage(language) {
    const supported = getSupportedLanguages();
    const fallback = String(catalog?.meta?.defaultLanguage || 'en').trim().toLowerCase() || 'en';
    const normalized = String(language || '').trim().toLowerCase();
    if (supported.includes(normalized)) {
        return normalized;
    }
    if (supported.includes(fallback)) {
        return fallback;
    }
    return supported[0] || 'en';
}

function interpolate(template, vars = {}) {
    return String(template).replace(/\{([a-zA-Z0-9_]+)\}/g, (full, key) => (
        Object.prototype.hasOwnProperty.call(vars, key)
            ? String(vars[key] ?? '')
            : full
    ));
}
