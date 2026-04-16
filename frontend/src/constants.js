export const EXTENSION_ID = 'retry-mobile';
export const EXTENSION_NAME = 'Retry Mobile';
export const SETTINGS_KEY = 'retryMobile';
export const PANEL_ID = 'retry-mobile-panel';
export const MENU_ITEM_ID = 'retry-mobile-menu-item';
export const QUICK_REPLY_SET_NAME = 'Retry Mobile';
export const SLASH_COMMAND_PREFIX = 'retry-mobile';

export const RUN_STATE = Object.freeze({
    IDLE: 'idle',
    ARMED: 'armed',
    WAITING_FOR_NATIVE: 'waiting_for_native',
    HANDING_OFF: 'handing_off',
    RUNNING: 'running',
    COMPLETED: 'completed',
    FAILED: 'failed',
    CANCELLED: 'cancelled',
});

export const RUN_MODE = Object.freeze({
    SINGLE: 'single',
    TOGGLE: 'toggle',
});

export const DEFAULT_SETTINGS = Object.freeze({
    runMode: RUN_MODE.SINGLE,
    targetAcceptedCount: 3,
    maxAttempts: 30,
    minTokens: 0,
    minWords: 60,
    notifyOnSuccess: false,
    notifyOnComplete: true,
    vibrateOnSuccess: false,
    vibrateOnComplete: false,
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

export const POLL_INTERVAL_MS = 1800;
export const NATIVE_WAIT_TIMEOUT_MS = 180000;
export const NATIVE_CONFIRM_TIMEOUT_MS = 4000;
export const NATIVE_CONFIRM_POLL_MS = 120;
export const DEBUG_EVENT_LIMIT = 16;

export const LOG_PREFIX = Object.freeze({
    APP: '[retry-mobile:app]',
    CAPTURE: '[retry-mobile:capture]',
    BACKEND: '[retry-mobile:backend]',
    CHAT: '[retry-mobile:chat-write]',
    QR: '[retry-mobile:qr]',
    STATE: '[retry-mobile:state]',
});
