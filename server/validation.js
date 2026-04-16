function normalizeText(text) {
    return String(text ?? '')
        .replace(/\r\n/g, '\n')
        .trim();
}

function countWords(text) {
    const matches = normalizeText(text).match(
        /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu,
    );
    return matches ? matches.length : 0;
}

function countTokensHeuristic(text) {
    const normalized = normalizeText(text);
    if (!normalized) {
        return 0;
    }

    const matches = normalized.match(/[A-Za-z0-9_]+|[^\s]/g);
    return matches ? matches.length : 0;
}

function validateAcceptedText(text, runConfig = {}) {
    const normalized = normalizeText(text);
    const metrics = {
        text: normalized,
        wordCount: countWords(normalized),
        tokenCount: countTokensHeuristic(normalized),
    };

    if (!normalized) {
        return {
            accepted: false,
            reason: 'empty',
            metrics,
        };
    }

    if (Number(runConfig.minWords) > 0 && metrics.wordCount < Number(runConfig.minWords)) {
        return {
            accepted: false,
            reason: 'below_min_words',
            metrics,
        };
    }

    if (Number(runConfig.minTokens) > 0 && metrics.tokenCount < Number(runConfig.minTokens)) {
        return {
            accepted: false,
            reason: 'below_min_tokens',
            metrics,
        };
    }

    return {
        accepted: true,
        reason: 'accepted',
        metrics,
    };
}

module.exports = {
    validateAcceptedText,
};
