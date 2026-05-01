const fs = require('node:fs');
const path = require('node:path');

const CATALOG_PATH = path.join(__dirname, 'i18n', 'strings.jsonc');

let cachedCatalog = null;

function getCatalog() {
    if (cachedCatalog) {
        return cachedCatalog;
    }

    const raw = fs.readFileSync(CATALOG_PATH, 'utf8');
    const parsed = JSON.parse(stripJsonComments(raw));
    cachedCatalog = parsed;
    return cachedCatalog;
}

function getSupportedLanguages() {
    const catalog = getCatalog();
    const list = Array.isArray(catalog?.meta?.supportedLanguages)
        ? catalog.meta.supportedLanguages
        : ['en'];
    const normalized = list
        .map((value) => String(value || '').trim().toLowerCase())
        .filter(Boolean);
    return normalized.length > 0 ? normalized : ['en'];
}

function normalizeLanguage(language) {
    const supported = getSupportedLanguages();
    const fallback = String(getCatalog()?.meta?.defaultLanguage || 'en').trim().toLowerCase() || 'en';
    const normalized = String(language || '').trim().toLowerCase();
    if (supported.includes(normalized)) {
        return normalized;
    }
    return supported.includes(fallback) ? fallback : supported[0];
}

function translate(key, {
    language = 'en',
    vars = {},
} = {}) {
    const catalog = getCatalog();
    const node = resolveCatalogNode(catalog, key);
    if (!node || typeof node !== 'object') {
        return key;
    }

    const normalizedLanguage = normalizeLanguage(language);
    const fallbackLanguage = normalizeLanguage('en');
    const raw = typeof node[normalizedLanguage] === 'string'
        ? node[normalizedLanguage]
        : (typeof node[fallbackLanguage] === 'string' ? node[fallbackLanguage] : key);
    return interpolate(raw, vars);
}

function resolveCatalogNode(root, dottedPath) {
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

function interpolate(template, vars = {}) {
    return String(template).replace(/\{([a-zA-Z0-9_]+)\}/g, (full, key) => (
        Object.prototype.hasOwnProperty.call(vars, key)
            ? String(vars[key] ?? '')
            : full
    ));
}

function stripJsonComments(input) {
    let output = '';
    let inString = false;
    let escaped = false;
    let inLineComment = false;
    let inBlockComment = false;

    for (let index = 0; index < input.length; index += 1) {
        const char = input[index];
        const next = input[index + 1];

        if (inLineComment) {
            if (char === '\n') {
                inLineComment = false;
                output += char;
            }
            continue;
        }

        if (inBlockComment) {
            if (char === '*' && next === '/') {
                inBlockComment = false;
                index += 1;
            }
            continue;
        }

        if (!inString) {
            if (char === '/' && next === '/') {
                inLineComment = true;
                index += 1;
                continue;
            }
            if (char === '/' && next === '*') {
                inBlockComment = true;
                index += 1;
                continue;
            }
        }

        output += char;
        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (char === '\\') {
                escaped = true;
            } else if (char === '"') {
                inString = false;
            }
            continue;
        }

        if (char === '"') {
            inString = true;
            escaped = false;
        }
    }

    return output;
}

module.exports = {
    getCatalog,
    getSupportedLanguages,
    normalizeLanguage,
    translate,
};
