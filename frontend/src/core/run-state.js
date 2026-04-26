import { t } from '../i18n.js';

const STATE_LABELS = Object.freeze({
    armed: 'runState.armed',
    armed_after_completed: 'runState.armedAfterCompleted',
    capturing: 'runState.capturing',
    reserving: 'runState.reserving',
    waiting_native: 'runState.waiting_native',
    running: 'runState.running',
    backend_running: 'runState.backend_running',
    stopping: 'runState.stopping',
    completing: 'runState.completing',
    recovering: 'runState.recovering',
    completed: 'runState.completed',
    failed: 'runState.failed',
    cancelled: 'runState.cancelled',
    captured_pending_native: 'runState.captured_pending_native',
    native_confirmed: 'runState.native_confirmed',
    native_abandoned: 'runState.native_abandoned',
});

export function resolveRunStateFromStatus(status) {
    if (!status || status.state !== 'running') {
        return null;
    }

    if (status.nativeState === 'pending') {
        return 'captured_pending_native';
    }

    if (status.nativeState === 'confirmed') {
        return Number(status.attemptCount) > 0 || Number(status.acceptedCount) > 0
            ? 'backend_running'
            : 'native_confirmed';
    }

    if (status.nativeState === 'abandoned') {
        return Number(status.attemptCount) > 0 || Number(status.acceptedCount) > 0
            ? 'backend_running'
            : 'native_abandoned';
    }

    return 'backend_running';
}

export function formatStateLabel(state) {
    const key = STATE_LABELS[String(state || '').trim()] || 'runState.idle';
    return t(key);
}

export function formatVisibleStateLabel(state, status, transport = 'healthy') {
    if (state === 'capturing') {
        return formatStateLabel(state);
    }

    if ((state === 'recovering' || state === 'running' || state === 'backend_running')
        && transport !== 'healthy') {
        return t('runState.reconnecting');
    }

    if (state === 'recovering' && !status) {
        return t('runState.reattaching');
    }

    if (!status) {
        return formatStateLabel(state);
    }

    switch (state) {
        case 'reserving':
        case 'waiting_native':
        case 'running':
        case 'backend_running':
        case 'stopping':
        case 'recovering':
        case 'captured_pending_native':
        case 'native_confirmed':
        case 'native_abandoned':
            return status.phaseText || formatStateLabel(state);
        case 'completed':
        case 'failed':
        case 'cancelled':
            return status.state === state
                ? (status.phaseText || formatStateLabel(state))
                : formatStateLabel(state);
        default:
            return formatStateLabel(state);
    }
}

export function isRunningLikeState(state) {
    return state === 'armed'
        || state === 'capturing'
        || state === 'running'
        || state === 'reserving'
        || state === 'waiting_native'
        || state === 'backend_running'
        || state === 'stopping'
        || state === 'recovering'
        || state === 'completing'
        || state === 'captured_pending_native'
        || state === 'native_confirmed'
        || state === 'native_abandoned';
}
