function normalizeText(text) {
    return String(text ?? '')
        .replace(/\r\n/g, '\n')
        .trim();
}

const VALIDATION_MODE = Object.freeze({
    CHARACTERS: 'characters',
    TOKENS: 'tokens',
});

function countCharacters(text) {
    const normalized = normalizeText(text);
    if (!normalized) {
        return 0;
    }

    return Array.from(normalized.replace(/\s+/gu, '')).length;
}

function countTokensHeuristic(text) {
    const normalized = normalizeText(text);
    if (!normalized) {
        return 0;
    }

    const matches = normalized.match(/[A-Za-z0-9_]+|[^\s]/g);
    return matches ? matches.length : 0;
}

function normalizeValidationMode(runConfig = {}) {
    if (runConfig.validationMode === VALIDATION_MODE.TOKENS) {
        return VALIDATION_MODE.TOKENS;
    }

    return VALIDATION_MODE.CHARACTERS;
}

function getValidationThreshold(runConfig = {}) {
    const mode = normalizeValidationMode(runConfig);
    const threshold = mode === VALIDATION_MODE.TOKENS
        ? Math.max(0, Number(runConfig.minTokens) || 0)
        : Math.max(0, Number(runConfig.minCharacters ?? runConfig.minWords) || 0);

    return {
        mode,
        threshold,
    };
}

function getAttemptTimeoutSeconds(runConfig = {}) {
    return Math.max(0, Number(runConfig.attemptTimeoutSeconds) || 0);
}

function validateRunConfig(runConfig = {}) {
    const validation = getValidationThreshold(runConfig);
    const attemptTimeoutSeconds = getAttemptTimeoutSeconds(runConfig);
    if (attemptTimeoutSeconds <= 0) {
        return {
            ok: false,
            ...validation,
            attemptTimeoutSeconds,
            code: 'validation_config_invalid',
            message: 'Attempt timeout must be greater than 0 seconds.',
        };
    }

    if (validation.threshold > 0) {
        return {
            ok: true,
            ...validation,
            attemptTimeoutSeconds,
        };
    }

    return {
        ok: false,
        ...validation,
        attemptTimeoutSeconds,
        code: 'validation_config_invalid',
        message: validation.mode === VALIDATION_MODE.TOKENS
            ? 'Minimum tokens must be greater than 0 when token-count blocking is active.'
            : 'Minimum characters must be greater than 0 when character-count blocking is active.',
    };
}

function validateAcceptedText(text, runConfig = {}) {
    const normalized = normalizeText(text);
    const validation = getValidationThreshold(runConfig);
    const metrics = {
        text: normalized,
        characterCount: countCharacters(normalized),
        tokenCount: countTokensHeuristic(normalized),
    };

    if (!normalized) {
        return {
            accepted: false,
            reason: 'empty',
            metrics,
            validationMode: validation.mode,
            threshold: validation.threshold,
        };
    }

    if (validation.mode === VALIDATION_MODE.CHARACTERS && validation.threshold > 0 && metrics.characterCount < validation.threshold) {
        return {
            accepted: false,
            reason: 'below_min_characters',
            metrics,
            validationMode: validation.mode,
            threshold: validation.threshold,
        };
    }

    if (validation.mode === VALIDATION_MODE.TOKENS && validation.threshold > 0 && metrics.tokenCount < validation.threshold) {
        return {
            accepted: false,
            reason: 'below_min_tokens',
            metrics,
            validationMode: validation.mode,
            threshold: validation.threshold,
        };
    }

    return {
        accepted: true,
        reason: 'accepted',
        metrics,
        validationMode: validation.mode,
        threshold: validation.threshold,
    };
}

module.exports = {
    validateRunConfig,
    validateAcceptedText,
};
