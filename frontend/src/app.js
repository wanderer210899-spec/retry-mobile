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
import { getFrontendSessionId } from './job/run-binding.js';

const runtime = createRuntime();

export function bootRetryMobile() {
    runtime.settings = readSettings(getContext());
    runtime.sessionId = getFrontendSessionId();

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

    window.__rmTeardown?.();
    window.__rmTeardown = () => {
        runtime.jobEffects?.teardown?.();
        if (runtime.hostObserver) {
            clearInterval(runtime.hostObserver);
            runtime.hostObserver = 0;
        }
    };
    window.__rmDispatch = (type, payload) => runtime.jobMachine?.dispatch({ type, payload });
    window.__rmLogEvent = (event, summary, detail) => sendFrontendLogEvent(runtime, { event, summary, detail });

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
            'validation_config_invalid',
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

    runtime.hostObserver = window.setInterval(() => {
        if (!document.getElementById('retry-mobile-panel')) {
            ensurePanelMounted();
        }
    }, 2000);
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
    if (window.__rmPageObserversBound) {
        return;
    }
    window.__rmPageObserversBound = true;

    document.addEventListener('visibilitychange', () => {
        const hidden = document.visibilityState === 'hidden';
        window.__rmDispatch?.(hidden ? 'page.hidden' : 'page.visible', {});
        void window.__rmLogEvent?.('visibility_changed', `Frontend visibility changed to ${document.visibilityState}.`, {
            visibilityState: document.visibilityState,
        });
    });

    window.addEventListener('focus', () => {
        window.__rmDispatch?.('window.focused', {});
        void window.__rmLogEvent?.('window_focus', 'Frontend window regained focus.', null);
    });

    window.addEventListener('online', () => {
        window.__rmDispatch?.('network.online', {});
        void window.__rmLogEvent?.('browser_online', 'Frontend browser reported an online transition.', null);
    });
}
