import {
    EXTENSION_ID,
    EXTENSION_NAME,
    REPOSITORY_URL,
    RUN_MODE,
    RUN_STATE,
    VALIDATION_MODE,
} from '../constants.js';

export function buildPanelTemplate() {
    return `
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>${EXTENSION_NAME}</b>
            <div class="inline-drawer-icon fa-solid fa-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <div class="rm-panel__body">
                <div class="rm-topbar">
                    <nav class="rm-tabbar" aria-label="Retry Mobile panels">
                        <button class="menu_button rm-tab" data-action="show-tab" data-tab="main" type="button">Main</button>
                        <button class="menu_button rm-tab" data-action="show-tab" data-tab="system" type="button">System</button>
                    </nav>
                    <div class="rm-status-pill" data-role="state-pill" data-state="${RUN_STATE.IDLE}">Idle</div>
                </div>

                <div class="rm-stats-strip" data-role="stats"></div>

                <div class="rm-panel__pane" data-role="main-pane">
                    <section class="rm-fieldset">
                        <div class="rm-fieldset__title">Configuration</div>

                        <div class="rm-inline-row">
                            <span class="rm-inline-row__label">Run mode</span>
                            <div class="rm-mode-toggle" role="radiogroup" aria-label="Retry Mobile run mode">
                                <label class="rm-mode-toggle__option">
                                    <input type="radio" name="${EXTENSION_ID}-run-mode" value="${RUN_MODE.SINGLE}" />
                                    <span>Single</span>
                                </label>
                                <label class="rm-mode-toggle__option">
                                    <input type="radio" name="${EXTENSION_ID}-run-mode" value="${RUN_MODE.TOGGLE}" />
                                    <span>Toggle</span>
                                </label>
                            </div>
                        </div>

                        <div class="rm-number-rows">
                            <div class="rm-inline-row">
                                <label class="rm-inline-row__label" for="${EXTENSION_ID}-target">Accepted outputs goal</label>
                                <input id="${EXTENSION_ID}-target" class="rm-number-input" type="number" min="1" step="1" />
                            </div>
                            <div class="rm-inline-row">
                                <label class="rm-inline-row__label" for="${EXTENSION_ID}-attempts">Maximum attempts</label>
                                <input id="${EXTENSION_ID}-attempts" class="rm-number-input" type="number" min="1" step="1" />
                            </div>
                            <div class="rm-inline-row">
                                <label class="rm-inline-row__label" for="${EXTENSION_ID}-timeout">Attempt timeout (s)</label>
                                <input id="${EXTENSION_ID}-timeout" class="rm-number-input" type="number" min="1" step="1" />
                            </div>
                            <div class="rm-inline-row">
                                <label class="rm-inline-row__label" for="${EXTENSION_ID}-native-grace">Hidden-tab takeover delay (s)</label>
                                <input id="${EXTENSION_ID}-native-grace" class="rm-number-input" type="number" min="10" step="1" />
                            </div>
                        </div>

                        <div class="rm-field rm-field--wide">
                            <label class="rm-field__label">Min. length block</label>
                            <div class="rm-block-grid" role="radiogroup" aria-label="Retry Mobile acceptance hard block">
                                <label class="rm-block-option">
                                    <input type="radio" name="${EXTENSION_ID}-validation-mode" value="${VALIDATION_MODE.CHARACTERS}" />
                                    <span>Characters</span>
                                </label>
                                <label class="rm-block-option">
                                    <input type="radio" name="${EXTENSION_ID}-validation-mode" value="${VALIDATION_MODE.TOKENS}" />
                                    <span>Tokens</span>
                                </label>
                            </div>
                            <div class="rm-number-rows">
                                <div class="rm-inline-row">
                                    <label class="rm-inline-row__label" for="${EXTENSION_ID}-characters">Minimum characters</label>
                                    <input id="${EXTENSION_ID}-characters" class="rm-number-input" type="number" min="0" step="1" />
                                </div>
                                <div class="rm-inline-row">
                                    <label class="rm-inline-row__label" for="${EXTENSION_ID}-tokens">Minimum tokens</label>
                                    <input id="${EXTENSION_ID}-tokens" class="rm-number-input" type="number" min="0" step="1" />
                                </div>
                            </div>
                        </div>
                    </section>

                    <section class="rm-fieldset">
                        <div class="rm-fieldset__title">Notifications</div>
                        <div class="rm-field">
                            <label for="${EXTENSION_ID}-notification-template">Termux notification template</label>
                            <textarea id="${EXTENSION_ID}-notification-template" rows="2" placeholder="Leave blank for default."></textarea>
                        </div>
                        <div class="rm-checkbox-grid">
                            <label class="rm-checkbox">
                                <input data-setting="notifyOnSuccess" type="checkbox" />
                                <span>Notify on accepted</span>
                            </label>
                            <label class="rm-checkbox">
                                <input data-setting="notifyOnComplete" type="checkbox" />
                                <span>Notify on complete</span>
                            </label>
                            <label class="rm-checkbox">
                                <input data-setting="vibrateOnSuccess" type="checkbox" />
                                <span>Vibrate on accepted</span>
                            </label>
                            <label class="rm-checkbox">
                                <input data-setting="vibrateOnComplete" type="checkbox" />
                                <span>Vibrate on complete</span>
                            </label>
                        </div>
                    </section>

                    <section class="rm-fieldset">
                        <div class="rm-inline-row">
                            <span class="rm-inline-row__label">Quick Replies</span>
                            <button class="menu_button rm-qr-toggle" data-action="toggle-qr">Inject</button>
                        </div>
                        <div class="rm-qr-status" data-role="qr-status"></div>
                    </section>

                    <button class="menu_button rm-button--primary rm-button--full" data-action="toggle-run">Start</button>

                    <div class="rm-error" data-role="error-box" hidden></div>
                </div>

                <div class="rm-panel__pane" data-role="system-pane" hidden>
                    <section class="rm-fieldset">
                        <div class="rm-fieldset__title rm-section-row">
                            <span>Diagnostics</span>
                            <button class="menu_button rm-button--inline" data-action="diagnostics">Run</button>
                        </div>
                        <div class="rm-diagnostics-output" data-role="diagnostics-output">
                            <div class="rm-diagnostics__line">No diagnostics have run yet.</div>
                        </div>
                    </section>

                    <section class="rm-fieldset">
                        <div class="rm-fieldset__title rm-section-row">
                            <span>Install &amp; Update</span>
                            <a class="rm-github-link" href="${REPOSITORY_URL}" target="_blank" rel="noopener noreferrer"><i class="fa-brands fa-github"></i> GitHub</a>
                        </div>
                        <div class="rm-release-card" data-role="release-info">Checking...</div>
                    </section>

                    <section class="rm-fieldset">
                        <div class="rm-fieldset__title rm-section-row">
                            <span>Retry Log</span>
                            <div class="rm-header-actions">
                                <button class="menu_button rm-button--inline" data-action="toggle-log">Show</button>
                                <button class="menu_button rm-button--inline" data-action="copy-log">Copy</button>
                                <button class="menu_button rm-button--inline" data-action="download-log">Download</button>
                            </div>
                        </div>
                        <div class="rm-log-window" data-role="retry-log-shell" hidden>
                            <div data-role="retry-log-box"></div>
                        </div>
                    </section>
                </div>
            </div>
        </div>
    `;
}
