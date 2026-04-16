export function createStructuredError(code, message, detail = '') {
    return {
        code: String(code || 'unknown_error'),
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

