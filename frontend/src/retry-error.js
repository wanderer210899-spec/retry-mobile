const FRONTEND_ERROR_PREFIX = 'client_';

// Transitional allowlist: legacy frontend code paths that have not yet been
// migrated to the client_* namespace.
const ALLOWED_LEGACY_FRONTEND_CODES = new Set([
    'unknown_error',
    'retry_job_failed',
    'retry_job_cancelled',
    'handoff_request_failed',
    'render_apply_failed',
    'native_wait_timeout',
    'capture_cancelled',
    'capture_failed',
    'capture_unsupported',
    'capture_chat_changed',
    'capture_timeout',
    'native_wait_failed',
    'native_observer_failed',
    'native_observer_skipped_missing_fingerprint',
    'native_turn_missing',
    'retry_backend_error',
    'retry_runtime_error',
    'retry_polling_error',
    'retry_recovery_error',
    'retry_settings_invalid',
    'retry_start_failed',
    'retry_stop_failed',
    'retry_status_unavailable',
    'polling_status_missing',
    'polling_status_invalid',
    'polling_transport_unavailable',
    'response_parse_failed',
    'response_status_failed',
]);

const FRONTEND_RESERVED_BACKEND_CODES = new Set([
    'backend_write_failed',
]);

export function createStructuredError(code, message, detail = '') {
    const safeCode = String(code || 'unknown_error');
    assertFrontendErrorNamespace(safeCode);
    return {
        code: safeCode,
        message: String(message || 'Retry Mobile encountered an unknown error.'),
        detail: detail == null ? '' : String(detail),
    };
}

export function normalizeStructuredError(error, fallbackCode = 'unknown_error', fallbackMessage = 'Retry Mobile failed.') {
    if (error && typeof error === 'object' && typeof error.code === 'string' && typeof error.message === 'string') {
        return createStructuredError(error.code, error.message, error.detail || '');
    }

    if (error instanceof Error) {
        const code = typeof error.code === 'string' && error.code
            ? error.code
            : fallbackCode;
        const detail = typeof error.detail === 'string'
            ? error.detail
            : '';
        return createStructuredError(code, error.message || fallbackMessage, detail);
    }

    return createStructuredError(
        fallbackCode,
        typeof error === 'string' && error.trim()
            ? error
            : fallbackMessage,
    );
}

export function formatStructuredError(error) {
    if (!error) {
        return '';
    }

    return error.detail
        ? `${error.message} [${error.code}] ${error.detail}`
        : `${error.message} [${error.code}]`;
}

function assertFrontendErrorNamespace(code) {
    if (!isDevMode()) {
        return;
    }

    if (code.startsWith(FRONTEND_ERROR_PREFIX)) {
        return;
    }

    if (ALLOWED_LEGACY_FRONTEND_CODES.has(code)) {
        return;
    }

    if (FRONTEND_RESERVED_BACKEND_CODES.has(code)) {
        throw new Error(`[INVARIANT] frontend code '${code}' is reserved for backend errors; use a ${FRONTEND_ERROR_PREFIX}* code instead`);
    }

    throw new Error(`[INVARIANT] frontend structured error '${code}' must use ${FRONTEND_ERROR_PREFIX}* namespace`);
}

function isDevMode() {
    return Boolean(globalThis?.__RM_DEV__);
}

