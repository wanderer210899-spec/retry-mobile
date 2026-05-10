// Single owner of state-aware browser-return recovery, per
// `files/architecture.md > Browser Return / BFCache Resume`.
//
// Responsibilities:
//
// * Coalesce the burst of `page.visible`, `window.focused`,
//   `network.online`, and BFCache `pageshow` signals that mobile
//   browsers fire within ~400 ms of each other on resume.
// * RUNNING path: remount the panel host, call `retryFsm.resume(...)`
//   to flush any already-queued visible render, then trigger one explicit
//   return poll whose status flows through the normal FSM ingest path.
// * Non-RUNNING path: remount the panel host, then call
//   `restoreController.reconcileLatestForCurrentChat({ allowReload: true })`
//   so a completed retry result that arrived while the tab was hidden
//   renders automatically on return — no manual Sync, no full reload as
//   the normal path. The reconciler still patches in place first; the
//   reload is its own documented last-resort recovery.
// * `page.hidden` reports frontend presence to the backend (RUNNING
//   only) and bails — the backend job continues independently.
//
// This module never imports `st-adapter.js` or `backend-client.js`
// directly so the boundary tests in
// `frontend/src/app-module-boundary.test.mjs` keep enforcing the
// adapter isolation rule. All adapter access flows through ports
// passed in by `app.js`.

import { cloneValue } from './core/clone.js';
import { resolveCaptureSubscriptionChatIdentity } from './app-recovery.js';
import { RetryState } from './retry-fsm.js';

const RESUME_GUARD_MS = 600;

export function createResumeCoordinator({
    retryFsm,
    runtime,
    backendPort,
    stPort,
    restoreController,
    ensurePanelMounted,
    syncRuntimeFromFsm,
    updateActiveJob,
    render,
    getCurrentChatIdentity,
    toStructuredError,
    logEvent = () => {},
    windowRef = globalThis.window || globalThis,
} = {}) {
    let inFlight = false;
    let debounceHandle = 0;

    return {
        dispatch,
        teardown,
    };

    function dispatch(type, payload = {}) {
        if (type === 'page.hidden') {
            handleHidden();
            return;
        }
        if (type === 'page.visible' || type === 'window.focused' || type === 'network.online') {
            handleReturn(type, payload);
        }
    }

    function teardown() {
        if (debounceHandle) {
            windowRef.clearTimeout(debounceHandle);
            debounceHandle = 0;
        }
    }

    function handleHidden() {
        const state = retryFsm.getState();
        const context = retryFsm.getContext();
        if (state === RetryState.RUNNING && context.jobId) {
            void backendPort.reportFrontendPresence?.(context.jobId, {
                reason: 'page.hidden',
                runId: context.runId,
                visibilityState: 'hidden',
                chatIdentity: cloneValue(context.chatIdentity),
            });
        }
    }

    function handleReturn(type, payload) {
        // Coming back from a hidden/suspended browser can detach the
        // panel host. Remount immediately rather than waiting for the
        // periodic host observer tick.
        ensurePanelMounted?.();

        // One in-flight guard covers both the RUNNING resume path and the
        // non-RUNNING latest-job reconciliation path so a mobile resume burst
        // (visibility + focus + online + BFCache pageshow within ~400 ms)
        // cannot run them concurrently. Keep the existing 600 ms debounce as
        // a secondary coalescing layer on top.
        if (inFlight || debounceHandle) {
            return;
        }
        debounceHandle = windowRef.setTimeout(() => {
            debounceHandle = 0;
        }, RESUME_GUARD_MS);

        // CAPTURING is a handoff-in-flight phase. Do not reconcile latest
        // terminal jobs while a new job is being started.
        if (retryFsm.getState() === RetryState.CAPTURING) {
            return;
        }

        inFlight = true;
        void Promise.resolve()
            .then(async () => {
                if (retryFsm.getState() === RetryState.RUNNING) {
                    await handleRunningReturn(type);
                    return;
                }
                await handleIdleReturn(type);
            })
            .finally(() => {
                inFlight = false;
            });
    }

    async function handleRunningReturn(type) {
        const context = retryFsm.getContext();
        await retryFsm.resume({
            reason: type,
            isVisible: Boolean(stPort.isVisible?.()),
            chatIdentity: resolveCaptureSubscriptionChatIdentity(
                context,
                getCurrentChatIdentity?.() || null,
            ),
            pendingVisibleRender: context.pendingVisibleRender,
        });
        syncRuntimeFromFsm?.(retryFsm);
        render?.();

        // Fire one explicit return poll so accepted outputs that landed while
        // mobile timers were paused flow through updateActiveJob ->
        // observeBackendStatus -> projection/render before the user has to
        // touch a manual Sync button.
        const resumeJobId = context.jobId;
        if (!resumeJobId || typeof backendPort.pollStatus !== 'function') {
            return;
        }

        try {
            const fresh = await backendPort.pollStatus(resumeJobId);
            if (!fresh) return;
            if (retryFsm.getState() !== RetryState.RUNNING) return;
            if (retryFsm.getContext().jobId !== resumeJobId) return;
            await updateActiveJob?.(fresh, resumeJobId);
            syncRuntimeFromFsm?.(retryFsm);
            render?.();
        } catch {
            // Swallow resume poll errors; the normal cadence will recover.
        }
    }

    async function handleIdleReturn(type) {
        if (typeof restoreController?.reconcileLatestForCurrentChat !== 'function') {
            return;
        }

        // If the user just manually armed and cleared `lastTerminalResult`,
        // do not fetch/reconcile a previous terminal job on return.
        const state = retryFsm.getState();
        const context = retryFsm.getContext();
        if (state === RetryState.ARMED && !context.lastTerminalResult) {
            return;
        }

        // `allowReload: true` is the render-on-return contract: the
        // reconciler still patches in place first and only escalates
        // to a guarded full reload as last-resort recovery. This
        // matches `USER_REQUIREMENTS.md > Rendering Requirements >
        // Out-of-focus rendering` ("when focus is restored, apply all
        // queued renders in order before resuming normal display
        // state") and `architecture.md > Browser Return / BFCache
        // Resume` ("Non-RUNNING return path: the coordinator calls
        // reconcileLatestForCurrentChat({ allowReload: true })").
        try {
            await restoreController.reconcileLatestForCurrentChat({
                reason: type,
                allowReload: state === RetryState.IDLE,
            });
            if (retryFsm.getState() === RetryState.RUNNING) {
                return;
            }
            syncRuntimeFromFsm?.(retryFsm);
            render?.();
        } catch (error) {
            runtime.controlError = toStructuredError?.(
                error,
                'Retry Mobile could not reconcile the latest completed job.',
            ) || error;
            render?.();
            void logEvent?.(
                'reconcile_latest_failed',
                'Retry Mobile coordinator caught an exception while reconciling the latest job on return.',
                { reason: type, errorCode: error?.code },
            );
        }
    }
}
