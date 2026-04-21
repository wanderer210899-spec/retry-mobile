import { RUN_MODE, SETTINGS_KEY } from './constants.js';
import { readSettings, writeSettings } from './settings.js';

export function createIntentPort({ getContext }) {
    return {
        readIntent,
        writeIntent,
        readSettings: readRunSettings,
        writeSettings: writeRunSettings,
        getSingleTarget,
        saveSingleTarget,
        clearSingleTarget,
    };

    function readIntent() {
        const context = getContext?.() ?? null;
        const settings = readSettings(context);
        const source = readIntentSource(context);
        return {
            mode: settings.runMode === RUN_MODE.TOGGLE ? 'toggle' : 'single',
            engaged: Boolean(source.engaged),
            singleTarget: cloneValue(source.singleTarget) || null,
            settings,
        };
    }

    function writeIntent(patch = {}) {
        const context = getContext?.() ?? null;
        if (!context) {
            return false;
        }

        const currentSettings = readSettings(context);
        const nextSettings = {
            ...currentSettings,
            ...(isPlainObject(patch.settings) ? patch.settings : {}),
        };
        if (patch.mode === 'toggle') {
            nextSettings.runMode = RUN_MODE.TOGGLE;
        } else if (patch.mode === 'single') {
            nextSettings.runMode = RUN_MODE.SINGLE;
        }

        writeSettings(context, nextSettings);
        const source = ensureIntentSource(context);
        if (Object.prototype.hasOwnProperty.call(patch, 'engaged')) {
            source.engaged = Boolean(patch.engaged);
        }
        if (Object.prototype.hasOwnProperty.call(patch, 'singleTarget')) {
            source.singleTarget = cloneValue(patch.singleTarget) || null;
        }
        context.saveSettingsDebounced?.();
        return true;
    }

    function readRunSettings() {
        return readSettings(getContext?.() ?? null);
    }

    function writeRunSettings(patch = {}) {
        const context = getContext?.() ?? null;
        if (!context) {
            return false;
        }

        return writeSettings(context, {
            ...readSettings(context),
            ...(isPlainObject(patch) ? patch : {}),
        });
    }

    function getSingleTarget() {
        const context = getContext?.() ?? null;
        return cloneValue(readIntentSource(context).singleTarget) || null;
    }

    function saveSingleTarget(target) {
        const context = getContext?.() ?? null;
        if (!context) {
            return false;
        }

        const source = ensureIntentSource(context);
        source.singleTarget = cloneValue(target) || null;
        context.saveSettingsDebounced?.();
        return true;
    }

    function clearSingleTarget() {
        const context = getContext?.() ?? null;
        if (!context) {
            return false;
        }

        const source = ensureIntentSource(context);
        source.singleTarget = null;
        context.saveSettingsDebounced?.();
        return true;
    }
}

function readIntentSource(context) {
    const source = context?.extensionSettings?.[SETTINGS_KEY];
    return source && typeof source === 'object' ? source : {};
}

function ensureIntentSource(context) {
    context.extensionSettings ??= {};
    const current = readIntentSource(context);
    context.extensionSettings[SETTINGS_KEY] = {
        ...current,
        ...readSettings(context),
    };
    return context.extensionSettings[SETTINGS_KEY];
}

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cloneValue(value) {
    if (value == null) {
        return value ?? null;
    }

    if (typeof globalThis.structuredClone === 'function') {
        return globalThis.structuredClone(value);
    }

    return JSON.parse(JSON.stringify(value));
}
