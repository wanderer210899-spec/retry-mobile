const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const TERMUX_BIN_DIRS = [
    '/data/data/com.termux/files/usr/bin',
    '/data/user/0/com.termux/files/usr/bin',
];

const NOTIFICATION_ID = 47382;

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
        : Boolean(runConfig.notifyOnComplete);
    const shouldVibrate = stage === 'success'
        ? Boolean(runConfig.vibrateOnSuccess)
        : Boolean(runConfig.vibrateOnComplete);

    if (shouldNotify) {
        const bin = resolveBin('termux-notification');
        if (bin) {
            const isComplete = stage === 'completed' || stage === 'stopped';
            runTermuxCommand(bin, [
                '--id', String(NOTIFICATION_ID),
                '--title', 'Retry Mobile',
                '--content', buildMessage(stage, payload),
                '--priority', isComplete ? 'high' : 'default',
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

function buildMessage(stage, payload) {
    if (stage === 'success') {
        return `Accepted ${payload.acceptedCount}/${payload.targetAcceptedCount} · ${payload.wordCount}w · ${payload.tokenCount}t`;
    }

    if (stage === 'completed') {
        return `Done — ${payload.acceptedCount} accepted in ${payload.attemptCount} attempts.`;
    }

    return `Stopped — ${payload.acceptedCount} accepted, ${payload.attemptCount} attempts.`;
}

function runTermuxCommand(bin, args) {
    execFile(bin, args, { timeout: 8000 }, (error) => {
        if (error) {
            console.warn('[retry-mobile:notifier] Termux command failed:', path.basename(bin), error.message);
        }
    });
}

module.exports = {
    acquireWakeLock,
    isTermuxAvailable,
    notify,
    releaseWakeLock,
};
