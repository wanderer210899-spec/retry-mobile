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

    const currentSource = context.extensionSettings?.[SETTINGS_KEY];
    const preservedFields = currentSource && typeof currentSource === 'object'
        ? { ...currentSource }
        : {};

    context.extensionSettings ??= {};
    context.extensionSettings[SETTINGS_KEY] = {
        ...preservedFields,
        ...normalizeSettings(nextSettings || {}),
    };
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
    settings.nativeGraceSeconds = normalizeClampedWholeNumber(settings.nativeGraceSeconds, 10, 300, DEFAULT_SETTINGS.nativeGraceSeconds);
    settings.notifyOnSuccess = normalizeBoolean(settings.notifyOnSuccess, DEFAULT_SETTINGS.notifyOnSuccess);
    settings.notifyOnComplete = normalizeBoolean(settings.notifyOnComplete, DEFAULT_SETTINGS.notifyOnComplete);
    settings.vibrateOnSuccess = normalizeBoolean(settings.vibrateOnSuccess, DEFAULT_SETTINGS.vibrateOnSuccess);
    settings.vibrateOnComplete = normalizeBoolean(settings.vibrateOnComplete, DEFAULT_SETTINGS.vibrateOnComplete);
    settings.allowHeuristicTokenFallback = normalizeBoolean(settings.allowHeuristicTokenFallback, DEFAULT_SETTINGS.allowHeuristicTokenFallback);
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

function normalizeClampedWholeNumber(value, minimum, maximum, fallback) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }

    return Math.min(maximum, Math.max(minimum, parsed));
}

function normalizeBoolean(value, fallback) {
    if (value === true || value === false) {
        return value;
    }

    if (value === 'true') {
        return true;
    }

    if (value === 'false') {
        return false;
    }

    return fallback;
}
