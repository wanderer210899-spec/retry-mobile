export const EXTENSION_ID = 'retry-mobile';
export const EXTENSION_NAME = 'Retry Mobile';
export const BACKEND_PLUGIN_ID = 'retry-mobile';
export const SETTINGS_KEY = 'retryMobile';
export const PANEL_ID = 'retry-mobile-panel';
export const MENU_ITEM_ID = 'retry-mobile-menu-item';
export const QUICK_REPLY_SET_NAME = 'Retry Mobile';
export const SLASH_COMMAND_PREFIX = 'retry-mobile';
export const REPOSITORY_URL = 'https://github.com/wanderer210899-spec/retry-mobile';

export const RUN_STATE = Object.freeze({
    IDLE: 'idle',
    ARMED: 'armed',
    CAPTURED_PENDING_NATIVE: 'captured_pending_native',
    NATIVE_CONFIRMED: 'native_confirmed',
    NATIVE_ABANDONED: 'native_abandoned',
    BACKEND_RUNNING: 'backend_running',
    COMPLETED: 'completed',
    FAILED: 'failed',
    CANCELLED: 'cancelled',
});

export const JOB_PHASE = Object.freeze({
    IDLE: 'idle',
    ARMED: 'armed',
    RESERVING: 'reserving',
    WAITING_NATIVE: 'waiting_native',
    BACKEND_RUNNING: 'backend_running',
    STOPPING: 'stopping',
    COMPLETING: 'completing',
    RECOVERING: 'recovering',
    COMPLETED: 'completed',
    FAILED: 'failed',
    CANCELLED: 'cancelled',
});

export const RUN_MODE = Object.freeze({
    SINGLE: 'single',
    TOGGLE: 'toggle',
});

export const VALIDATION_MODE = Object.freeze({
    CHARACTERS: 'characters',
    TOKENS: 'tokens',
});

export const DEFAULT_SETTINGS = Object.freeze({
    runMode: RUN_MODE.SINGLE,
    targetAcceptedCount: 3,
    maxAttempts: 30,
    attemptTimeoutSeconds: 90,
    nativeGraceSeconds: 30,
    validationMode: VALIDATION_MODE.CHARACTERS,
    minTokens: 0,
    minCharacters: 300,
    notifyOnSuccess: false,
    notifyOnComplete: true,
    vibrateOnSuccess: false,
    vibrateOnComplete: false,
    notificationMessageTemplate: '',
    allowHeuristicTokenFallback: false,
});

export const REQUIRED_EVENT_NAMES = Object.freeze([
    'CHAT_CHANGED',
    'CHAT_DELETED',
    'CHAT_COMPLETION_SETTINGS_READY',
    'GENERATION_ENDED',
    'GENERATION_STOPPED',
    'CHARACTER_MESSAGE_RENDERED',
]);

export const REQUIRED_PAYLOAD_KEYS = Object.freeze([
    'chat_completion_source',
    'messages',
]);

export const PROTOCOL_VERSION = 4; // Must match PROTOCOL_VERSION in server/plugin-meta.js
export const POLL_INTERVAL_FAST_MS = 1800;
export const POLL_INTERVAL_STEADY_MS = 4000;
export const POLL_INTERVAL_SLOW_MS = 8000;
export const NATIVE_WAIT_TIMEOUT_MS = 180000;
export const NATIVE_WAIT_PROGRESS_TIMEOUT_MS = 60000;
export const NATIVE_HIDDEN_DEBOUNCE_MS = 2500;
export const NATIVE_CONFIRM_TIMEOUT_MS = 4000;
export const NATIVE_CONFIRM_POLL_MS = 120;
export const NATIVE_VISIBLE_PROGRESS_POLL_MS = 1000;
// Calibrate these DOM-facing waits further after the machine refactor has live traces.
export const RENDER_MESSAGE_POLL_MS = 50;
export const RENDER_MESSAGE_WAIT_MS = 900;
export const RENDER_STABLE_TEXT_INTERVAL_MS = 100;
export const RENDER_STABLE_TEXT_TIMEOUT_MS = 2200;
export const TERMINAL_UI_SETTLE_TIMEOUT_MS = 700;
export const DEBUG_EVENT_LIMIT = 16;

export const LOG_PREFIX = Object.freeze({
    APP: '[retry-mobile:app]',
    CAPTURE: '[retry-mobile:capture]',
    BACKEND: '[retry-mobile:backend]',
    CHAT: '[retry-mobile:chat-write]',
    QR: '[retry-mobile:qr]',
    STATE: '[retry-mobile:state]',
});
