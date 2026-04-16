import { DEFAULT_SETTINGS, SETTINGS_KEY } from './constants.js';

export function readSettings(context) {
    const source = context?.extensionSettings?.[SETTINGS_KEY];
    if (!source || typeof source !== 'object') {
        return { ...DEFAULT_SETTINGS };
    }

    return {
        ...DEFAULT_SETTINGS,
        ...source,
    };
}

export function writeSettings(context, nextSettings) {
    if (!context) {
        return false;
    }

    context.extensionSettings ??= {};
    context.extensionSettings[SETTINGS_KEY] = {
        ...DEFAULT_SETTINGS,
        ...(nextSettings || {}),
    };
    context.saveSettingsDebounced?.();
    return true;
}
