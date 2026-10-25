(() => {
  'use strict';

  /*
   * Embedded PC authentication flow.
   *
   * This file deliberately keeps the authentication boundary narrow:
   * - only the allowlisted pcAuth/pcConnect methods are invoked;
   * - only the documented snapshot fields are copied into the DOM;
   * - contacts, OTPs, tokens, and raw errors never enter persistent storage,
   *   console output, notices, or callback payloads.
   */
  const PHASES = new Set([
    'start',
    'contact',
    'code',
    'account',
    'two_factor',
    'checkpoint',
    'authenticated',
    'ready',
    'error',
  ]);
  const TERMINAL_PHASES = new Set(['authenticated', 'ready']);
  const STATIC_ERROR = 'PC認証を完了できませんでした。もう一度お試しください。';
  const MISSING_API_ERROR = 'PC認証を利用できません。アプリを更新してください。';
  const TERMS_URL = 'https://gadgets.muse.ai/sdk-terms';
  const UI = {
    dialog: 'pcSetupDialog',
    form: 'pcSetupForm',
    title: 'pcSetupTitle',
    description: 'pcSetupDescription',
    status: 'pcSetupStatus',
    content: 'pcSetupContent',
    actions: 'pcSetupActions',
    close: 'pcSetupClose',
  };

  let dialog = null;
  let form = null;
  let description = null;
  let status = null;
  let content = null;
  let actions = null;
  let snapshot = null;
  let busy = false;
  let submitAction = null;
  let activeTwoFactorMethodIndex = null;
  let twoFactorCodeIssued = false;
  let previousFocus = null;
  let closeReason = 'cancel';
  let cancelRequested = false;
  let operationId = 0;
  let allowNativePcModeClick = false;

  const byId = id => {
    try {
      if (typeof $ === 'function') return $(id);
    } catch {}
    return document.getElementById(id);
  };

  function make(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function cleanText(value, max = 240) {
    if (typeof value !== 'string') return '';
    return value
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, max);
  }

  function safeMessage(value) {
    const text = cleanText(value);
    if (!text) return '';
    // State messages are user-facing text. Refuse likely secret/raw-response
    // material even if a future backend accidentally puts it in message.
    if (/(?:bearer|authorization|cookie|secret|access[ _-]?token|refresh[ _-]?token|api[ _-]?key)/i.test(text)) return '';
    if (/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/.test(text)) return '';
    if (/[A-Za-z0-9+/=_-]{40,}/.test(text)) return '';
    return text;
  }

  function safeUrl(value) {
    if (typeof value !== 'string' || value.length > 2048) return '';
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && url.hostname && !url.username && !url.password ? url.href : '';
    } catch {
      return '';
    }
  }

  function normalizeEntries(value) {
    if (!Array.isArray(value)) return [];
    return value.reduce((entries, item, index) => {
      const label = cleanText(item && typeof item === 'object' ? item.label : '', 160);
      if (label) entries.push({ index, label });
      return entries;
    }, []);
  }

  function normalizeSnapshot(value) {
    const source = value && typeof value === 'object' ? value : {};
    const phase = PHASES.has(source.phase) ? source.phase : 'error';
    return {
      phase,
      hasSdkToken: source.hasSdkToken === true,
      hasDevice: source.hasDevice === true,
      accounts: normalizeEntries(source.accounts),
      methods: normalizeEntries(source.methods),
      checkpointUrl: safeUrl(source.checkpointUrl),
      message: safeMessage(source.message),
    };
  }

  function errorSnapshot(message = STATIC_ERROR) {
    return normalizeSnapshot({ phase: 'error', message });
  }

  function apiAvailable(method) {
    return !!(window.muse && typeof window.muse[method] === 'function');
  }

  async function invoke(method, ...args) {
    if (!apiAvailable(method) || typeof call !== 'function') {
      throw new Error(MISSING_API_ERROR);
    }
    // call() unwraps the normal {ok,value}/{ok:false,error} envelope. Its
    // error is caught by callers and replaced with a generic UI message.
    return call(method, ...args);
  }

  function createDialogIfMissing() {
    let d = byId(UI.dialog);
    if (d) return d;

    d = document.createElement('dialog');
    d.id = UI.dialog;
    d.setAttribute('aria-labelledby', UI.title);
    d.innerHTML = [
      '<form method="dialog" id="pcSetupForm">',
      '  <div class="dialog-heading">',
      '    <h2 id="pcSetupTitle">PCの認証</h2>',
      '    <button type="button" class="icon-button muted" id="pcSetupClose" aria-label="PC認証を閉じる">',
      '      <svg aria-hidden="true"><use href="#i-close"></use></svg>',
      '    </button>',
      '  </div>',
      '  <p class="dialog-description" id="pcSetupDescription"></p>',
      '  <p class="pc-setup-status" id="pcSetupStatus" role="status" aria-live="polite"></p>',
      '  <div id="pcSetupContent"></div>',
      '  <div class="dialog-actions" id="pcSetupActions"></div>',
      '</form>',
    ].join('');
    document.body.append(d);
    return d;
  }

  function bindDialog() {
    dialog = createDialogIfMissing();
    form = dialog.querySelector('#' + UI.form);
    description = dialog.querySelector('#' + UI.description);
    status = dialog.querySelector('#' + UI.status);
    content = dialog.querySelector('#' + UI.content);
    actions = dialog.querySelector('#' + UI.actions);
    const close = dialog.querySelector('#' + UI.close);
    if (!form || !description || !status || !content || !actions || !close) return false;
    if (dialog.dataset.pcSetupBound === 'true') return true;
    dialog.dataset.pcSetupBound = 'true';

    form.addEventListener('submit', event => {
      event.preventDefault();
      if (!busy && typeof submitAction === 'function') submitAction();
    });
    close.addEventListener('click', () => requestClose('cancel'));
    dialog.addEventListener('cancel', event => {
      event.preventDefault();
      requestClose('cancel');
    });
    dialog.addEventListener('click', event => {
      if (event.target !== dialog) return;
      const bounds=dialog.getBoundingClientRect();
      if(event.clientX<bounds.left||event.clientX>bounds.right||event.clientY<bounds.top||event.clientY>bounds.bottom)requestClose('cancel');
    });
    dialog.addEventListener('close', () => {
      const shouldCancel = closeReason === 'cancel' && snapshot && !TERMINAL_PHASES.has(snapshot.phase);
      operationId += 1;
      busy = false;
      clearTransientInputs();
      submitAction = null;
      activeTwoFactorMethodIndex = null;
      twoFactorCodeIssued = false;
      snapshot = null;
      content.replaceChildren();
      actions.replaceChildren();
      description.textContent = '';
      status.textContent = '';
      setControlsDisabled(false);
      if (shouldCancel && !cancelRequested) {
        cancelRequested = true;
        // Cancel only clears the in-progress server-side auth step. It does
        // not revoke a minted SDK credential.
        invoke('pcAuthCancel').catch(() => {});
      }
      closeReason = 'cancel';
      const focusTarget = previousFocus;
      previousFocus = null;
      if (focusTarget && typeof focusTarget.focus === 'function') {
        window.setTimeout(() => focusTarget.focus(), 0);
      }
    });
    return true;
  }

  function clearTransientInputs() {
    if (!dialog) return;
    for (const input of dialog.querySelectorAll('input')) {
      if (input.type === 'checkbox') input.checked = false;
      else input.value = '';
    }
  }

  function setControlsDisabled(disabled) {
    if (!dialog) return;
    // The top close button remains available while a request is pending so
    // Escape/backdrop/cancel can still clean up the local flow.
    for (const control of dialog.querySelectorAll('button:not(#pcSetupClose), input, a')) {
      if (control.tagName === 'A') control.setAttribute('aria-disabled', String(disabled));
      else control.disabled = disabled;
    }
    const close = dialog.querySelector('#' + UI.close);
    if (close) close.disabled = false;
    dialog.setAttribute('aria-busy', String(disabled));
  }

  function setStatus(text, kind = '') {
    status.textContent = cleanText(text, 240);
    status.dataset.kind = kind;
  }

  function phaseDescription(phase) {
    return ({
      start: 'このPCでMuseのPC機能を使うための認証を行います。',
      contact: 'Museアカウントの連絡先を入力して、確認コードを受け取ります。',
      code: '届いた確認コードを入力してください。',
      account: '使用するMuseアカウントを選択してください。',
      two_factor: '追加の2段階認証を完了してください。',
      checkpoint: 'ブラウザーで認証を完了したあと、この画面に戻ってください。',
      authenticated: 'このPCの認証が完了しました。',
      ready: 'このPCの認証が完了しました。',
      error: 'PC認証を確認できませんでした。',
    })[phase] || 'このPCでMuseのPC機能を認証します。';
  }

  function phaseStatus(phase) {
    return ({
      start: '開始ボタンを押すまで認証情報は作成されません。',
      contact: '連絡先はこの画面の送信処理にだけ使用します。',
      code: 'コードは送信後にこの画面から消去されます。',
      account: 'アカウントを選ぶと次の認証手順に進みます。',
      two_factor: '認証方法を選び、届いたコードを入力してください。',
      checkpoint: 'ブラウザーで認証を完了したら、状態を確認してください。',
      authenticated: 'このPCの認証が完了しました。',
      ready: 'このPCの認証が完了しました。',
      error: STATIC_ERROR,
    })[phase] || STATIC_ERROR;
  }

  function renderStatus() {
    if (busy) {
      setStatus('処理中です…');
      return;
    }
    const kind = snapshot && snapshot.phase === 'error' ? 'error' : '';
    setStatus(snapshot && (safeMessage(snapshot.message) || phaseStatus(snapshot.phase)), kind);
  }

  function setSubmit(handler) {
    submitAction = handler;
  }

  function appendCancel(label = 'キャンセル') {
    const cancel = make('button', 'pill-button', label);
    cancel.type = 'button';
    cancel.addEventListener('click', () => requestClose('cancel'));
    actions.append(cancel);
  }

  function appendPrimary(label, handler) {
    const primary = make('button', 'primary-button', label);
    primary.type = 'button';
    primary.addEventListener('click', () => {
      if (!busy) handler();
    });
    actions.append(primary);
  }

  function renderActions(primaryLabel, handler, closeLabel = 'キャンセル') {
    actions.replaceChildren();
    setSubmit(handler);
    appendCancel(closeLabel);
    if (primaryLabel) appendPrimary(primaryLabel, handler);
  }

  function focusLater(id) {
    window.setTimeout(() => {
      const field = byId(id);
      if (!busy && dialog && dialog.open && field) field.focus();
    }, 0);
  }

  function addFieldLabel(input, labelText, hintText = '') {
    const label = make('label', 'pc-setup-field');
    label.append(make('span', 'pc-setup-label', labelText), input);
    if (hintText) label.append(make('span', 'pc-setup-hint', hintText));
    content.append(label);
  }

  function makeCodeField(id) {
    const wrap = make('div', 'pc-setup-code-wrap');
    const input = make('input', 'dialog-input');
    input.id = id;
    input.type = 'password';
    input.inputMode = 'numeric';
    input.autocomplete = 'one-time-code';
    input.spellcheck = false;
    input.maxLength = 32;
    input.placeholder = '確認コード';
    input.setAttribute('aria-label', '確認コード');
    wrap.append(input);
    const reveal = make('button', 'pill-button pc-setup-reveal', '表示');
    reveal.type = 'button';
    reveal.setAttribute('aria-pressed', 'false');
    reveal.addEventListener('click', () => {
      const visible = input.type === 'text';
      input.type = visible ? 'password' : 'text';
      reveal.textContent = visible ? '表示' : '隠す';
      reveal.setAttribute('aria-pressed', String(!visible));
      input.focus();
    });
    wrap.append(reveal);
    return { wrap, input };
  }

  function validContact(value) {
    const text = typeof value === 'string' ? value.trim() : '';
    return text.length >= 3 && text.length <= 320 ? text : '';
  }

  function validCode(value) {
    const text = typeof value === 'string' ? value.trim() : '';
    return text.length >= 4 && text.length <= 32 ? text : '';
  }

  function renderStart() {
    const intro = make('p', 'pc-setup-copy', snapshot.hasSdkToken
      ? '発行済みのSDK認証情報を再利用します。'
      : '開始すると、このアプリのSDK認証情報を準備します。');
    content.append(intro);

    let terms = null;
    if (!snapshot.hasSdkToken) {
      terms = make('label', 'pc-setup-terms');
      const checkbox = make('input');
      checkbox.type = 'checkbox';
      checkbox.id = 'pcSetupTerms';
      const text = make('span');
      text.append(document.createTextNode('SDK利用規約に同意します。 '));
      const link = make('a', '', '利用規約を読む');
      link.href = TERMS_URL;
      link.target = '_blank';
      link.rel = 'noreferrer';
      text.append(link);
      terms.append(checkbox, text);
      content.append(terms);
    }

    const start = () => {
      const accepted = !!(terms && terms.querySelector('input')?.checked);
      if (!snapshot.hasSdkToken && !accepted) {
        setStatus('SDK利用規約への同意が必要です。', 'error');
        terms?.querySelector('input')?.focus();
        return;
      }
      // Pass the explicit terms choice. When hasSdkToken is true this is
      // false, so an existing credential is reused/imported rather than
      // provisioned again.
      runOperation('pcAuthStart', accepted);
    };
    renderActions(snapshot.hasSdkToken ? '続行' : '開始', start);
  }

  function renderContact() {
    const input = make('input', 'dialog-input');
    input.id = 'pcSetupContact';
    input.type = 'text';
    input.autocomplete = 'username';
    input.inputMode = 'email';
    input.maxLength = 320;
    input.placeholder = 'メールアドレスまたは電話番号';
    input.setAttribute('aria-label', 'メールアドレスまたは電話番号');
    addFieldLabel(input, '連絡先');
    const send = () => {
      const contact = validContact(input.value);
      // Clear at the submit boundary so the value is not retained on error,
      // close, or a later phase.
      input.value = '';
      if (!contact) {
        setStatus('連絡先を入力してください。', 'error');
        input.focus();
        return;
      }
      runOperation('pcAuthSend', contact);
    };
    renderActions('コードを送る', send);
    focusLater(input.id);
  }

  function renderCode() {
    const field = makeCodeField('pcSetupCode');
    content.append(field.wrap);
    const confirm = () => {
      const code = validCode(field.input.value);
      field.input.value = '';
      if (!code) {
        setStatus('確認コードを入力してください。', 'error');
        field.input.focus();
        return;
      }
      runOperation('pcAuthConfirm', code);
    };
    renderActions('確認する', confirm);
    focusLater(field.input.id);
  }

  function appendChoiceGroup(title, entries, choose) {
    const group = make('fieldset', 'pc-setup-choice-group');
    group.append(make('legend', '', title));
    const list = make('div', 'pc-setup-choices');
    for (const entry of entries) {
      const choice = make('button', 'pc-setup-choice', entry.label);
      choice.type = 'button';
      choice.addEventListener('click', () => {
        if (!busy) choose(entry.index);
      });
      list.append(choice);
    }
    group.append(list);
    content.append(group);
  }

  function renderAccount() {
    if (!snapshot.accounts.length) {
      content.append(make('p', 'pc-setup-copy', '選択できるアカウントがありません。'));
      renderActions('状態を再確認', () => refreshState());
      return;
    }
    appendChoiceGroup('アカウント', snapshot.accounts, index => runOperation('pcAuthSelect', index));
    renderActions(null, null);
  }

  function renderTwoFactor() {
    if (!snapshot.methods.length) {
      content.append(make('p', 'pc-setup-copy', '利用できる2段階認証方法がありません。'));
      renderActions('状態を再確認', () => refreshState());
      return;
    }

    if (activeTwoFactorMethodIndex === null || !twoFactorCodeIssued) {
      appendChoiceGroup('認証方法', snapshot.methods, index => {
        activeTwoFactorMethodIndex = index;
        twoFactorCodeIssued = false;
        runOperation('pcAuthTwoFactorSend', index);
      });
      renderActions(null, null);
      return;
    }

    const method = snapshot.methods.find(entry => entry.index === activeTwoFactorMethodIndex);
    if (method) {
      content.append(make('p', 'pc-setup-copy', method.label + ' の確認コードを入力してください。'));
    }
    const field = makeCodeField('pcSetupTwoFactorCode');
    content.append(field.wrap);
    const confirm = () => {
      const code = validCode(field.input.value);
      field.input.value = '';
      if (!code) {
        setStatus('確認コードを入力してください。', 'error');
        field.input.focus();
        return;
      }
      runOperation('pcAuthTwoFactorConfirm', activeTwoFactorMethodIndex, code);
    };
    renderActions('確認する', confirm);
    const change = make('button', 'pc-setup-link', '認証方法を変更');
    change.type = 'button';
    change.addEventListener('click', () => {
      activeTwoFactorMethodIndex = null;
      twoFactorCodeIssued = false;
      render();
    });
    actions.insertBefore(change, actions.firstChild);
    focusLater(field.input.id);
  }

  function renderCheckpoint() {
    content.append(make('p', 'pc-setup-copy', 'ブラウザーで認証ページを開き、表示された手順を完了してください。'));
    const open = () => {
      if (!snapshot.checkpointUrl) {
        setStatus('認証ページを開けませんでした。状態を再確認してください。', 'error');
        return;
      }
      invoke('openLink', snapshot.checkpointUrl).catch(() => {
        setStatus('認証ページを開けませんでした。', 'error');
      });
    };
    actions.replaceChildren();
    setSubmit(refreshState);
    appendCancel();
    if (snapshot.checkpointUrl) appendPrimary('ブラウザーで開く', open);
    appendPrimary('認証状態を確認', refreshState);
  }

  function renderTerminal() {
    content.append(make('p', 'pc-setup-copy',
      snapshot.phase === 'ready'
        ? 'PCの認証が完了しました。'
        : 'このPCの認証情報が確認できました。'));
    actions.replaceChildren();
    setSubmit(null);
    appendCancel('閉じる');
    if (snapshot.phase === 'authenticated' && apiAvailable('pcConnect')) {
      appendPrimary('PCを接続', () => runOperation('pcConnect'));
    }
  }

  function renderError() {
    content.append(make('p', 'pc-setup-copy', '認証状態を確認できませんでした。もう一度状態を確認してください。'));
    renderActions('再試行', () => refreshState());
  }

  function render() {
    if (!dialog || !snapshot) return;
    description.textContent = phaseDescription(snapshot.phase);
    content.replaceChildren();
    actions.replaceChildren();
    submitAction = null;
    renderStatus();
    switch (snapshot.phase) {
      case 'start': renderStart(); break;
      case 'contact': renderContact(); break;
      case 'code': renderCode(); break;
      case 'account': renderAccount(); break;
      case 'two_factor': renderTwoFactor(); break;
      case 'checkpoint': renderCheckpoint(); break;
      case 'authenticated':
      case 'ready': renderTerminal(); break;
      default: renderError(); break;
    }
    setControlsDisabled(busy);
  }

  function isCurrent(id) {
    return id === operationId && dialog && dialog.open;
  }

  async function runOperation(method, ...args) {
    if (busy) return;
    const connectOperation = method === 'pcConnect';
    const id = ++operationId;
    busy = true;
    setControlsDisabled(true);
    renderStatus();
    try {
      let value = await invoke(method, ...args);
      if (!isCurrent(id)) return;
      // pcConnect is expected to return the same sanitized snapshot shape.
      // If a host returns no value, read the state once; do not invent success.
      if (!value || typeof value !== 'object') {
        if (connectOperation) value = await invoke('pcAuthState');
        else throw new Error(STATIC_ERROR);
      }
      snapshot = normalizeSnapshot(value);
      if (method === 'pcAuthTwoFactorSend') twoFactorCodeIssued = true;
      if (method !== 'pcAuthTwoFactorSend' && snapshot.phase !== 'two_factor') {
        activeTwoFactorMethodIndex = null;
        twoFactorCodeIssued = false;
      }
      busy = false;
      render();
      if (connectOperation && snapshot.phase === 'ready') notifyConnected(snapshot);
    } catch (error) {
      if (!isCurrent(id)) return;
      try { const latest=await invoke('pcAuthState');if(!isCurrent(id))return;snapshot=normalizeSnapshot(latest); } catch {}
      if (!isCurrent(id)) return;
      busy = false;
      snapshot = snapshot ? {...snapshot,message:safeMessage(error.message)||STATIC_ERROR} : errorSnapshot();
      render();
    } finally {
      if (isCurrent(id)) {
        busy = false;
        setControlsDisabled(false);
        renderStatus();
      }
    }
  }

  async function refreshState() {
    if (busy) return;
    const id = ++operationId;
    busy = true;
    setControlsDisabled(true);
    renderStatus();
    try {
      const value = await invoke('pcAuthState');
      if (!isCurrent(id)) return;
      snapshot = normalizeSnapshot(value);
      busy = false;
      render();
    } catch {
      if (!isCurrent(id)) return;
      busy = false;
      snapshot = errorSnapshot();
      render();
    } finally {
      if (isCurrent(id)) {
        busy = false;
        setControlsDisabled(false);
        renderStatus();
      }
    }
  }

  function notifyConnected(value) {
    const callback = window.onPcSetupConnected;
    if (typeof callback !== 'function') return;
    const safe = normalizeSnapshot(value);
    try {
      callback({
        phase: safe.phase,
        hasSdkToken: safe.hasSdkToken,
        hasDevice: safe.hasDevice,
      });
    } catch {}
  }

  function requestClose(reason) {
    if (!dialog) return;
    closeReason = reason || 'cancel';
    if (dialog.open) dialog.close();
  }

  async function openPcSetup() {
    if (!bindDialog()) return undefined;
    if (dialog.open) return snapshot;
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeReason = 'cancel';
    cancelRequested = false;
    activeTwoFactorMethodIndex = null;
    twoFactorCodeIssued = false;
    snapshot = normalizeSnapshot({ phase: 'start' });
    busy = true;
    dialog.showModal();
    description.textContent = 'PC認証の状態を確認しています。';
    content.replaceChildren();
    actions.replaceChildren();
    setStatus('処理中です…');
    setControlsDisabled(true);
    const id = ++operationId;
    try {
      const value = await invoke('pcAuthState');
      if (!isCurrent(id)) return snapshot;
      snapshot = normalizeSnapshot(value);
    } catch {
      if (!isCurrent(id)) return snapshot;
      snapshot = errorSnapshot();
    } finally {
      if (isCurrent(id)) {
        busy = false;
        render();
      }
    }
    return snapshot;
  }

  function isReady(value) {
    return !!value && value.phase === 'ready' && value.hasSdkToken && value.hasDevice;
  }

  function bindOpenButtons() {
    for (const id of ['tools', 'pcSetupSettings']) {
      const button = byId(id);
      if (!button || button.dataset.pcSetupBound === 'true') continue;
      button.dataset.pcSetupBound = 'true';
      button.addEventListener('click', event => {
        event.preventDefault();
        if (id === 'pcSetupSettings') byId('settingsDialog')?.close();
        openPcSetup();
      });
    }
  }

  function bindPcMode() {
    const button = byId('pcMode');
    if (!button || button.dataset.pcSetupBound === 'true') return;
    button.dataset.pcSetupBound = 'true';
    // app-renderer.js has a bubble listener that toggles PC mode. Capture
    // here first so an unauthenticated click cannot enable it accidentally.
    button.addEventListener('click', event => {
      if (allowNativePcModeClick) {
        allowNativePcModeClick = false;
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      openPcSetup().then(value => {
        if (isReady(value)) {
          allowNativePcModeClick = true;
          button.click();
        }
      }).catch(() => {});
    }, true);
  }

  function init() {
    const settings=byId('settingsDialog');
    if(settings&&!byId('pcSetupSettings')){
      const row=make('div','setting-row'),text=make('div');
      text.append(make('strong','','この PC の直接接続'),make('p','','PC の認証と接続状態を確認します。'));
      const button=make('button','pill-button','PC 接続の設定');button.id='pcSetupSettings';button.type='button';row.append(text,button);
      settings.insertBefore(row,settings.querySelector('.dialog-note'));
    }
    bindOpenButtons();
  }

  window.openPcSetup = openPcSetup;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
