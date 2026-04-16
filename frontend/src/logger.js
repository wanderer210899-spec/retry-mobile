export function createLogger(prefix) {
    return {
        info(message, data) {
            log('log', prefix, message, data);
        },
        warn(message, data) {
            log('warn', prefix, message, data);
        },
        error(message, data) {
            log('error', prefix, message, data);
        },
    };
}

function log(method, prefix, message, data) {
    const fn = console[method] || console.log;
    if (data === undefined) {
        fn(prefix, message);
        return;
    }

    fn(prefix, message, data);
}
