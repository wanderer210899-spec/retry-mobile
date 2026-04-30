import { createStructuredError, normalizeStructuredError } from './retry-error.js';
import { createArmCaptureSession } from './st-capture.js';
import { getChatIdentity, getContext, showToast } from './st-context.js';
import { waitForNativeCompletion } from './st-lifecycle.js';
import { isSameChat } from './st-chat.js';
import { t } from './i18n.js';
import { createSessionLockdown } from './ui/session-lockdown.js';
import { createChatReconciler } from './render/reconciler.js';

export function createStPort({
    onCapture,
    onCaptureCancelled,
    onCaptureEvent,
    onNativeReady,
    onNativeFailed,
    onNativeEvent,
} = {}) {
    let captureSession = null;
    let nativeController = null;
    const sessionLockdown = createSessionLockdown({
        getContext,
        showToast,
        translate: t,
    });
    const reconciler = createChatReconciler();

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
        notifyToast(kind, title, message) {
            showToast(kind, title, message);
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
