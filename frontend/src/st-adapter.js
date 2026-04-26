import { createStructuredError, normalizeStructuredError } from './retry-error.js';
import { createArmCaptureSession } from './st-capture.js';
import { getChatIdentity, getContext, getEventTypes, showToast, subscribeEvent } from './st-context.js';
import { waitForNativeCompletion } from './st-lifecycle.js';
import { isSameChat } from './st-chat.js';
import { applyAcceptedOutput, reloadSessionUi } from './render/st-operations.js';
import { t } from './i18n.js';

export function normalizePendingVisibleRender(renderPayload) {
    if (!renderPayload) {
        return { type: 'none', payload: null };
    }

    const normalizedPayload = cloneValue(renderPayload) || {};
    delete normalizedPayload.terminalOutcome;
    delete normalizedPayload.outcome;
    if (normalizedPayload.kind === 'terminal') {
        normalizedPayload.kind = 'accepted_output';
    }

    return {
        type: 'accepted_output',
        payload: normalizedPayload,
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
    let interactionGuard = null;
    let tapHijack = null;
    let lastInteractionToastAt = 0;
    let sendBusyOriginalIconClasses = null;

    return {
        getChatIdentity() {
            return getChatIdentity(getContext());
        },
        isVisible() {
            // Avoid relying on `document.hasFocus()` for mobile/webview return.
            // Some environments report visible while focus is delayed or false,
            // which would strand pending renders and slow polling unnecessarily.
            return document.visibilityState !== 'hidden';
        },
        enableInteractionGuard() {
            stopInteractionGuard();
            interactionGuard = startInteractionGuardSession();
        },
        disableInteractionGuard() {
            stopInteractionGuard();
        },
        enableTapHijack() {
            stopTapHijack();
            tapHijack = startTapHijackSession();
        },
        disableTapHijack() {
            stopTapHijack();
        },
        setSendBusy(busy) {
            return setSendButtonBusyVisual(Boolean(busy));
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
            if (!context || !isSameChat(targetChat, getChatIdentity(context))) {
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

            return applyAcceptedOutput(normalized.payload);
        },
        notifyToast(kind, title, message) {
            showToast(kind, title, message);
        },
    };

    function startInteractionGuardSession() {
        const context = getContext();
        const eventTypes = getEventTypes(context);
        const stops = [];
        if (!context || !eventTypes) {
            return { stop() {} };
        }

        const onBlocked = () => {
            // Interaction guard is best-effort and event-driven; keep it silent.
            // User-facing warnings are emitted by the explicit tap hijack.
        };

        const maybeRegister = (name) => {
            const eventName = eventTypes?.[name];
            if (!eventName) {
                return;
            }
            stops.push(subscribeEvent(eventName, (payload) => {
                if (payload?.dryRun === true) {
                    return;
                }
                onBlocked();
            }, context));
        };

        maybeRegister('CHAT_COMPLETION_SETTINGS_READY');
        maybeRegister('TEXT_COMPLETION_SETTINGS_READY');
        maybeRegister('GENERATE_AFTER_DATA');
        maybeRegister('MESSAGE_SENT');

        return {
            stop() {
                stops.splice(0).forEach((stop) => {
                    try {
                        stop();
                    } catch {}
                });
            },
        };
    }

    function startTapHijackSession() {
        const handler = (event) => {
            const target = event?.target;
            const element = target && typeof target === 'object' && 'closest' in target
                ? target
                : null;
            if (!element) {
                return;
            }

            const hitSend = element.closest?.('#send_but');
            const hitSwipeRight = element.closest?.('.last_mes .swipe_right');
            if (!hitSend && !hitSwipeRight) {
                return;
            }

            // Block the native click handlers (jQuery delegates in ST).
            try {
                event.preventDefault?.();
                event.stopImmediatePropagation?.();
                event.stopPropagation?.();
            } catch {}

            // Throttle warnings to avoid spam on repeated taps.
            const now = Date.now();
            if (now - lastInteractionToastAt < 1800) {
                return;
            }
            lastInteractionToastAt = now;
            showToast('warning', t('toasts.title'), t('toasts.interactionBlocked'));
        };

        document.addEventListener?.('click', handler, true);
        return {
            stop() {
                document.removeEventListener?.('click', handler, true);
            },
        };
    }

    function setSendButtonBusyVisual(busy) {
        if (!document?.getElementById) {
            return false;
        }
        const el = document.getElementById('send_but');
        if (!el?.classList) {
            return false;
        }

        if (busy) {
            if (!sendBusyOriginalIconClasses) {
                sendBusyOriginalIconClasses = detectFaIconNameClasses(el);
                if (sendBusyOriginalIconClasses.length === 0) {
                    sendBusyOriginalIconClasses = ['fa-paper-plane'];
                }
            }

            detectFaIconNameClasses(el).forEach((name) => el.classList.remove(name));
            el.classList.add('fa-solid');
            el.classList.add('fa-spinner');
            el.classList.add('fa-spin');
            return true;
        }

        el.classList.remove('fa-spinner');
        el.classList.remove('fa-spin');
        detectFaIconNameClasses(el).forEach((name) => el.classList.remove(name));
        (sendBusyOriginalIconClasses || []).forEach((name) => el.classList.add(name));
        sendBusyOriginalIconClasses = null;
        return true;
    }

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

    function stopTapHijack() {
        if (tapHijack?.stop) {
            tapHijack.stop();
        }
        tapHijack = null;
    }

    function stopInteractionGuard() {
        if (interactionGuard?.stop) {
            interactionGuard.stop();
        }
        interactionGuard = null;
    }
}

function detectFaIconNameClasses(element) {
    const classes = element?.classList ? Array.from(element.classList) : [];
    return classes.filter((name) => (
        name.startsWith('fa-')
        && name !== 'fa-solid'
        && name !== 'fa-regular'
        && name !== 'fa-brands'
        && name !== 'fa-spin'
        && name !== 'fa-spinner'
        && name !== 'fa-lg'
        && name !== 'fa-fw'
        && name !== 'fa-xs'
        && name !== 'fa-sm'
        && name !== 'fa-xl'
        && name !== 'fa-2xl'
        && name !== 'fa-pull-left'
        && name !== 'fa-pull-right'
    ));
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

