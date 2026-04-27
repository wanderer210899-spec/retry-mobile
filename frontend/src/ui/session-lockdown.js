const BLOCKED_CLICK_SELECTORS = [
    '#send_but',
    '.last_mes .swipe_right',
    '.last_mes .swipe_left',
    '#option_regenerate',
    '#option_continue',
    '#mes_continue',
    '#mes_impersonate',
];

const ENTER_BLOCK_SELECTORS = [
    '#send_textarea',
];

const BLOCKED_SHORTCUT_KEYS = new Set([
    'ArrowLeft',
    'ArrowRight',
    'F5',
]);

const TOAST_THROTTLE_MS = 1800;
const REGEN_SWIPE_MIN_DISTANCE_PX = 56;
const REGEN_SWIPE_MAX_VERTICAL_DRIFT_PX = 80;

export function createSessionLockdown({
    getContext,
    showToast,
    translate,
    documentRef = document,
    observerFactory = (handler) => new MutationObserver(handler),
    now = () => Date.now(),
} = {}) {
    let active = false;
    let clickHandler = null;
    let keydownHandler = null;
    let touchStartHandler = null;
    let touchEndHandler = null;
    let pointerDownHandler = null;
    let pointerUpHandler = null;
    let observer = null;
    let lastToastAt = 0;
    let sendBusyOriginalIconClasses = null;
    let pendingBusyRefresh = false;
    const gesture = {
        active: false,
        startX: 0,
        startY: 0,
        startedOnLastMessage: false,
        pointerId: null,
    };

    return {
        enable() {
            if (active) {
                refreshBusyVisual();
                return true;
            }
            active = true;
            bindListeners();
            refreshBusyVisual();
            return true;
        },
        disable() {
            if (!active) {
                restoreSendButton();
                return true;
            }
            active = false;
            unbindListeners();
            restoreSendButton();
            return true;
        },
        isActive() {
            return active;
        },
    };

    function bindListeners() {
        clickHandler = (event) => {
            const element = toElement(event?.target);
            if (!element) {
                return;
            }
            const blockedSelector = resolveBlockedClickSelector(element);
            if (!blockedSelector) {
                return;
            }
            // #region agent log
            fetch('http://127.0.0.1:7536/ingest/05a89a81-df92-43ea-a660-ce4e4687905f',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'22a0c7'},body:JSON.stringify({sessionId:'22a0c7',runId:'pre-fix',hypothesisId:'A',location:'frontend/src/ui/session-lockdown.js:clickHandler',message:'Lockdown blocked click',data:{blockedSelector,tag:String(element.tagName||''),id:String(element.id||''),className:String(element.className||''),closestLastMes:Boolean(element.closest?.('.last_mes')),closestSwipeLeft:Boolean(element.closest?.('.swipe_left')),closestSwipeRight:Boolean(element.closest?.('.swipe_right'))},timestamp:Date.now()})}).catch(()=>{});
            // #endregion
            blockEvent(event);
            if (shouldToastForBlockedSelector(blockedSelector)) {
                emitBlockedToast({
                    source: 'blocked_click',
                    blockedSelector,
                });
            }
        };

        keydownHandler = (event) => {
            const element = toElement(event?.target);
            if (!element) {
                return;
            }

            // Block enter submit from the chat textarea.
            if (event?.key === 'Enter' && !event?.shiftKey && matchesAnySelector(element, ENTER_BLOCK_SELECTORS)) {
                // #region agent log
                fetch('http://127.0.0.1:7536/ingest/05a89a81-df92-43ea-a660-ce4e4687905f',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'22a0c7'},body:JSON.stringify({sessionId:'22a0c7',runId:'pre-fix',hypothesisId:'B',location:'frontend/src/ui/session-lockdown.js:keydownHandler',message:'Lockdown blocked Enter submit',data:{key:String(event?.key||''),shiftKey:Boolean(event?.shiftKey),tag:String(element.tagName||''),id:String(element.id||''),className:String(element.className||'')},timestamp:Date.now()})}).catch(()=>{});
                // #endregion
                blockEvent(event);
                return;
            }

            // Block common generation shortcuts while retry owns the run.
            const hasShortcutModifier = Boolean(event?.ctrlKey || event?.metaKey || event?.altKey);
            if (hasShortcutModifier && BLOCKED_SHORTCUT_KEYS.has(String(event?.key || ''))) {
                // #region agent log
                fetch('http://127.0.0.1:7536/ingest/05a89a81-df92-43ea-a660-ce4e4687905f',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'22a0c7'},body:JSON.stringify({sessionId:'22a0c7',runId:'pre-fix',hypothesisId:'B',location:'frontend/src/ui/session-lockdown.js:keydownHandler',message:'Lockdown blocked shortcut',data:{key:String(event?.key||''),ctrlKey:Boolean(event?.ctrlKey),metaKey:Boolean(event?.metaKey),altKey:Boolean(event?.altKey)},timestamp:Date.now()})}).catch(()=>{});
                // #endregion
                blockEvent(event);
            }
        };

        touchStartHandler = (event) => {
            const point = getEventPoint(event);
            const element = toElement(event?.target);
            if (!point || !element) {
                return;
            }
            gesture.active = true;
            gesture.startX = point.x;
            gesture.startY = point.y;
            gesture.startedOnLastMessage = Boolean(element.closest?.('.last_mes'));
            gesture.pointerId = null;
        };

        touchEndHandler = (event) => {
            if (!gesture.active) {
                return;
            }
            const point = getEventPoint(event);
            const element = toElement(event?.target);
            const startX = gesture.startX;
            const startY = gesture.startY;
            const startedOnLastMessage = gesture.startedOnLastMessage;
            gesture.active = false;
            gesture.pointerId = null;
            if (!point || !element) {
                return;
            }
            const deltaX = point.x - startX;
            const deltaY = point.y - startY;
            const absX = Math.abs(deltaX);
            const absY = Math.abs(deltaY);
            const isHorizontalSwipe = absX >= REGEN_SWIPE_MIN_DISTANCE_PX && absY <= REGEN_SWIPE_MAX_VERTICAL_DRIFT_PX;
            if (!isHorizontalSwipe) {
                return;
            }
            if (!startedOnLastMessage) {
                return;
            }

            // #region agent log
            fetch('http://127.0.0.1:7536/ingest/05a89a81-df92-43ea-a660-ce4e4687905f',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'22a0c7'},body:JSON.stringify({sessionId:'22a0c7',runId:'pre-fix',hypothesisId:'C',location:'frontend/src/ui/session-lockdown.js:touchEndHandler',message:'Lockdown blocked regen swipe gesture (touch)',data:{deltaX,deltaY,absX,absY,targetTag:String(element.tagName||''),targetId:String(element.id||''),startedOnLastMessage},timestamp:Date.now()})}).catch(()=>{});
            // #endregion

            blockEvent(event);
            emitBlockedToast({
                source: 'blocked_swipe',
                swipeDirection: deltaX < 0 ? 'right_to_left' : 'left_to_right',
            });
        };

        pointerDownHandler = (event) => {
            if (!event || typeof event !== 'object') {
                return;
            }
            const element = toElement(event?.target);
            const point = getEventPoint(event);
            if (!element || !point) {
                return;
            }
            gesture.active = true;
            gesture.startX = point.x;
            gesture.startY = point.y;
            gesture.startedOnLastMessage = Boolean(element.closest?.('.last_mes'));
            gesture.pointerId = typeof event.pointerId === 'number' ? event.pointerId : null;
        };

        pointerUpHandler = (event) => {
            if (!gesture.active) {
                return;
            }
            if (gesture.pointerId != null && typeof event?.pointerId === 'number' && event.pointerId !== gesture.pointerId) {
                return;
            }
            const element = toElement(event?.target);
            const point = getEventPoint(event);
            const startX = gesture.startX;
            const startY = gesture.startY;
            const startedOnLastMessage = gesture.startedOnLastMessage;
            gesture.active = false;
            gesture.pointerId = null;
            if (!element || !point) {
                return;
            }
            const deltaX = point.x - startX;
            const deltaY = point.y - startY;
            const absX = Math.abs(deltaX);
            const absY = Math.abs(deltaY);
            const isHorizontalSwipe = absX >= REGEN_SWIPE_MIN_DISTANCE_PX && absY <= REGEN_SWIPE_MAX_VERTICAL_DRIFT_PX;
            if (!isHorizontalSwipe || !startedOnLastMessage) {
                return;
            }

            // #region agent log
            fetch('http://127.0.0.1:7536/ingest/05a89a81-df92-43ea-a660-ce4e4687905f',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'22a0c7'},body:JSON.stringify({sessionId:'22a0c7',runId:'pre-fix',hypothesisId:'C',location:'frontend/src/ui/session-lockdown.js:pointerUpHandler',message:'Lockdown blocked regen swipe gesture (pointer)',data:{deltaX,deltaY,absX,absY,targetTag:String(element.tagName||''),targetId:String(element.id||''),startedOnLastMessage},timestamp:Date.now()})}).catch(()=>{});
            // #endregion

            blockEvent(event);
            emitBlockedToast({
                source: 'blocked_swipe',
                swipeDirection: deltaX < 0 ? 'right_to_left' : 'left_to_right',
            });
        };

        documentRef.addEventListener?.('click', clickHandler, true);
        documentRef.addEventListener?.('keydown', keydownHandler, true);
        documentRef.addEventListener?.('touchstart', touchStartHandler, { capture: true, passive: false });
        documentRef.addEventListener?.('touchend', touchEndHandler, { capture: true, passive: false });
        documentRef.addEventListener?.('pointerdown', pointerDownHandler, { capture: true, passive: false });
        documentRef.addEventListener?.('pointerup', pointerUpHandler, { capture: true, passive: false });

        observer = observerFactory(() => {
            if (!active) {
                return;
            }
            if (pendingBusyRefresh) {
                return;
            }
            pendingBusyRefresh = true;
            queueMicrotask(() => {
                pendingBusyRefresh = false;
                if (active) {
                    refreshBusyVisual();
                }
            });
        });
        try {
            observer.observe?.(documentRef.body || documentRef.documentElement, {
                childList: true,
                subtree: true,
            });
        } catch {
            observer = null;
        }
    }

    function unbindListeners() {
        if (clickHandler) {
            documentRef.removeEventListener?.('click', clickHandler, true);
        }
        if (keydownHandler) {
            documentRef.removeEventListener?.('keydown', keydownHandler, true);
        }
        if (touchStartHandler) {
            documentRef.removeEventListener?.('touchstart', touchStartHandler, true);
        }
        if (touchEndHandler) {
            documentRef.removeEventListener?.('touchend', touchEndHandler, true);
        }
        if (pointerDownHandler) {
            documentRef.removeEventListener?.('pointerdown', pointerDownHandler, true);
        }
        if (pointerUpHandler) {
            documentRef.removeEventListener?.('pointerup', pointerUpHandler, true);
        }
        clickHandler = null;
        keydownHandler = null;
        touchStartHandler = null;
        touchEndHandler = null;
        pointerDownHandler = null;
        pointerUpHandler = null;
        if (observer) {
            observer.disconnect?.();
        }
        observer = null;
    }

    function refreshBusyVisual() {
        const sendButton = documentRef.getElementById?.('send_but');
        if (!sendButton?.classList) {
            return false;
        }
        if (!sendBusyOriginalIconClasses) {
            sendBusyOriginalIconClasses = detectFaIconNameClasses(sendButton);
            if (sendBusyOriginalIconClasses.length === 0) {
                sendBusyOriginalIconClasses = ['fa-paper-plane'];
            }
        }

        detectFaIconNameClasses(sendButton).forEach((name) => sendButton.classList.remove(name));
        sendButton.classList.add('fa-solid');
        sendButton.classList.add('fa-spinner');
        sendButton.classList.add('fa-spin');
        return true;
    }

    function restoreSendButton() {
        const sendButton = documentRef.getElementById?.('send_but');
        if (!sendButton?.classList) {
            sendBusyOriginalIconClasses = null;
            return false;
        }

        sendButton.classList.remove('fa-spinner');
        sendButton.classList.remove('fa-spin');
        detectFaIconNameClasses(sendButton).forEach((name) => sendButton.classList.remove(name));
        (sendBusyOriginalIconClasses || []).forEach((name) => sendButton.classList.add(name));
        sendBusyOriginalIconClasses = null;
        return true;
    }

    function emitBlockedToast(detail) {
        const current = now();
        if (current - lastToastAt < TOAST_THROTTLE_MS) {
            return;
        }
        lastToastAt = current;
        const title = String(translate?.('toasts.title') || 'Retry Mobile');
        const message = String(translate?.('toasts.interactionBlocked') || 'Interaction is blocked while retry is running.');
        showToast?.('warning', title, message);

        try {
            // #region agent log
            fetch('http://127.0.0.1:7536/ingest/05a89a81-df92-43ea-a660-ce4e4687905f',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'22a0c7'},body:JSON.stringify({sessionId:'22a0c7',runId:'pre-fix',hypothesisId:'D',location:'frontend/src/ui/session-lockdown.js:emitBlockedToast',message:'Lockdown emitted blocked toast',data:detail||{},timestamp:Date.now()})}).catch(()=>{});
            // #endregion
        } catch {}
    }
}

function matchesBlockedClick(element) {
    return matchesAnySelector(element, BLOCKED_CLICK_SELECTORS);
}

function resolveBlockedClickSelector(element) {
    for (const selector of BLOCKED_CLICK_SELECTORS) {
        try {
            if (element.closest?.(selector)) {
                return selector;
            }
        } catch {}
    }
    return '';
}

function shouldToastForBlockedSelector(selector) {
    if (!selector) {
        return false;
    }
    return selector === '.last_mes .swipe_right'
        || selector === '.last_mes .swipe_left'
        || selector === '#option_regenerate';
}

function matchesAnySelector(element, selectors) {
    return selectors.some((selector) => element.closest?.(selector));
}

function blockEvent(event) {
    try {
        event.preventDefault?.();
        event.stopImmediatePropagation?.();
        event.stopPropagation?.();
    } catch {}
}

function toElement(target) {
    if (!target || typeof target !== 'object') {
        return null;
    }
    return 'closest' in target ? target : null;
}

function getEventPoint(event) {
    const touch = event?.changedTouches?.[0] || event?.touches?.[0] || null;
    if (touch && typeof touch.clientX === 'number' && typeof touch.clientY === 'number') {
        return { x: touch.clientX, y: touch.clientY };
    }
    if (typeof event?.clientX === 'number' && typeof event?.clientY === 'number') {
        return { x: event.clientX, y: event.clientY };
    }
    return null;
}

function detectFaIconNameClasses(element) {
    const classes = element?.classList ? Array.from(element.classList) : [];
    return classes.filter((name) => (
        name.startsWith('fa-')
        && name !== 'fa-solid'
        && name !== 'fa-regular'
        && name !== 'fa-brands'
        && name !== 'fa-spin'
        && name !== 'fa-spinner'
        && name !== 'fa-lg'
        && name !== 'fa-fw'
        && name !== 'fa-xs'
        && name !== 'fa-sm'
        && name !== 'fa-xl'
        && name !== 'fa-2xl'
        && name !== 'fa-pull-left'
        && name !== 'fa-pull-right'
    ));
}
