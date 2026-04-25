import { formatStructuredError } from '../retry-error.js';
import { formatVisibleStateLabel } from '../core/run-state.js';
import { t } from '../i18n.js';

export function deriveUiState(context, runtime) {
    const phase = context?.state || 'idle';
    const activeStatus = runtime?.activeJobStatus || context?.lastTerminalResult?.status || null;
    const transport = resolveTransportState(runtime, context, phase);
    const toastDerivation = deriveToasts(phase, activeStatus, context?.toastScope || null);

    if (globalThis?.__RM_DEV__ && phase === 'running' && context?.terminalError) {
        throw new Error('[INVARIANT] terminalError in running state — this is a bug in the FSM transition, not a backend error');
    }

    const selectedError = selectUiError({
        phase,
        context,
        runtime,
    });
    const runErrorToasts = deriveRunErrorToasts(phase, context?.runError || null, toastDerivation.nextToastScope);
    const combinedToasts = [...toastDerivation.toastsToFire, ...runErrorToasts.toastsToFire];
    const nextToastScope = runErrorToasts.nextToastScope;

    const errorText = selectedError ? formatStructuredError(selectedError) : '';

    const uiState = {
        phase,
        activeStatus,
        transport,
        statusLabel: formatVisibleStateLabel(phase, activeStatus, transport),
        error: selectedError,
        errorText,
        errorVisible: shouldShowError(phase, selectedError),
        toastsToFire: combinedToasts,
        nextToastScope,
    };
    assertNoRawKeys(uiState);
    return Object.freeze(uiState);
}

function selectUiError({ phase, context, runtime }) {
    if (phase === 'running') {
        return context?.runError || null;
    }
    return runtime?.controlError || context?.terminalError || null;
}

function shouldShowError(phase, error) {
    if (!error) {
        return false;
    }
    if (phase !== 'running') {
        return true;
    }
    return error?.code === 'render_apply_failed';
}

function resolveTransportState(runtime, context, phase) {
    const code = String(runtime?.controlError?.code || context?.runError?.code || '').trim();
    if (phase === 'running' && (code === 'handoff_request_failed' || code === 'polling_transport_unavailable')) {
        return 'degraded';
    }
    return 'healthy';
}

function deriveToasts(phase, status, toastScope) {
    if (!status || typeof status !== 'object') {
        return {
            toastsToFire: [],
            nextToastScope: toastScope || null,
        };
    }

    const jobId = String(status.jobId || toastScope?.jobId || '').trim() || null;
    let nextScope = {
        jobId,
        lastAttemptCount: numberOrNull(toastScope?.lastAttemptCount),
        lastAcceptedCount: numberOrNull(toastScope?.lastAcceptedCount),
        lastTerminalState: stringOrNull(toastScope?.lastTerminalState) || null,
        lastNativePendingToast: Boolean(toastScope?.lastNativePendingToast),
        lastRunErrorKey: stringOrNull(toastScope?.lastRunErrorKey) || null,
    };
    const toastsToFire = [];
    const state = String(status.state || '').trim();
    const nativeState = String(status.nativeState || '').trim();
    const attemptCount = numberOrNull(status.attemptCount);
    const maxAttempts = numberOrNull(status.maxAttempts);
    const acceptedCount = numberOrNull(status.acceptedCount);
    const targetAcceptedCount = numberOrNull(status.targetAcceptedCount);

    if (phase === 'running' && state === 'running') {
        if (nativeState === 'pending') {
            if (!nextScope.lastNativePendingToast) {
                toastsToFire.push({ kind: 'info', title: t('toasts.title'), message: t('toasts.nativeGenerating') });
                nextScope.lastNativePendingToast = true;
            }
        } else if (nextScope.lastNativePendingToast) {
            nextScope.lastNativePendingToast = false;
        }

        if (nativeState !== 'pending'
            && attemptCount != null
            && maxAttempts != null
            && attemptCount > 0
            && nextScope.lastAttemptCount !== attemptCount) {
            toastsToFire.push({
                kind: 'info',
                title: t('toasts.title'),
                message: t('toasts.retryAttempt', { attempt: attemptCount, max: maxAttempts }),
            });
            nextScope.lastAttemptCount = attemptCount;
        }

        if (acceptedCount != null
            && targetAcceptedCount != null
            && acceptedCount > 0
            && nextScope.lastAcceptedCount !== acceptedCount) {
            toastsToFire.push({
                kind: 'success',
                title: t('toasts.title'),
                message: t('toasts.acceptedProgress', { accepted: acceptedCount, target: targetAcceptedCount }),
            });
            nextScope.lastAcceptedCount = acceptedCount;
        }
        return { toastsToFire, nextToastScope: nextScope };
    }

    if (state === 'completed' || state === 'failed' || state === 'cancelled') {
        if (nextScope.lastTerminalState !== state) {
            nextScope.lastTerminalState = state;
            const summaryParts = [];
            if (acceptedCount != null && targetAcceptedCount != null) {
                summaryParts.push(`${acceptedCount}/${targetAcceptedCount} accepted`);
            }
            if (attemptCount != null && maxAttempts != null) {
                summaryParts.push(`${attemptCount}/${maxAttempts} attempts`);
            }
            const summary = summaryParts.length ? ` (${summaryParts.join(', ')})` : '';
            if (state === 'completed') {
                toastsToFire.push({ kind: 'success', title: t('toasts.title'), message: t('toasts.jobComplete', { summary }) });
            } else if (state === 'cancelled') {
                toastsToFire.push({ kind: 'warning', title: t('toasts.title'), message: t('toasts.jobCancelled', { summary }) });
            } else {
                const message = status?.structuredError?.message
                    || status?.lastError
                    || t('toasts.jobFailedFallback');
                toastsToFire.push({ kind: 'error', title: t('toasts.title'), message: `${message}${summary}` });
            }
        }
    }

    return { toastsToFire, nextToastScope: nextScope };
}

function deriveRunErrorToasts(phase, runError, toastScope) {
    if (phase !== 'running' || !runError || runError.code === 'render_apply_failed') {
        return {
            toastsToFire: [],
            nextToastScope: toastScope,
        };
    }
    const runErrorKey = `${String(runError.code || '')}:${String(runError.message || '')}:${String(runError.detail || '')}`;
    if (toastScope?.lastRunErrorKey === runErrorKey) {
        return {
            toastsToFire: [],
            nextToastScope: toastScope,
        };
    }
    return {
        toastsToFire: [{
            kind: 'warning',
            title: t('toasts.title'),
            message: formatStructuredError(runError),
        }],
        nextToastScope: {
            ...(toastScope || {}),
            lastRunErrorKey: runErrorKey,
        },
    };
}

function assertNoRawKeys(uiState) {
    if (!globalThis?.__RM_DEV__) {
        return;
    }
    for (const key of Object.keys(uiState)) {
        if (key.startsWith('_raw')) {
            throw new Error(`[INVARIANT] UiState key '${key}' leaks raw data into render projection`);
        }
    }
}

function numberOrNull(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
}

function stringOrNull(value) {
    if (typeof value !== 'string') {
        return null;
    }
    const normalized = value.trim();
    return normalized || null;
}
