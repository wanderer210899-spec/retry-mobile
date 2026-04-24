import { createStructuredError, normalizeStructuredError } from './retry-error.js';
import { createArmCaptureSession } from './st-capture.js';
import { getChatIdentity, getContext, showToast } from './st-context.js';
import { waitForNativeCompletion } from './st-lifecycle.js';
import { isSameChat } from './st-chat.js';
import { applyAcceptedOutput, finishTerminalUi, reloadSessionUi } from './render/st-operations.js';

export function normalizePendingVisibleRender(renderPayload) {
    if (!renderPayload) {
        return { type: 'none', payload: null };
    }

    const terminalOutcome = resolveTerminalOutcome(renderPayload);
    if (terminalOutcome) {
        return {
            type: 'terminal',
            payload: {
                ...cloneValue(renderPayload),
                outcome: terminalOutcome,
            },
        };
    }

    return {
        type: 'accepted_output',
        payload: cloneValue(renderPayload),
    };
}

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

    return {
        getChatIdentity() {
            return getChatIdentity(getContext());
        },
        isVisible() {
            return document.visibilityState !== 'hidden' && document.hasFocus();
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
        async applyAcceptedOutput(renderPayload) {
            return applyAcceptedOutput(renderPayload);
        },
        async guardedReload(signal) {
            return reloadSessionUi(signal);
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
            if (!context) {
                return false;
            }

            context.activateSendButtons?.();
            context.swipe?.refresh?.(true);
            return true;
        },
        queueVisibleRender(renderPayload) {
            return cloneValue(renderPayload);
        },
        async flushPendingVisibleRender(renderPayload) {
            const normalized = normalizePendingVisibleRender(renderPayload);
            if (normalized.type === 'none') {
                return { ok: false };
            }

            if (normalized.type === 'terminal') {
                return finishTerminalUi(normalized.payload);
            }

            return applyAcceptedOutput(normalized.payload);
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

function cloneValue(value) {
    if (value == null) {
        return value ?? null;
    }

    if (typeof globalThis.structuredClone === 'function') {
        return globalThis.structuredClone(value);
    }

    return JSON.parse(JSON.stringify(value));
}

function resolveTerminalOutcome(renderPayload) {
    const outcome = String(renderPayload?.outcome || renderPayload?.terminalOutcome || '').trim();
    if (outcome === 'completed' || outcome === 'failed' || outcome === 'cancelled') {
        return outcome;
    }

    if (renderPayload?.kind === 'terminal') {
        return 'completed';
    }

    return '';
}
