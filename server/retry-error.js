function createStructuredError(code, message, detail = '') {
    const error = new Error(String(message || 'Retry Mobile backend failed.'));
    error.code = String(code || 'backend_error');
    error.detail = detail == null ? '' : String(detail);
    return error;
}

function toStructuredError(error, fallbackCode = 'backend_error', fallbackMessage = 'Retry Mobile backend failed.') {
    if (error && typeof error === 'object' && typeof error.code === 'string' && typeof error.message === 'string') {
        return {
            code: error.code,
            message: error.message,
            detail: typeof error.detail === 'string' ? error.detail : '',
        };
    }

    if (error instanceof Error) {
        return {
            code: typeof error.code === 'string' && error.code ? error.code : fallbackCode,
            message: error.message || fallbackMessage,
            detail: typeof error.detail === 'string' ? error.detail : '',
        };
    }

    return {
        code: fallbackCode,
        message: typeof error === 'string' && error.trim() ? error : fallbackMessage,
        detail: '',
    };
}

module.exports = {
    createStructuredError,
    toStructuredError,
};

