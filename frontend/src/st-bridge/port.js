// st-bridge/port.js
// StPort contract documentation. The bridge index.js returns an object that
// satisfies this surface. The list below is also the allowlist enforced by
// st-bridge-boundary.test.mjs to prevent silent surface-area growth.

/**
 * @typedef {object} StPort
 *
 * @property {() => CapabilityReport} probe
 *   Capability check for SillyTavern APIs the bridge depends on.
 *
 * @property {() => ChatIdentity | null} getChatIdentity
 *   Read-only normalised identity for the currently active SillyTavern chat.
 *
 * @property {() => boolean} isVisible
 *   Whether the browser tab is currently visible (best-effort, no focus checks).
 *
 * @property {() => boolean} isStreaming
 *   Whether SillyTavern is currently streaming/mutating an assistant turn.
 *
 * @property {(active: boolean) => boolean} setLockdown
 *   Activate/deactivate the document-level send/swipe/regenerate lockdown and
 *   the reconciler's accepted-output apply gate.
 *
 * @property {() => boolean} lockdownActive
 *   Whether lockdown is currently engaged.
 *
 * @property {(payload?: SubscribeCapturePayload) => void} subscribeCapture
 *   Arm capture for the next qualifying user-triggered generation.
 *
 * @property {() => void} unsubscribeCapture
 *   Disarm capture without emitting a captured/cancelled event.
 *
 * @property {(payload?: SubscribeNativePayload) => void} subscribeNativeObserver
 *   Start observing SillyTavern lifecycle events for native completion of the
 *   captured turn.
 *
 * @property {() => void} unsubscribeNativeObserver
 *   Stop observing native completion.
 *
 * @property {(signal?: AbortSignal) => Promise<boolean>} guardedReload
 *   Force a SillyTavern reload of the current chat (last-resort recovery only).
 *
 * @property {(targetChat: ChatIdentity) => boolean} setGeneratingIndicator
 *   Show ST's "generating" UI for the given chat (deactivate send buttons,
 *   refresh swipe controls). Returns false when the chat is no longer active.
 *
 * @property {(targetChat: ChatIdentity) => boolean} clearGeneratingIndicator
 *   Reverse `setGeneratingIndicator`.
 *
 * @property {(kind: 'info'|'success'|'warning'|'error', title: string, message: string) => void} notifyToast
 *   Surface a toastr notification (debug-oriented, dedupe is the caller's job).
 *
 * @property {object} reconciler
 *   The single accepted-output apply/reload owner. See controllers/reconciler.js.
 */

/**
 * The fixed set of method names the bridge index.js must expose. Any addition
 * to this list is a contract change and must be reviewed alongside the
 * st-bridge-boundary.test.mjs allowlist assertion.
 *
 * The list reflects the surface inherited from the former `createStPort()`
 * factory. Phase 2 of the bridge plan is a body rewrite of the existing
 * write-path (saveReply replay) and adds no new StPort methods. Future phases
 * may add helpers (e.g. `acquireRunLock` once Phase 3 slims lockdown); each
 * such addition is a contract change that must be appended here and reviewed
 * alongside the boundary test assertion.
 */
export const ST_PORT_METHOD_ALLOWLIST = Object.freeze([
    'getChatIdentity',
    'isVisible',
    'isStreaming',
    'setLockdown',
    'lockdownActive',
    'subscribeCapture',
    'unsubscribeCapture',
    'subscribeNativeObserver',
    'unsubscribeNativeObserver',
    'guardedReload',
    'setGeneratingIndicator',
    'clearGeneratingIndicator',
    'notifyToast',
    'reconciler',
]);
