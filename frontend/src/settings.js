import { DEFAULT_SETTINGS, RUN_MODE, SETTINGS_KEY, VALIDATION_MODE } from './constants.js';

export function readSettings(context) {
    const source = context?.extensionSettings?.[SETTINGS_KEY];
    if (!source || typeof source !== 'object') {
        return { ...DEFAULT_SETTINGS };
    }

    return normalizeSettings(source);
}

export function writeSettings(context, nextSettings) {
    if (!context) {
        return false;
    }

    context.extensionSettings ??= {};
    context.extensionSettings[SETTINGS_KEY] = normalizeSettings(nextSettings || {});
    context.saveSettingsDebounced?.();
    return true;
}

function normalizeSettings(source) {
    const settings = {
        ...DEFAULT_SETTINGS,
        ...(source || {}),
    };

    settings.runMode = settings.runMode === RUN_MODE.TOGGLE
        ? RUN_MODE.TOGGLE
        : RUN_MODE.SINGLE;
    settings.validationMode = normalizeValidationMode(source, settings);
    settings.minCharacters = normalizeWholeNumber(
        source?.minCharacters ?? source?.minWords,
        DEFAULT_SETTINGS.minCharacters,
    );
    settings.minTokens = normalizeWholeNumber(settings.minTokens, DEFAULT_SETTINGS.minTokens);
    settings.targetAcceptedCount = Math.max(1, normalizeWholeNumber(settings.targetAcceptedCount, DEFAULT_SETTINGS.targetAcceptedCount));
    settings.maxAttempts = Math.max(1, normalizeWholeNumber(settings.maxAttempts, DEFAULT_SETTINGS.maxAttempts));
    settings.attemptTimeoutSeconds = Math.max(1, normalizeWholeNumber(settings.attemptTimeoutSeconds, DEFAULT_SETTINGS.attemptTimeoutSeconds));
    settings.notifyOnSuccess = Boolean(settings.notifyOnSuccess);
    settings.notifyOnComplete = Boolean(settings.notifyOnComplete);
    settings.vibrateOnSuccess = Boolean(settings.vibrateOnSuccess);
    settings.vibrateOnComplete = Boolean(settings.vibrateOnComplete);
    settings.notificationMessageTemplate = typeof settings.notificationMessageTemplate === 'string'
        ? settings.notificationMessageTemplate
        : '';
    return settings;
}

function normalizeValidationMode(source, settings) {
    const explicit = source?.validationMode;
    if (explicit === VALIDATION_MODE.TOKENS) {
        return VALIDATION_MODE.TOKENS;
    }

    if (explicit === VALIDATION_MODE.CHARACTERS || explicit === 'words') {
        return VALIDATION_MODE.CHARACTERS;
    }

    if (Number(settings?.minTokens) > 0 && Number(source?.minCharacters ?? source?.minWords ?? 0) <= 0) {
        return VALIDATION_MODE.TOKENS;
    }

    return VALIDATION_MODE.CHARACTERS;
}

function normalizeWholeNumber(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
        return fallback;
    }

    return parsed;
}
