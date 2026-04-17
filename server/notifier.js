const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const TERMUX_BIN_DIRS = [
    '/data/data/com.termux/files/usr/bin',
    '/data/user/0/com.termux/files/usr/bin',
];

let notificationSequence = 0;

const _termuxBinDir = TERMUX_BIN_DIRS.find((dir) => {
    try {
        return fs.statSync(dir).isDirectory();
    } catch {
        return false;
    }
}) ?? null;

function isTermuxAvailable() {
    return _termuxBinDir !== null;
}

function resolveBin(name) {
    if (!_termuxBinDir) {
        return null;
    }

    const full = path.join(_termuxBinDir, name);
    try {
        fs.accessSync(full, fs.constants.X_OK);
        return full;
    } catch {
        return null;
    }
}

function notify(runConfig, stage, payload = {}) {
    const shouldNotify = stage === 'success'
        ? Boolean(runConfig.notifyOnSuccess)
        : stage === 'completed'
            ? Boolean(runConfig.notifyOnComplete)
            : false;
    const shouldVibrate = stage === 'success'
        ? Boolean(runConfig.vibrateOnSuccess)
        : stage === 'completed'
            ? Boolean(runConfig.vibrateOnComplete)
            : false;

    if (shouldNotify) {
        const bin = resolveBin('termux-notification');
        if (bin) {
            runTermuxCommand(bin, [
                '--id', nextNotificationId(),
                '--title', 'Retry Mobile',
                '--content', buildMessage(runConfig, stage, payload),
                '--priority', stage === 'completed' ? 'high' : 'default',
                '--sound',
                '--icon', 'ic_notification_overlay',
            ]);
        }
    }

    if (shouldVibrate) {
        const bin = resolveBin('termux-vibrate');
        if (bin) {
            const durationMs = stage === 'completed' ? 900 : 400;
            runTermuxCommand(bin, ['-d', String(durationMs), '-f']);
        }
    }
}

function acquireWakeLock() {
    const bin = resolveBin('termux-wake-lock');
    if (bin) {
        runTermuxCommand(bin, []);
    }
}

function releaseWakeLock() {
    const bin = resolveBin('termux-wake-unlock');
    if (bin) {
        runTermuxCommand(bin, []);
    }
}

function nextNotificationId() {
    notificationSequence = (notificationSequence + 1) % 1000;
    const base = Date.now() % 2147482647;
    return String(base + notificationSequence);
}

function buildMessage(runConfig, stage, payload) {
    const customMessage = renderCustomMessage(runConfig, stage, payload);
    if (customMessage) {
        return customMessage;
    }

    if (stage === 'success') {
        return `Accepted ${payload.acceptedCount}/${payload.targetAcceptedCount} - ${payload.characterCount}c - ${payload.tokenCount}t`;
    }

    if (stage === 'completed') {
        return `Done - ${payload.acceptedCount} accepted in ${payload.attemptCount} attempts.`;
    }

    return `Retry Mobile ${stage}.`;
}

function renderCustomMessage(runConfig, stage, payload) {
    const template = normalizeTemplate(runConfig?.notificationMessageTemplate);
    if (!template) {
        return '';
    }

    const values = {
        stage: stage === 'success' ? 'accepted' : stage,
        acceptedCount: stringifyTemplateValue(payload.acceptedCount),
        targetAcceptedCount: stringifyTemplateValue(payload.targetAcceptedCount),
        attemptCount: stringifyTemplateValue(payload.attemptCount),
        characterCount: stringifyTemplateValue(payload.characterCount),
        wordCount: stringifyTemplateValue(payload.characterCount),
        tokenCount: stringifyTemplateValue(payload.tokenCount),
        reason: stringifyTemplateValue(payload.reason),
        timeoutSeconds: stringifyTemplateValue(runConfig?.attemptTimeoutSeconds),
    };

    return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key) => (
        Object.prototype.hasOwnProperty.call(values, key)
            ? values[key]
            : match
    ));
}

function normalizeTemplate(template) {
    if (typeof template !== 'string') {
        return '';
    }

    return template
        .replace(/\r?\n+/g, ' ')
        .trim();
}

function stringifyTemplateValue(value) {
    return value == null ? '' : String(value);
}

function runTermuxCommand(bin, args) {
    execFile(bin, args, { timeout: 8000 }, (error) => {
        if (error) {
            console.warn('[retry-mobile:notifier] Termux command failed:', path.basename(bin), error.message);
        }
    });
}

function probeTermuxBin(name, args) {
    return new Promise((resolve) => {
        const bin = resolveBin(name);
        if (!bin) {
            resolve({ name, found: false, reason: 'binary not found or not executable' });
            return;
        }
        const { execFile: ef } = require('node:child_process');
        ef(bin, args, { timeout: 5000 }, (error, stdout, stderr) => {
            resolve({
                name,
                found: true,
                path: bin,
                exitCode: error?.code ?? 0,
                signal: error?.signal ?? null,
                stdout: (stdout || '').trim().slice(0, 500),
                stderr: (stderr || '').trim().slice(0, 500),
                error: error ? error.message.slice(0, 300) : null,
            });
        });
    });
}

async function debugNotifier() {
    return {
        binDir: _termuxBinDir,
        isTermuxAvailable: isTermuxAvailable(),
        probes: await Promise.all([
            probeTermuxBin('termux-notification', ['--id', '99999', '--title', 'RM-test', '--content', 'debug probe']),
            probeTermuxBin('termux-vibrate', ['-d', '200']),
            probeTermuxBin('termux-wake-lock', []),
            probeTermuxBin('termux-wake-unlock', []),
        ]),
    };
}

module.exports = {
    acquireWakeLock,
    debugNotifier,
    isTermuxAvailable,
    notify,
    releaseWakeLock,
};
