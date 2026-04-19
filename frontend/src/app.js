import { fetchCapabilities } from './backend-api.js';
import { sendFrontendLogEvent } from './logs/retry-log.js';
import { createStructuredError } from './retry-error.js';
import { writeSettings, readSettings } from './settings.js';
import { getChatIdentity, getContext } from './st-context.js';
import { createRuntime } from './core/runtime.js';
import { isRunningLikeState } from './core/run-state.js';
import { createRenderer } from './ui/render.js';
import { mountPanel } from './ui/panel-bindings.js';
import { createSystemController } from './controllers/system-controller.js';
import { createJobMachine } from './job/job-machine.js';
import { createJobEffects } from './job/job-effects.js';

const runtime = createRuntime();

export function bootRetryMobile() {
    runtime.settings = readSettings(getContext());

    const render = createRenderer({ runtime });
    runtime.jobMachine = createJobMachine({ runtime, render });
    runtime.jobEffects = createJobEffects({
        runtime,
        machine: runtime.jobMachine,
        render,
    });
    runtime.jobMachine.attachEffects(runtime.jobEffects);

    const persistSettings = () => {
        writeSettings(getContext(), runtime.settings);
    };

    const armPluginFromUi = async () => {
        const validationError = getArmValidationError(runtime);
        if (validationError) {
            runtime.jobMachine.setError(validationError);
            return;
        }

        runtime.jobMachine.dispatch({
            type: 'user.arm_requested',
            payload: {
                chatIdentity: getChatIdentity(getContext()),
            },
        });
    };

    const stopPlugin = async () => {
        runtime.jobMachine.dispatch({
            type: 'user.stop_requested',
            payload: {},
        });
    };

    const ensurePanelMounted = () => mountPanel(runtime, {
        render,
        persistSettings,
        onMissingHost: () => scheduleMountRetry(ensurePanelMounted),
        actions: {
            onToggleRun: async () => {
                const phase = runtime.jobMachine.getState().phase;
                if (isRunningLikeState(phase)) {
                    await stopPlugin();
                    return;
                }
                await armPluginFromUi();
            },
            onDiagnostics: async () => {
                await systemController.refreshDiagnostics(true);
                systemController.showTab('system');
            },
            onToggleQuickReplies: async () => {
                await systemController.toggleQuickRepliesFromUi();
            },
            onShowTab: async (tab) => {
                systemController.showTab(tab);
            },
            onToggleLog: async () => {
                systemController.toggleRetryLog();
            },
            onCopyLog: async () => {
                await systemController.copyRetryLogFromUi();
            },
            onDownloadLog: async () => {
                await systemController.downloadRetryLogFromUi();
            },
        },
    });

    const systemController = createSystemController({
        runtime,
        render,
        setJobError: (error) => {
            runtime.jobMachine.setError(error);
        },
        armPluginFromUi,
        stopPlugin,
    });

    ensurePanelMounted();
    bindHostObserver(ensurePanelMounted);
    bindPageObservers();
    systemController.registerCommands();

    void systemController.refreshDiagnostics();
    systemController.refreshQuickReplyState({ quiet: true });
    systemController.scheduleQuickReplyRefresh();
    void fetchCapabilities().then((caps) => {
        runtime.capabilities = {
            ...runtime.capabilities,
            ...caps,
        };
        runtime.termuxAvailable = Boolean(caps?.termux);
        render();
    });
    void systemController.refreshReleaseInfo();
    runtime.jobMachine.dispatch({
        type: 'system.restore_requested',
        payload: {
            chatIdentity: getChatIdentity(getContext()),
            reason: 'boot',
        },
    });
}

function getArmValidationError(runtime) {
    if (!runtime.diagnostics?.startEnabled) {
        return createStructuredError(
            'capture_missing_payload',
            'Retry Mobile is blocked by missing SillyTavern capabilities. Run diagnostics first.',
        );
    }

    if (Number(runtime.settings?.maxAttempts) < Number(runtime.settings?.targetAcceptedCount)) {
        return createStructuredError(
            'handoff_request_failed',
            'Maximum attempts must be at least as large as the accepted outputs goal.',
        );
    }

    const timeoutSeconds = Number(runtime.settings?.attemptTimeoutSeconds) || 0;
    if (timeoutSeconds <= 0) {
        return createStructuredError(
            'validation_config_invalid',
            'Attempt timeout must be greater than 0 seconds.',
        );
    }

    const minimum = runtime.settings?.validationMode === 'tokens'
        ? Number(runtime.settings?.minTokens) || 0
        : Number(runtime.settings?.minCharacters) || 0;

    if (minimum > 0) {
        return null;
    }

    return createStructuredError(
        'validation_config_invalid',
        runtime.settings?.validationMode === 'tokens'
            ? 'Minimum tokens must be greater than 0 when token-count blocking is active.'
            : 'Minimum characters must be greater than 0 when character-count blocking is active.',
    );
}

function bindHostObserver(ensurePanelMounted) {
    if (runtime.hostObserver || !document.body) {
        return;
    }

    runtime.hostObserver = new MutationObserver(() => {
        if (!document.getElementById('retry-mobile-panel')) {
            ensurePanelMounted();
        }
    });
    runtime.hostObserver.observe(document.body, {
        childList: true,
        subtree: true,
    });
}

function scheduleMountRetry(ensurePanelMounted) {
    if (runtime.mountRetryHandle) {
        return;
    }

    runtime.mountRetryHandle = window.setTimeout(() => {
        runtime.mountRetryHandle = 0;
        ensurePanelMounted();
    }, 900);
}

function bindPageObservers() {
    document.addEventListener('visibilitychange', () => {
        const hidden = document.visibilityState === 'hidden';
        runtime.jobMachine.dispatch({
            type: hidden ? 'page.hidden' : 'page.visible',
            payload: {},
        });
        void sendFrontendLogEvent(runtime, {
            event: 'visibility_changed',
            summary: `Frontend visibility changed to ${document.visibilityState}.`,
            detail: {
                visibilityState: document.visibilityState,
            },
        });
    });

    window.addEventListener('focus', () => {
        runtime.jobMachine.dispatch({
            type: 'window.focused',
            payload: {},
        });
        void sendFrontendLogEvent(runtime, {
            event: 'window_focus',
            summary: 'Frontend window regained focus.',
            detail: null,
        });
    });

    window.addEventListener('online', () => {
        runtime.jobMachine.dispatch({
            type: 'network.online',
            payload: {},
        });
        void sendFrontendLogEvent(runtime, {
            event: 'browser_online',
            summary: 'Frontend browser reported an online transition.',
            detail: null,
        });
    });
}
