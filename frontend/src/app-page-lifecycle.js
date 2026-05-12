// Single owner of browser page-lifecycle event binding. Per the
// architecture invariant in `files/architecture.md`, only this module
// may register `visibilitychange`, `focus`, `online`, and the BFCache
// `pageshow` listeners that drive return-from-background recovery.
//
// All listeners are registered with `{ passive: true }` because none of
// them call `preventDefault()`. (The lockdown in
// `frontend/src/st-bridge/lockdown.js` has its own touch/pointer
// handlers; this module deliberately stays out of that surface.)

const PASSIVE_LISTENER = { passive: true };

export function bindPageObservers(runtime, {
    documentRef = document,
    windowRef = window,
    dispatch = (type, payload) => windowRef.__rmDispatch?.(type, payload),
    logEvent = (event, summary, detail) => windowRef.__rmLogEvent?.(event, summary, detail),
} = {}) {
    if (runtime.pageObserverHandles) {
        return runtime.pageObserverHandles;
    }

    const onVisibilityChange = () => {
        const hidden = documentRef.visibilityState === 'hidden';
        dispatch(hidden ? 'page.hidden' : 'page.visible', {});
        void logEvent('visibility_changed', `Frontend visibility changed to ${documentRef.visibilityState}.`, {
            visibilityState: documentRef.visibilityState,
        });
    };
    const onFocus = () => {
        dispatch('window.focused', {});
        void logEvent('window_focus', 'Frontend window regained focus.', null);
    };
    const onOnline = () => {
        dispatch('network.online', {});
        void logEvent('browser_online', 'Frontend browser reported an online transition.', null);
    };
    // BFCache restore on mobile browsers (notably iOS Safari) can
    // reactivate a previously cached page without firing
    // `visibilitychange` or `focus`. Treat that as an additional
    // `'page.visible'` source so the resume coordinator runs the same
    // recovery path. `event.persisted === false` is a normal load and
    // is handled by the regular DOMContentLoaded boot.
    const onPageShow = (event) => {
        if (!event?.persisted) {
            return;
        }
        dispatch('page.visible', {});
        void logEvent('bfcache_restore', 'Frontend page was restored from BFCache.', {
            visibilityState: documentRef.visibilityState,
        });
    };

    documentRef.addEventListener('visibilitychange', onVisibilityChange, PASSIVE_LISTENER);
    windowRef.addEventListener('focus', onFocus, PASSIVE_LISTENER);
    windowRef.addEventListener('online', onOnline, PASSIVE_LISTENER);
    windowRef.addEventListener('pageshow', onPageShow, PASSIVE_LISTENER);
    runtime.pageObserverHandles = {
        documentRef,
        windowRef,
        onVisibilityChange,
        onFocus,
        onOnline,
        onPageShow,
    };
    return runtime.pageObserverHandles;
}

export function unbindPageObservers(runtime) {
    const handles = runtime.pageObserverHandles;
    if (!handles) {
        return false;
    }

    handles.documentRef.removeEventListener('visibilitychange', handles.onVisibilityChange);
    handles.windowRef.removeEventListener('focus', handles.onFocus);
    handles.windowRef.removeEventListener('online', handles.onOnline);
    handles.windowRef.removeEventListener('pageshow', handles.onPageShow);
    runtime.pageObserverHandles = null;
    return true;
}
