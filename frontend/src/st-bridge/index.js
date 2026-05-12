// st-bridge/index.js
// The single public barrel for SillyTavern integration. This is the only
// st-bridge file that code outside `st-bridge/` is allowed to import.
//
// Architectural contract:
//   - All `window.SillyTavern`, jQuery, ST event-name literal, and
//     ST-specific DOM selector access lives in modules under `st-bridge/`.
//   - Outside the bridge, every consumer imports from this file (or uses the
//     `stPort` instance returned by `createStPort()`).
//   - Surface area is fixed by `port.js` (ST_PORT_METHOD_ALLOWLIST) and the
//     re-exports below; both are enforced by `st-bridge-boundary.test.mjs`.
//
// Normal accepted-output projection appends directly to the live target turn,
// saves once, and refreshes ST swipe controls behind this barrel. Full reloads
// and foreground `saveReply({type:'swipe'})` are not normal render paths.

import { createStructuredError, normalizeStructuredError } from '../retry-error.js';
import { t } from '../i18n.js';
import { createArmCaptureSession } from './capture.js';
import { waitForNativeCompletion } from './lifecycle.js';
import { createSessionLockdown } from './lockdown.js';
import { createChatReconciler } from './reconciler.js';
import { createTargetMutationGuard } from './target-mutation.js';
import {
    getCapabilityReport,
    getChatIdentity,
    getContext,
    showToast,
} from './internal/ctx.js';
import { isSameChat } from './inspect.js';

// ---------- Public re-exports (bridge-owned helpers) ----------
//
// Kept at the top of the barrel so consumers can do
// `import { getChatIdentity, showToast } from '../st-bridge/index.js'`.
// The boundary test forbids importing these symbols from anywhere else.

export {
    getContext,
    getChatIdentity,
    getEventTypes,
    getEventSource,
    getCurrentChatArray,
    getUserMessageIndexFromEvent,
    subscribeEvent,
    payloadHasRequiredKeys,
    clonePayload,
    showToast,
    focusPanelDrawer,
    registerSlashCommand,
    runDryRunProbe,
    getCapabilityReport,
} from './internal/ctx.js';

export {
    buildFingerprint,
    confirmTargetTurn,
    getAssistantMessageAt,
    isSameChat,
    markInternalChatReload,
    clearInternalChatReloadMarker,
    wasInternalChatReloadRecentlyTriggered,
    normalizeRequestType,
    reloadCurrentChatSafe,
} from './inspect.js';

export { createArmCaptureSession } from './capture.js';
export { waitForNativeCompletion } from './lifecycle.js';
export {
    applyAcceptedOutput,
    finishTerminalUi,
    reloadSessionUi,
    assistantTargetMatches,
} from './write.js';
export {
    createSessionLockdown,
    wouldLastMessageRightSwipeCauseGeneration,
} from './lockdown.js';
export { createChatReconciler } from './reconciler.js';
export { createTargetMutationGuard } from './target-mutation.js';
export { ST_PORT_METHOD_ALLOWLIST } from './port.js';

// ---------- StPort factory ----------
//
// Replaces the former `createStPort()` export from `frontend/src/st-adapter.js`.
// The factory composes capture + native-observation + lockdown + reconciler
// behind one stable surface; consumers inject their own callbacks for capture
// outcomes and native-completion outcomes.

export function createStPort({
    onCapture,
    onCaptureCancelled,
    onCaptureEvent,
    onNativeReady,
    onNativeFailed,
    onNativeEvent,
    onTargetMutation,
    onTargetMutationEvent,
} = {}) {
    let captureSession = null;
    let nativeController = null;
    const sessionLockdown = createSessionLockdown({
        getContext,
        showToast,
        translate: t,
    });
    const reconciler = createChatReconciler();
    const targetMutationGuard = createTargetMutationGuard({
        getContext,
        onMutation: (payload) => onTargetMutation?.(payload),
        onEvent: (event, summary) => onTargetMutationEvent?.(event, summary),
    });

    return {
        reconciler,
        getChatIdentity() {
            return getChatIdentity(getContext());
        },
        isVisible() {
            // Avoid relying on `document.hasFocus()` for mobile/webview return.
            // Some environments report visible while focus is delayed or false,
            // which would strand pending renders and slow polling unnecessarily.
            return document.visibilityState !== 'hidden';
        },
        isStreaming() {
            const context = getContext();
            // Best-effort guard: during native streaming, ST can be rebuilding the same
            // message DOM repeatedly. Applying accepted-output patches mid-stream risks
            // leaving the DOM in a duplicated/fused state on mobile.
            try {
                if (typeof context?.isGenerating === 'function') {
                    return Boolean(context.isGenerating());
                }
            } catch {}
            return Boolean(
                context?.isGenerating
                || context?.generationRunning
                || context?.isGenerationInProgress
                || context?.generationInProgress,
            );
        },
        setLockdown(active) {
            reconciler.setActive(Boolean(active));
            if (active) {
                return sessionLockdown.enable();
            }
            return sessionLockdown.disable();
        },
        lockdownActive() {
            return sessionLockdown.isActive();
        },
        subscribeCapture(payload = {}) {
            stopCaptureSession();
            captureSession = createArmCaptureSession({
                chatIdentity: payload.chatIdentity || getChatIdentity(getContext()),
                onCapture: (result) => onCapture?.(result),
                onCancel: (error) => {
                    onCaptureCancelled?.(normalizeStructuredError(
                        error,
                        'capture_missing_payload',
                        'Retry Mobile could not capture the native request payload.',
                    ));
                },
                onEvent: (event, summary) => onCaptureEvent?.(event, summary),
            });
        },
        unsubscribeCapture() {
            stopCaptureSession();
        },
        subscribeNativeObserver(payload = {}) {
            stopNativeObserver();
            nativeController = new AbortController();
            void observeNative(payload, nativeController.signal);
        },
        unsubscribeNativeObserver() {
            stopNativeObserver();
        },
        async guardedReload(signal) {
            return reconciler.guardedReload?.(signal);
        },
        setGeneratingIndicator(targetChat) {
            const context = getContext();
            if (!context || !isSameChat(targetChat, getChatIdentity(context))) {
                return false;
            }

            context.deactivateSendButtons?.();
            context.swipe?.refresh?.(true);
            return true;
        },
        clearGeneratingIndicator(targetChat) {
            const context = getContext();
            if (!context || !isSameChat(targetChat, getChatIdentity(context))) {
                return false;
            }

            context.activateSendButtons?.();
            context.swipe?.refresh?.(true);
            return true;
        },
        watchTargetMutation(status) {
            return targetMutationGuard.watch(status);
        },
        clearTargetMutationWatch() {
            targetMutationGuard.clear();
        },
    };

    async function observeNative(payload, signal) {
        if (!payload?.fingerprint) {
            onNativeEvent?.(
                'native_observer_skipped_missing_fingerprint',
                'Retry Mobile skipped native observation because no capture fingerprint was provided.',
            );
            return;
        }

        try {
            const result = await waitForNativeCompletion({
                fingerprint: payload.fingerprint,
                nativeGraceSeconds: payload.nativeGraceSeconds,
                attemptTimeoutSeconds: payload.attemptTimeoutSeconds,
                signal,
                onEvent: (event, summary) => onNativeEvent?.(event, summary),
            });
            if (signal.aborted) {
                return;
            }

            if (result?.outcome === 'succeeded') {
                onNativeReady?.(result);
                return;
            }

            if (result?.outcome === 'timed_out') {
                onNativeFailed?.(createStructuredError(
                    'native_attempt_timeout',
                    result?.message || 'Retry Mobile stopped waiting for the native attempt because it exceeded the configured attempt timeout.',
                    result?.detail || '',
                ));
                return;
            }

            onNativeFailed?.(createStructuredError(
                result?.reason || 'native_wait_timeout',
                result?.message || 'Retry Mobile could not confirm the native assistant turn.',
                result?.detail || '',
            ));
        } catch (error) {
            if (signal.aborted) {
                return;
            }
            onNativeFailed?.(normalizeStructuredError(error, 'native_wait_timeout'));
        }
    }

    function stopCaptureSession() {
        if (captureSession?.stop) {
            captureSession.stop();
        }
        captureSession = null;
    }

    function stopNativeObserver() {
        if (nativeController) {
            nativeController.abort();
        }
        nativeController = null;
    }
}
