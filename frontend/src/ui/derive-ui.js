import { formatStructuredError } from '../retry-error.js';
import { formatStateLabel, formatVisibleStateLabel } from '../core/run-state.js';
import { t } from '../i18n.js';

export function deriveUiState(context, runtime) {
    const phase = context?.state || 'idle';
    // `activeStatus` drives the stats card and visible label and must reflect
    // only the *current* phase. ARMED/CAPTURING are user-facing "fresh" states
    // and must not project any prior terminal numbers; RUNNING uses the live
    // backend cache; IDLE may surface the last terminal snapshot for display.
    const { activeStatus, toastStatus, terminalKind } = resolveCanonicalStatus(phase, context, runtime);
    const transport = resolveTransportState(runtime, context, phase);
    const toastDerivation = deriveToasts(phase, toastStatus, terminalKind, context?.toastScope || null);

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

    const statusPillState = resolveStatusPillState(phase, context);

    const uiState = {
        phase,
        statusPillState,
        activeStatus,
        transport,
        statusLabel: resolveStatusLabel(phase, activeStatus, transport, context, runtime),
        error: selectedError,
        errorText,
        errorVisible: shouldShowError(phase, selectedError),
        toastsToFire: combinedToasts,
        nextToastScope,
    };
    assertNoRawKeys(uiState);
    return Object.freeze(uiState);
}

function resolveStatusPillState(phase, context) {
    if (phase !== 'idle' && phase !== 'armed') {
        return phase;
    }

    const terminal = context?.lastTerminalResult || null;
    const outcome = String(terminal?.outcome || '').trim();
    const terminalState = String(terminal?.status?.state || '').trim();

    if (phase === 'armed') {
        // In ARMED state, only project 'completed' (green) from the last run so
        // the color reads as "success + ready for more". Failed/cancelled outcomes
        // keep the pill at 'armed' (yellow) — the pill reflects the *current*
        // ready-to-capture state, not a past failure. The status label carries the
        // "last run failed / was cancelled" distinction instead.
        if (outcome === 'completed' || terminalState === 'completed') {
            return 'completed';
        }
        return phase;
    }

    // IDLE: project the terminal outcome directly.
    if (outcome === 'completed' || outcome === 'failed' || outcome === 'cancelled') {
        return outcome;
    }
    if (terminalState === 'completed' || terminalState === 'failed' || terminalState === 'cancelled') {
        return terminalState;
    }

    return phase;
}

function resolveStatusLabel(phase, activeStatus, transport, context, runtime) {
    if (phase === 'armed') {
        const terminal = context?.lastTerminalResult || null;
        const terminalOutcome = String(terminal?.outcome || '').trim();
        const terminalState = String(terminal?.status?.state || '').trim();
        const terminalJobId = String(
            terminal?.jobId
            || terminal?.status?.jobId
            || context?.toastScope?.jobId
            || runtime?.activeJobStatus?.jobId
            || '',
        ).trim();
        // UX: after an auto-rearm completion we want explicit confirmation that
        // the plugin is *still armed* and the last run completed successfully.
        if ((terminalOutcome === 'completed' || terminalState === 'completed') && terminalJobId) {
            return formatStateLabel('armed_after_completed');
        }
        if ((terminalOutcome === 'failed' || terminalState === 'failed') && terminalJobId) {
            return formatStateLabel('armed_after_failed');
        }
        if ((terminalOutcome === 'cancelled' || terminalState === 'cancelled') && terminalJobId) {
            return formatStateLabel('armed_after_cancelled');
        }
    }
    return formatVisibleStateLabel(phase, activeStatus, transport);
}

function resolveCanonicalStatus(phase, context, runtime) {
    if (phase === 'running') {
        // With ingest in place, FSM jobId and runtime jobId should always agree.
        // Guard retained as a dev-mode invariant; safe null-return in production.
        const fsmJobId = String(context?.jobId || '').trim();
        const runtimeJobId = String(runtime?.activeJobStatus?.jobId || '').trim();
        if (fsmJobId && runtimeJobId && fsmJobId !== runtimeJobId) {
            if (globalThis?.__RM_DEV__) {
                throw new Error(`[INVARIANT] FSM jobId ${fsmJobId} !== runtime jobId ${runtimeJobId}`);
            }
            return { activeStatus: null, toastStatus: null, terminalKind: null };
        }
        const status = runtime?.activeJobStatus || null;
        return { activeStatus: status, toastStatus: status, terminalKind: null };
    }

    const terminalResult = context?.lastTerminalResult || null;
    const terminalStatus = terminalResult?.status || null;
    const terminalKind = terminalResult?.kind || null;

    if (phase === 'idle') {
        // After Stop / no-rearm completion, surface the live mirror if present,
        // falling back to the terminal snapshot for display only.
        return {
            activeStatus: runtime?.activeJobStatus || terminalStatus,
            toastStatus: terminalStatus,
            terminalKind,
        };
    }

    // ARMED / CAPTURING: show clean defaults; never project a previous run's
    // counts into them. Toasts still fire from the terminal snapshot.
    return { activeStatus: null, toastStatus: terminalStatus, terminalKind };
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

function deriveToasts(phase, status, terminalKind, toastScope) {
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
        const kind = String(terminalKind || (state === 'completed' ? 'completed' : state));
        const terminalKey = `${state}:${kind}`;
        if (nextScope.lastTerminalState !== terminalKey) {
            nextScope.lastTerminalState = terminalKey;
            const summaryParts = [];
            if (acceptedCount != null && targetAcceptedCount != null) {
                summaryParts.push(`${acceptedCount}/${targetAcceptedCount} accepted`);
            }
            if (attemptCount != null && maxAttempts != null) {
                summaryParts.push(`${attemptCount}/${maxAttempts} attempts`);
            }
            const summary = summaryParts.length ? ` (${summaryParts.join(', ')})` : '';
            if (state === 'completed') {
                if (kind === 'native_accepted') {
                    toastsToFire.push({ kind: 'success', title: t('toasts.title'), message: t('toasts.nativeAccepted') });
                } else {
                    toastsToFire.push({ kind: 'success', title: t('toasts.title'), message: t('toasts.jobComplete', { summary }) });
                }
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
