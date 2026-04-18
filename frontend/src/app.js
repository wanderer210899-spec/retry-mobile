import { fetchCapabilities } from './backend-api.js';
import { writeSettings, readSettings } from './settings.js';
import { getContext } from './st-context.js';
import { createRuntime } from './core/runtime.js';
import { isRunningLikeState } from './core/run-state.js';
import { createRenderer } from './ui/render.js';
import { mountPanel } from './ui/panel-bindings.js';
import { createStatusController } from './controllers/status-controller.js';
import { createRunController } from './controllers/run-controller.js';
import { createRecoveryController } from './controllers/recovery-controller.js';
import { createSystemController } from './controllers/system-controller.js';

const runtime = createRuntime();

export function bootRetryMobile() {
    runtime.settings = readSettings(getContext());

    const render = createRenderer({ runtime });
    const statusController = createStatusController({ runtime, render });
    const runController = createRunController({ runtime, render, statusController });
    const systemController = createSystemController({
        runtime,
        render,
        statusController,
        armPluginFromUi: runController.armPluginFromUi,
        stopPlugin: runController.stopPlugin,
    });

    let recoveryController = null;
    const persistSettings = () => {
        writeSettings(getContext(), runtime.settings);
    };
    const ensurePanelMounted = () => mountPanel(runtime, {
        render,
        persistSettings,
        onMissingHost: () => recoveryController?.scheduleMountRetry(),
        actions: {
            onToggleRun: async () => {
                if (isRunningLikeState(statusController.getCurrentState())) {
                    await runController.stopPlugin();
                    return;
                }

                await runController.armPluginFromUi();
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

    recoveryController = createRecoveryController({
        runtime,
        render,
        statusController,
        ensurePanelMounted,
    });

    statusController.setRecoveryHandlers({
        schedule: recoveryController.scheduleBackendRecovery,
        recover: recoveryController.recoverFrontendFromBackend,
    });
    statusController.setAutoRearmHandler(runController.maybeAutoRearmAfterRun);

    ensurePanelMounted();
    recoveryController.bindHostObserver();
    recoveryController.bindFrontendRecoverySignals();
    systemController.registerCommands();

    void systemController.refreshDiagnostics();
    systemController.refreshQuickReplyState({ quiet: true });
    systemController.scheduleQuickReplyRefresh();
    void recoveryController.restoreActiveJob();
    void fetchCapabilities().then((caps) => {
        runtime.capabilities = {
            ...runtime.capabilities,
            ...caps,
        };
        runtime.termuxAvailable = Boolean(caps?.termux);
        render();
    });
    void statusController.refreshChatState();
    statusController.bindChatStateRefresh();
    void systemController.refreshReleaseInfo();
}
