function normalizeText(text) {
    return String(text ?? '')
        .replace(/\r\n/g, '\n')
        .trim();
}

const VALIDATION_MODE = Object.freeze({
    CHARACTERS: 'characters',
    TOKENS: 'tokens',
});

const TOKEN_COUNT_SOURCE = Object.freeze({
    EMPTY: 'empty',
    HEURISTIC_FALLBACK: 'heuristic_fallback',
    HEURISTIC_NONBLOCKING: 'heuristic_nonblocking',
    UNAVAILABLE: 'unavailable',
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

async function resolveTokenizerCount(text, options = {}) {
    if (typeof options.countTokens !== 'function') {
        return {
            ok: false,
            tokenCount: null,
            source: TOKEN_COUNT_SOURCE.UNAVAILABLE,
            tokenizerModel: null,
            detail: 'Retry Mobile could not access a tokenizer-backed counter for this validation pass.',
        };
    }

    try {
        const result = await Promise.resolve(options.countTokens(text));
        if (Number.isFinite(Number(result))) {
            return {
                ok: true,
                tokenCount: Number(result),
                source: 'tokenizer_counter',
                tokenizerModel: null,
                detail: '',
            };
        }

        if (result && typeof result === 'object') {
            const tokenCount = Number.isFinite(Number(result.tokenCount))
                ? Number(result.tokenCount)
                : null;
            return {
                ok: result.ok !== false && tokenCount != null,
                tokenCount,
                source: typeof result.source === 'string' && result.source
                    ? result.source
                    : 'tokenizer_counter',
                tokenizerModel: typeof result.tokenizerModel === 'string' && result.tokenizerModel
                    ? result.tokenizerModel
                    : null,
                detail: typeof result.detail === 'string'
                    ? result.detail
                    : '',
            };
        }

        return {
            ok: false,
            tokenCount: null,
            source: TOKEN_COUNT_SOURCE.UNAVAILABLE,
            tokenizerModel: null,
            detail: 'Retry Mobile tokenizer counting returned an invalid result shape.',
        };
    } catch (error) {
        return {
            ok: false,
            tokenCount: null,
            source: TOKEN_COUNT_SOURCE.UNAVAILABLE,
            tokenizerModel: null,
            detail: error instanceof Error ? error.message : String(error),
        };
    }
}

async function resolveTokenMetrics(text, runConfig = {}, validation = {}, options = {}) {
    const heuristicTokenCount = countTokensHeuristic(text);
    if (!text) {
        return {
            tokenCount: 0,
            tokenCountSource: TOKEN_COUNT_SOURCE.EMPTY,
            tokenizerModel: null,
            tokenCountDetail: '',
            tokenCountFallbackUsed: false,
        };
    }

    if (validation.mode !== VALIDATION_MODE.TOKENS) {
        return {
            tokenCount: heuristicTokenCount,
            tokenCountSource: TOKEN_COUNT_SOURCE.HEURISTIC_NONBLOCKING,
            tokenizerModel: null,
            tokenCountDetail: '',
            tokenCountFallbackUsed: false,
        };
    }

    const tokenizerCount = await resolveTokenizerCount(text, options);
    if (tokenizerCount.ok) {
        return {
            tokenCount: tokenizerCount.tokenCount,
            tokenCountSource: tokenizerCount.source,
            tokenizerModel: tokenizerCount.tokenizerModel,
            tokenCountDetail: tokenizerCount.detail || '',
            tokenCountFallbackUsed: false,
        };
    }

    if (runConfig.allowHeuristicTokenFallback === true) {
        return {
            tokenCount: heuristicTokenCount,
            tokenCountSource: TOKEN_COUNT_SOURCE.HEURISTIC_FALLBACK,
            tokenizerModel: tokenizerCount.tokenizerModel,
            tokenCountDetail: tokenizerCount.detail || '',
            tokenCountFallbackUsed: true,
        };
    }

    return {
        tokenCount: null,
        tokenCountSource: TOKEN_COUNT_SOURCE.UNAVAILABLE,
        tokenizerModel: tokenizerCount.tokenizerModel,
        tokenCountDetail: tokenizerCount.detail || '',
        tokenCountFallbackUsed: false,
    };
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

async function validateAcceptedText(text, runConfig = {}, options = {}) {
    const normalized = normalizeText(text);
    const validation = getValidationThreshold(runConfig);
    const tokenMetrics = await resolveTokenMetrics(normalized, runConfig, validation, options);
    const metrics = {
        text: normalized,
        characterCount: countCharacters(normalized),
        tokenCount: tokenMetrics.tokenCount,
        tokenCountSource: tokenMetrics.tokenCountSource,
        tokenizerModel: tokenMetrics.tokenizerModel,
        tokenCountDetail: tokenMetrics.tokenCountDetail,
        tokenCountFallbackUsed: tokenMetrics.tokenCountFallbackUsed,
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

    if (validation.mode === VALIDATION_MODE.TOKENS && validation.threshold > 0 && metrics.tokenCount == null) {
        return {
            accepted: false,
            reason: 'tokenizer_unavailable',
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
    TOKEN_COUNT_SOURCE,
    VALIDATION_MODE,
    countTokensHeuristic,
    validateRunConfig,
    validateAcceptedText,
};
