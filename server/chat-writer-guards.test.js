const test = require('node:test');
const assert = require('node:assert/strict');

const {
    assertWritePathReady,
    shouldUseConfirmedWriteSafetyRecheck,
} = require('./chat-writer');

test('write path is blocked while native persistence confirmation is still in flight', () => {
    assert.throws(() => {
        assertWritePathReady({
            nativeState: 'pending',
            phase: 'native_confirming_persisted',
            nativeResolutionInProgress: true,
        });
    }, /still in progress/i);
});

test('write path is allowed once native confirmation is resolved and inspection is idle', () => {
    assert.doesNotThrow(() => {
        assertWritePathReady({
            nativeState: 'confirmed',
            phase: 'native_confirmed',
            nativeResolutionInProgress: false,
        });
    });
});

test('confirmed write safety recheck can only fire once and only for confirmed state gaps', () => {
    const missingAssistantError = {
        code: 'backend_turn_missing',
    };

    assert.equal(shouldUseConfirmedWriteSafetyRecheck({
        nativeState: 'confirmed',
        phase: 'native_confirmed',
        nativeResolutionInProgress: false,
    }, false, missingAssistantError), true);

    assert.equal(shouldUseConfirmedWriteSafetyRecheck({
        nativeState: 'confirmed',
        phase: 'native_confirmed',
        nativeResolutionInProgress: false,
    }, true, missingAssistantError), false);

    assert.equal(shouldUseConfirmedWriteSafetyRecheck({
        nativeState: 'abandoned',
        phase: 'native_abandoned',
        nativeResolutionInProgress: false,
    }, false, missingAssistantError), false);
});
