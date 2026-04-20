
function createDefaultCapabilities() {
    return {
        protocolVersion: 0,
        minSupportedProtocolVersion: 0,
        nativeSaveSupport: false,
        nativeSaveCompatibilityDetail: '',
        compatibilityCheckedAt: null,
        userDirectorySupport: false,
        userDirectoryScanSupport: false,
        termux: false,
        termuxCheckedAt: null,
    };
}

export function createRuntime() {
    return {
        settings: null,
        diagnostics: null,
        releaseInfo: null,
        chatState: null,
        quickReplyStatus: null,
        capabilities: createDefaultCapabilities(),
        termuxAvailable: false,
        jobMachine: null,
        jobEffects: null,
        activeJobId: null,
        activeJobStatus: null,
        activeJobStatusObservedAt: null,
        committedReloadKeys: new Set(),
        lastAppliedVersion: 0,
        mountRetryHandle: 0,
        hostObserver: null,
        quickReplyRefreshHandle: 0,
        capture: {
            session: null,
            request: null,
            fingerprint: null,
            assistantMessageIndex: null,
        },
        log: {
            text: '',
            jobId: '',
            title: '',
            updatedAt: null,
            entryCount: 0,
            show: false,
        },
        ui: {
            panel: null,
            statusText: null,
            stats: null,
            errorBox: null,
            actionToggleButton: null,
            quickReplyStatusLine: null,
            quickReplyToggleButton: null,
            mainPane: null,
            systemPane: null,
            diagnosticsOutput: null,
            retryLogShell: null,
            retryLogContainer: null,
            releaseInfoContainer: null,
            tabButtons: [],
            toggleLogButton: null,
            activeTab: 'main',
        },
    };
}
