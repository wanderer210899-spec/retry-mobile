import {
    EXTENSION_NAME,
    LOG_PREFIX,
    REPOSITORY_URL,
    SLASH_COMMAND_PREFIX,
} from '../constants.js';
import { createLogger } from '../logger.js';
import { fetchLatestJob, fetchReleaseInfo } from '../backend-api.js';
import { runDiagnostics } from '../diagnostics.js';
import { getQuickReplyStatus, setQuickReplyAttached } from '../quick-reply.js';
import {
    focusPanelDrawer,
    getChatIdentity,
    getContext,
    registerSlashCommand,
    showToast,
} from '../st-context.js';
import {
    buildRetryLogFileName,
    clearRetryLog,
    getRetryLogContext,
    syncRetryLogForStatus,
} from '../logs/retry-log.js';
import { createStructuredError } from '../retry-error.js';

const backendLog = createLogger(LOG_PREFIX.BACKEND);
const qrLog = createLogger(LOG_PREFIX.QR);

export function createSystemController({
    runtime,
    render,
    setJobError,
    armPluginFromUi,
    stopPlugin,
}) {
    return {
        refreshDiagnostics,
        refreshReleaseInfo,
        refreshQuickReplyState,
        scheduleQuickReplyRefresh,
        toggleQuickRepliesFromUi,
        copyRetryLogFromUi,
        downloadRetryLogFromUi,
        registerCommands,
        showTab,
        toggleRetryLog,
    };

    async function refreshDiagnostics(showFeedback = false) {
        runtime.diagnostics = await runDiagnostics(getContext());
        if (showFeedback) {
            showToast(runtime.diagnostics.startEnabled ? 'success' : 'warning', EXTENSION_NAME, runtime.diagnostics.startEnabled
                ? 'Diagnostics passed. Retry Mobile can arm for capture.'
                : 'Diagnostics found missing capabilities. Start stays fail-closed.');
        }

        render();
    }

    async function refreshReleaseInfo() {
        try {
            runtime.releaseInfo = await fetchReleaseInfo();
        } catch (error) {
            backendLog.warn('Could not fetch release info.', error);
            runtime.releaseInfo = {
                repositoryUrl: REPOSITORY_URL,
                branch: 'unknown',
                update: {
                    canCheck: false,
                    hasUpdate: false,
                    message: error?.message || 'Retry Mobile could not reach the backend release endpoint.',
                },
                installed: {
                    version: '',
                    branch: 'unknown',
                    commit: '',
                },
                latest: {
                    version: '',
                    branch: 'unknown',
                },
                instructions: {
                    updateNow: 'From your local SillyTavern directory, run the Retry Mobile bootstrap installer and choose Install / Update now.',
                    addProfile: 'From your local SillyTavern directory, run the Retry Mobile bootstrap installer and choose Install / Update now to add another profile or install for everyone.',
                },
            };
        }

        render();
    }

    function refreshQuickReplyState(options = {}) {
        runtime.quickReplyStatus = getQuickReplyStatus();
        if (!options.quiet && !runtime.quickReplyStatus?.ok) {
            qrLog.warn('Quick Reply sync unavailable.', runtime.quickReplyStatus);
        }
        render();
    }

    function scheduleQuickReplyRefresh() {
        if (runtime.quickReplyRefreshHandle) {
            window.clearTimeout(runtime.quickReplyRefreshHandle);
        }

        runtime.quickReplyRefreshHandle = window.setTimeout(() => {
            runtime.quickReplyRefreshHandle = 0;
            refreshQuickReplyState({ quiet: true });
        }, 1800);
    }

    async function toggleQuickRepliesFromUi() {
        const currentStatus = runtime.quickReplyStatus?.ok
            ? runtime.quickReplyStatus
            : getQuickReplyStatus();
        const shouldAttach = !currentStatus?.attached;
        const result = setQuickReplyAttached(shouldAttach);
        runtime.quickReplyStatus = result.ok ? result : getQuickReplyStatus();

        if (!result.ok) {
            setJobError?.(createStructuredError(
                'capture_missing_payload',
                result.reason || 'Quick Reply controls are unavailable in this SillyTavern session.',
            ));
            return;
        }

        runtime.jobMachine.clearError();
        showToast(
            'success',
            EXTENSION_NAME,
            shouldAttach
                ? 'Retry Mobile Quick Replies were injected into the active toolbar.'
                : 'Retry Mobile Quick Replies were uninjected from the active toolbar.',
        );
        render();
    }

    async function copyRetryLogFromUi() {
        await syncVisibleRetryLog();
        const logContext = getRetryLogContext(runtime);
        const text = logContext.text || '';
        if (!text.trim()) {
            showToast('info', EXTENSION_NAME, 'No retry log is available yet.');
            return;
        }

        try {
            await navigator.clipboard.writeText(text);
            showToast('success', EXTENSION_NAME, 'Retry log copied to clipboard.');
        } catch (error) {
            backendLog.warn('Retry log copy failed.', error);
            showToast('warning', EXTENSION_NAME, 'Retry log copy failed in this browser session.');
        }
    }

    async function downloadRetryLogFromUi() {
        await syncVisibleRetryLog();
        const logContext = getRetryLogContext(runtime);
        const text = logContext.text || '';
        if (!text.trim()) {
            showToast('info', EXTENSION_NAME, 'No retry log is available yet.');
            return;
        }

        const blob = new Blob([text], {
            type: 'text/plain;charset=utf-8',
        });
        const url = URL.createObjectURL(blob);

        try {
            const anchor = document.createElement('a');
            anchor.href = url;
            anchor.download = buildRetryLogFileName(runtime);
            anchor.style.display = 'none';
            document.body.append(anchor);
            anchor.click();
            anchor.remove();
            showToast('success', EXTENSION_NAME, `Retry log downloaded as ${anchor.download}.`);
        } catch (error) {
            backendLog.warn('Retry log download failed.', error);
            showToast('warning', EXTENSION_NAME, 'Retry log download failed in this browser session.');
        } finally {
            window.setTimeout(() => URL.revokeObjectURL(url), 0);
        }
    }

    function registerCommands() {
        const context = getContext();
        if (!context) {
            return;
        }

        registerSlashCommand(context, {
            name: `${SLASH_COMMAND_PREFIX}-start`,
            callback: async () => {
                await armPluginFromUi();
            },
            helpString: 'Arm Retry Mobile for the next qualifying generation request.',
        });
        registerSlashCommand(context, {
            name: `${SLASH_COMMAND_PREFIX}-stop`,
            callback: async () => {
                await stopPlugin();
            },
            helpString: 'Stop the armed or running Retry Mobile job.',
        });
        registerSlashCommand(context, {
            name: `${SLASH_COMMAND_PREFIX}-panel`,
            callback: async () => {
                focusPanelDrawer(runtime.ui.panel);
            },
            helpString: 'Focus the Retry Mobile settings panel.',
        });
        registerSlashCommand(context, {
            name: `${SLASH_COMMAND_PREFIX}-diagnostics`,
            callback: async () => {
                await refreshDiagnostics(true);
            },
            helpString: 'Run Retry Mobile diagnostics.',
        });
    }

    function showTab(tab) {
        runtime.ui.activeTab = tab === 'system' ? 'system' : 'main';
        if (runtime.ui.activeTab === 'system') {
            void refreshReleaseInfo();
            void syncVisibleRetryLog().then(() => render());
        }
        render();
    }

    function toggleRetryLog() {
        runtime.log.show = !runtime.log.show;
        runtime.ui.activeTab = 'system';
        if (runtime.log.show) {
            void syncVisibleRetryLog().then(() => render());
        }
        render();
    }

    async function syncVisibleRetryLog() {
        if (runtime.activeJobStatus?.jobId) {
            await syncRetryLogForStatus(runtime, runtime.activeJobStatus, {
                force: true,
                clearWhenMissing: false,
            });
            return;
        }

        const latest = await fetchLatestJob(getChatIdentity(getContext()));
        if (latest?.jobId) {
            await syncRetryLogForStatus(runtime, latest, {
                force: true,
                clearWhenMissing: false,
            });
            return;
        }

        clearRetryLog(runtime);
    }
}
