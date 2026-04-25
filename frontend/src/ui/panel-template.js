import {
    EXTENSION_ID,
    EXTENSION_NAME,
    REPOSITORY_URL,
    RUN_MODE,
    VALIDATION_MODE,
} from '../constants.js';
import { t } from '../i18n.js';

export function buildPanelTemplate() {
    return `
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>${EXTENSION_NAME}</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down interactable" tabindex="0" role="button"></div>
        </div>
        <div class="inline-drawer-content">
            <div class="rm-panel__body">
                <div class="rm-topbar">
                    <nav class="rm-tabbar" aria-label="${escapeHtml(t('panel.tabMain'))}">
                        <button class="menu_button rm-tab" data-action="show-tab" data-tab="main" type="button">${escapeHtml(t('panel.tabMain'))}</button>
                        <button class="menu_button rm-tab" data-action="show-tab" data-tab="system" type="button">${escapeHtml(t('panel.tabSystem'))}</button>
                    </nav>
                    <div class="rm-status-pill" data-role="state-pill" data-state="idle">${escapeHtml(t('panel.statusIdle'))}</div>
                </div>

                <div class="rm-stats-strip" data-role="stats"></div>

                <div class="rm-panel__pane" data-role="main-pane">
                    <section class="rm-fieldset">
                        <div class="rm-fieldset__title">${escapeHtml(t('panel.configurationTitle'))}</div>

                        <div class="rm-inline-row">
                            <span class="rm-inline-row__label">${escapeHtml(t('panel.runModeLabel'))}</span>
                            <div class="rm-mode-toggle" role="radiogroup" aria-label="${escapeHtml(t('panel.runModeLabel'))}">
                                <label class="rm-mode-toggle__option">
                                    <input type="radio" name="${EXTENSION_ID}-run-mode" value="${RUN_MODE.SINGLE}" />
                                    <span>${escapeHtml(t('panel.runModeSingle'))}</span>
                                </label>
                                <label class="rm-mode-toggle__option">
                                    <input type="radio" name="${EXTENSION_ID}-run-mode" value="${RUN_MODE.TOGGLE}" />
                                    <span>${escapeHtml(t('panel.runModeToggle'))}</span>
                                </label>
                            </div>
                        </div>

                        <div class="rm-number-rows">
                            <div class="rm-inline-row">
                                <label class="rm-inline-row__label" for="${EXTENSION_ID}-target">${escapeHtml(t('panel.acceptedGoalLabel'))}</label>
                                <input id="${EXTENSION_ID}-target" class="rm-number-input" type="number" min="1" step="1" />
                            </div>
                            <div class="rm-inline-row">
                                <label class="rm-inline-row__label" for="${EXTENSION_ID}-attempts">${escapeHtml(t('panel.maxAttemptsLabel'))}</label>
                                <input id="${EXTENSION_ID}-attempts" class="rm-number-input" type="number" min="1" step="1" />
                            </div>
                            <div class="rm-inline-row">
                                <label class="rm-inline-row__label" for="${EXTENSION_ID}-timeout">${escapeHtml(t('panel.attemptTimeoutLabel'))}</label>
                                <input id="${EXTENSION_ID}-timeout" class="rm-number-input" type="number" min="1" step="1" />
                            </div>
                            <div class="rm-inline-row">
                                <label class="rm-inline-row__label" for="${EXTENSION_ID}-native-grace">${escapeHtml(t('panel.nativeGraceLabel'))}</label>
                                <input id="${EXTENSION_ID}-native-grace" class="rm-number-input" type="number" min="10" step="1" />
                            </div>
                        </div>

                        <div class="rm-field rm-field--wide">
                            <label class="rm-field__label">${escapeHtml(t('panel.minLengthBlockLabel'))}</label>
                            <div class="rm-block-grid" role="radiogroup" aria-label="${escapeHtml(t('panel.minLengthBlockLabel'))}">
                                <label class="rm-block-option">
                                    <input type="radio" name="${EXTENSION_ID}-validation-mode" value="${VALIDATION_MODE.CHARACTERS}" />
                                    <span>${escapeHtml(t('panel.charactersLabel'))}</span>
                                </label>
                                <label class="rm-block-option">
                                    <input type="radio" name="${EXTENSION_ID}-validation-mode" value="${VALIDATION_MODE.TOKENS}" />
                                    <span>${escapeHtml(t('panel.tokensLabel'))}</span>
                                </label>
                            </div>
                            <div class="rm-number-rows">
                                <div class="rm-inline-row">
                                    <label class="rm-inline-row__label" for="${EXTENSION_ID}-characters">${escapeHtml(t('panel.minimumCharactersLabel'))}</label>
                                    <input id="${EXTENSION_ID}-characters" class="rm-number-input" type="number" min="0" step="1" />
                                </div>
                                <div class="rm-inline-row">
                                    <label class="rm-inline-row__label" for="${EXTENSION_ID}-tokens">${escapeHtml(t('panel.minimumTokensLabel'))}</label>
                                    <input id="${EXTENSION_ID}-tokens" class="rm-number-input" type="number" min="0" step="1" />
                                </div>
                            </div>
                        </div>
                    </section>

                    <section class="rm-fieldset">
                        <div class="rm-fieldset__title">${escapeHtml(t('panel.notificationsTitle'))}</div>
                        <div class="rm-field">
                            <label for="${EXTENSION_ID}-notification-template">${escapeHtml(t('panel.termuxTemplateLabel'))}</label>
                            <textarea id="${EXTENSION_ID}-notification-template" rows="2" placeholder="${escapeHtml(t('panel.termuxTemplatePlaceholder'))}"></textarea>
                        </div>
                        <div class="rm-checkbox-grid">
                            <label class="rm-checkbox">
                                <input data-setting="notifyOnSuccess" type="checkbox" />
                                <span>${escapeHtml(t('panel.notifyOnAccepted'))}</span>
                            </label>
                            <label class="rm-checkbox">
                                <input data-setting="notifyOnComplete" type="checkbox" />
                                <span>${escapeHtml(t('panel.notifyOnComplete'))}</span>
                            </label>
                            <label class="rm-checkbox">
                                <input data-setting="vibrateOnSuccess" type="checkbox" />
                                <span>${escapeHtml(t('panel.vibrateOnAccepted'))}</span>
                            </label>
                            <label class="rm-checkbox">
                                <input data-setting="vibrateOnComplete" type="checkbox" />
                                <span>${escapeHtml(t('panel.vibrateOnComplete'))}</span>
                            </label>
                        </div>
                    </section>

                    <section class="rm-fieldset">
                        <div class="rm-inline-row">
                            <label class="rm-inline-row__label" for="${EXTENSION_ID}-ui-language">${escapeHtml(t('panel.languageLabel'))}</label>
                            <select id="${EXTENSION_ID}-ui-language" class="rm-number-input">
                                <option value="en">${escapeHtml(t('panel.languageEnglish'))}</option>
                                <option value="zh">${escapeHtml(t('panel.languageChinese'))}</option>
                            </select>
                        </div>
                    </section>

                    <section class="rm-fieldset">
                        <div class="rm-inline-row">
                            <span class="rm-inline-row__label">${escapeHtml(t('panel.quickRepliesLabel'))}</span>
                            <button class="menu_button rm-qr-toggle" data-action="toggle-qr">${escapeHtml(t('panel.inject'))}</button>
                        </div>
                        <div class="rm-qr-status" data-role="qr-status"></div>
                    </section>

                    <button class="menu_button rm-button--primary rm-button--full" data-action="toggle-run">${escapeHtml(t('panel.start'))}</button>

                    <div class="rm-error" data-role="error-box" hidden></div>
                </div>

                <div class="rm-panel__pane" data-role="system-pane" hidden>
                    <section class="rm-fieldset">
                        <div class="rm-fieldset__title rm-section-row">
                            <span>${escapeHtml(t('panel.installUpdateTitle'))}</span>
                            <a class="rm-github-link" href="${REPOSITORY_URL}" target="_blank" rel="noopener noreferrer"><i class="fa-brands fa-github"></i> ${escapeHtml(t('panel.github'))}</a>
                        </div>
                        <div class="rm-release-card" data-role="release-info">${escapeHtml(t('panel.checking'))}</div>
                    </section>

                    <section class="rm-fieldset">
                        <div class="rm-fieldset__title rm-section-row">
                            <span>${escapeHtml(t('panel.retryLogTitle'))}</span>
                            <div class="rm-header-actions">
                                <button class="menu_button rm-button--inline" data-action="toggle-log">${escapeHtml(t('panel.show'))}</button>
                                <button class="menu_button rm-button--inline" data-action="copy-log">${escapeHtml(t('panel.copy'))}</button>
                                <button class="menu_button rm-button--inline" data-action="download-log">${escapeHtml(t('panel.download'))}</button>
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

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}
