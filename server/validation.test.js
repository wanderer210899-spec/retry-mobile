const test = require('node:test');
const assert = require('node:assert/strict');

const {
    TOKEN_COUNT_SOURCE,
    VALIDATION_MODE,
    validateAcceptedText,
    validateRunConfig,
} = require('./validation');

test('token validation prefers the tokenizer-backed counter when one is available', async () => {
    const validation = await validateAcceptedText('This response is long enough to count.', {
        validationMode: VALIDATION_MODE.TOKENS,
        minTokens: 5,
        attemptTimeoutSeconds: 30,
        allowHeuristicTokenFallback: false,
    }, {
        countTokens: async () => ({
            ok: true,
            tokenCount: 7,
            source: 'sillytavern_tiktoken',
            tokenizerModel: 'gpt-4o',
        }),
    });

    assert.equal(validation.accepted, true);
    assert.equal(validation.reason, 'accepted');
    assert.equal(validation.metrics.tokenCount, 7);
    assert.equal(validation.metrics.tokenCountSource, 'sillytavern_tiktoken');
    assert.equal(validation.metrics.tokenizerModel, 'gpt-4o');
    assert.equal(validation.metrics.tokenCountFallbackUsed, false);
});

test('token validation fails closed when tokenizer counting is unavailable and fallback is disabled', async () => {
    const validation = await validateAcceptedText('This response cannot be verified.', {
        validationMode: VALIDATION_MODE.TOKENS,
        minTokens: 5,
        attemptTimeoutSeconds: 30,
        allowHeuristicTokenFallback: false,
    }, {
        countTokens: async () => {
            throw new Error('Tokenizer cache not ready.');
        },
    });

    assert.equal(validation.accepted, false);
    assert.equal(validation.reason, 'tokenizer_unavailable');
    assert.equal(validation.metrics.tokenCount, null);
    assert.equal(validation.metrics.tokenCountSource, TOKEN_COUNT_SOURCE.UNAVAILABLE);
    assert.match(validation.metrics.tokenCountDetail, /Tokenizer cache not ready/u);
});

test('token validation can fall back to heuristic counting when explicitly allowed', async () => {
    const validation = await validateAcceptedText('three useful words', {
        validationMode: VALIDATION_MODE.TOKENS,
        minTokens: 3,
        attemptTimeoutSeconds: 30,
        allowHeuristicTokenFallback: true,
    }, {
        countTokens: async () => ({
            ok: false,
            detail: 'SillyTavern tokenizer helper is unavailable.',
            tokenizerModel: 'gpt-4o',
        }),
    });

    assert.equal(validation.accepted, true);
    assert.equal(validation.reason, 'accepted');
    assert.equal(validation.metrics.tokenCount, 3);
    assert.equal(validation.metrics.tokenCountSource, TOKEN_COUNT_SOURCE.HEURISTIC_FALLBACK);
    assert.equal(validation.metrics.tokenizerModel, 'gpt-4o');
    assert.equal(validation.metrics.tokenCountFallbackUsed, true);
    assert.match(validation.metrics.tokenCountDetail, /unavailable/u);
});

test('character validation keeps token metrics explicitly non-blocking', async () => {
    const validation = await validateAcceptedText('abcde', {
        validationMode: VALIDATION_MODE.CHARACTERS,
        minCharacters: 3,
        attemptTimeoutSeconds: 30,
    });

    assert.equal(validation.accepted, true);
    assert.equal(validation.metrics.characterCount, 5);
    assert.equal(validation.metrics.tokenCount, 1);
    assert.equal(validation.metrics.tokenCountSource, TOKEN_COUNT_SOURCE.HEURISTIC_NONBLOCKING);
});

test('run config fails closed when maximum attempts is lower than the accepted outputs goal', () => {
    const validation = validateRunConfig({
        targetAcceptedCount: 3,
        maxAttempts: 1,
        attemptTimeoutSeconds: 30,
        validationMode: VALIDATION_MODE.CHARACTERS,
        minCharacters: 1,
    });

    assert.equal(validation.ok, false);
    assert.equal(validation.code, 'validation_config_invalid');
    assert.equal(validation.message, 'Maximum attempts must be at least as large as the accepted outputs goal.');
});
