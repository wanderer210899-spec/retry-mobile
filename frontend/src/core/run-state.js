import { RUN_STATE } from '../constants.js';

export function resolveRunStateFromStatus(status) {
    if (!status || status.state !== 'running') {
        return null;
    }

    if (status.nativeState === 'pending') {
        return RUN_STATE.CAPTURED_PENDING_NATIVE;
    }

    if (status.nativeState === 'confirmed') {
        return Number(status.attemptCount) > 0 || Number(status.acceptedCount) > 0
            ? RUN_STATE.BACKEND_RUNNING
            : RUN_STATE.NATIVE_CONFIRMED;
    }

    if (status.nativeState === 'abandoned') {
        return Number(status.attemptCount) > 0 || Number(status.acceptedCount) > 0
            ? RUN_STATE.BACKEND_RUNNING
            : RUN_STATE.NATIVE_ABANDONED;
    }

    return RUN_STATE.BACKEND_RUNNING;
}

export function formatStateLabel(state) {
    switch (state) {
        case RUN_STATE.ARMED:
            return 'Armed for next qualifying request';
        case RUN_STATE.CAPTURED_PENDING_NATIVE:
            return 'Waiting for native first reply';
        case RUN_STATE.NATIVE_CONFIRMED:
            return 'Native first reply confirmed';
        case RUN_STATE.NATIVE_ABANDONED:
            return 'Native abandoned, backend recovered the turn';
        case RUN_STATE.BACKEND_RUNNING:
            return 'Retry loop active';
        case RUN_STATE.COMPLETED:
            return 'Completed';
        case RUN_STATE.FAILED:
            return 'Failed';
        case RUN_STATE.CANCELLED:
            return 'Cancelled';
        default:
            return 'Idle';
    }
}

export function formatVisibleStateLabel(state, status) {
    if (!status) {
        return formatStateLabel(state);
    }

    switch (state) {
        case RUN_STATE.CAPTURED_PENDING_NATIVE:
        case RUN_STATE.NATIVE_CONFIRMED:
        case RUN_STATE.NATIVE_ABANDONED:
        case RUN_STATE.BACKEND_RUNNING:
            return status.phaseText || formatStateLabel(state);
        case RUN_STATE.COMPLETED:
            return status.state === 'completed'
                ? (status.phaseText || formatStateLabel(state))
                : formatStateLabel(state);
        case RUN_STATE.FAILED:
            return status.state === 'failed'
                ? (status.phaseText || formatStateLabel(state))
                : formatStateLabel(state);
        case RUN_STATE.CANCELLED:
            return status.state === 'cancelled'
                ? (status.phaseText || formatStateLabel(state))
                : formatStateLabel(state);
        default:
            return formatStateLabel(state);
    }
}

export function isRunningLikeState(state) {
    return state === RUN_STATE.ARMED
        || state === RUN_STATE.CAPTURED_PENDING_NATIVE
        || state === RUN_STATE.NATIVE_CONFIRMED
        || state === RUN_STATE.NATIVE_ABANDONED
        || state === RUN_STATE.BACKEND_RUNNING;
}
