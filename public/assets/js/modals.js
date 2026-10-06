// Accessible modal dialogs with focus trap and safety confirmations. Text only via textContent.
import { el, formatNumber } from './ui.js';
import { icon } from './icons.js';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Open a modal. `build({ close, setConfirmEnabled, confirmBtn })` returns body nodes.
 * Resolves with the value passed to `close(value)`; Esc / backdrop / Cancel resolve `null`.
 */
export function openModal({ title, build, confirmLabel = 'Confirm', confirmClass = 'btn btn-primary', cancelLabel = 'Cancel', width = '', danger = false }) {
  const root = document.getElementById('modal-root');
  const previouslyFocused = document.activeElement;
  return new Promise((resolve) => {
    let settled = false;
    const close = (value = null) => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      document.body.classList.remove('overflow-hidden');
      previouslyFocused?.focus?.();
      resolve(value);
    };
    const confirmBtn = el('button', { type: 'button', class: confirmClass }, confirmLabel);
    const cancelBtn = el('button', { type: 'button', class: 'btn', onClick: () => close(null) }, cancelLabel);
    const closeX = el('button', { type: 'button', class: 'btn btn-octicon', 'aria-label': 'Close dialog', onClick: () => close(null) }, icon('x'));
    const setConfirmEnabled = (v) => { confirmBtn.disabled = !v; };
    const titleId = `modal-title-${Math.random().toString(36).slice(2, 8)}`;
    const body = el('div', { class: 'Overlay-body' });
    const dialog = el('div', {
      class: `Overlay${width === 'wide' ? ' Overlay--wide' : ''}`, role: danger ? 'alertdialog' : 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabindex: '-1',
    },
      el('div', { class: 'Overlay-header' }, el('h2', { id: titleId, class: 'Overlay-title', text: title }), closeX),
      body,
      el('div', { class: 'Overlay-footer' }, cancelBtn, confirmBtn));
    const overlay = el('div', {
      class: 'Overlay-backdrop',
      onMousedown: (ev) => { if (ev.target === overlay) close(null); },
    }, dialog);
    const result = build({ close, setConfirmEnabled, confirmBtn, body });
    if (result) body.append(...(Array.isArray(result) ? result : [result]));
    confirmBtn.addEventListener('click', () => { if (!confirmBtn.disabled) close(confirmBtn._value ?? true); });

    function onKey(ev) {
      if (ev.key === 'Escape') { ev.preventDefault(); close(null); return; }
      if (ev.key === 'Tab') {
        const nodes = Array.from(dialog.querySelectorAll(FOCUSABLE)).filter((n) => n.offsetParent !== null);
        if (!nodes.length) { ev.preventDefault(); dialog.focus(); return; }
        const first = nodes[0]; const last = nodes[nodes.length - 1];
        if (ev.shiftKey && (document.activeElement === first || document.activeElement === dialog)) { ev.preventDefault(); last.focus(); }
        else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
      }
    }
    document.addEventListener('keydown', onKey, true);
    document.body.classList.add('overflow-hidden');
    root.append(overlay);
    const firstInput = dialog.querySelector('input, select, textarea');
    (firstInput || cancelBtn).focus();
  });
}

const FLASH_ICON = { error: 'alert', warn: 'alert', success: 'check', info: 'info' };
function flash(kind, children) {
  return el('div', { class: `flash flash-${kind}` }, icon(FLASH_ICON[kind] || 'info'), el('div', {}, ...children));
}

function repoList(repos) {
  const ul = el('ul', { class: 'repo-chip-list', 'aria-label': 'Affected repositories' });
  for (const r of repos) ul.append(el('li', { text: r.full_name || r.name, title: r.full_name || r.name }));
  return ul;
}

function phraseInput({ phrase, label, onChange }) {
  const id = `phrase-${Math.random().toString(36).slice(2, 8)}`;
  const input = el('input', { id, class: 'form-control form-control-block font-mono', type: 'text', autocomplete: 'off', spellcheck: 'false', 'aria-describedby': `${id}-hint` });
  input.addEventListener('input', () => onChange(input.value.trim() === phrase));
  return el('div', {},
    el('label', { for: id, class: 'form-label font-normal' }, label, ' ', el('code', { class: 'phrase font-mono', text: phrase }), ' to confirm'),
    input, el('p', { id: `${id}-hint`, class: 'sr-only', text: `Type the phrase ${phrase} exactly to enable the confirm button.` }));
}

/** Delete confirmation: list, phrase, checkbox, 3-second countdown. Resolves true/null. */
export function confirmDelete(repos) {
  const n = repos.length;
  const phrase = `delete ${n} repositories`;
  return openModal({
    title: `Delete ${formatNumber(n)} ${n === 1 ? 'repository' : 'repositories'}`,
    confirmLabel: 'Delete permanently', confirmClass: 'btn btn-danger-solid', danger: true,
    build: ({ setConfirmEnabled, confirmBtn }) => {
      let phraseOk = false; let ack = false; let countdownDone = false;
      const baseLabel = 'Delete permanently';
      const update = () => setConfirmEnabled(phraseOk && ack && countdownDone);
      setConfirmEnabled(false);
      let left = 3;
      confirmBtn.textContent = `${baseLabel} (${left})`;
      const timer = setInterval(() => {
        left -= 1;
        if (left <= 0) { clearInterval(timer); countdownDone = true; confirmBtn.textContent = baseLabel; update(); }
        else confirmBtn.textContent = `${baseLabel} (${left})`;
      }, 1000);
      const chk = el('input', { type: 'checkbox', class: 'mt-0.5 shrink-0' });
      chk.addEventListener('change', () => { ack = chk.checked; update(); });
      return [
        flash('error', ['This permanently deletes the repositories below, including all code, issues, pull requests, wikis and releases. ',
          el('strong', { text: 'This cannot be undone.' })]),
        repoList(repos),
        phraseInput({ phrase, label: 'Type', onChange: (ok) => { phraseOk = ok; update(); } }),
        el('label', { class: 'flex items-start gap-2' }, chk, 'I understand this cannot be undone'),
      ];
    },
  });
}

/** Make-public confirmation. Resolves true/null. */
export function confirmMakePublic(repos) {
  const phrase = 'make public';
  return openModal({
    title: `Make ${formatNumber(repos.length)} ${repos.length === 1 ? 'repository' : 'repositories'} public`,
    confirmLabel: 'Make public', confirmClass: 'btn btn-danger-solid', danger: true,
    build: ({ setConfirmEnabled }) => {
      setConfirmEnabled(false);
      return [
        flash('error', ['Warning: all code, commit history, issues and secrets accidentally committed in these repositories become visible to everyone on the internet immediately.']),
        repoList(repos),
        phraseInput({ phrase, label: 'Type', onChange: setConfirmEnabled }),
      ];
    },
  });
}

/** Transfer confirmation; `newOwner` must be re-typed. Resolves true/null. */
export function confirmTransfer(repos, newOwner) {
  return openModal({
    title: `Transfer ${formatNumber(repos.length)} ${repos.length === 1 ? 'repository' : 'repositories'} to ${newOwner}`,
    confirmLabel: 'Start transfer', confirmClass: 'btn btn-danger-solid', danger: true,
    build: ({ setConfirmEnabled }) => {
      setConfirmEnabled(false);
      return [
        flash('warn', ['Ownership moves to ', el('strong', { class: 'font-mono', text: newOwner }), '. Transfers to a personal account must be accepted by the recipient within one day; transfers to an organization you administer complete immediately. Repository names are kept.']),
        repoList(repos),
        phraseInput({ phrase: newOwner, label: 'Type the target owner', onChange: setConfirmEnabled }),
      ];
    },
  });
}

/** Simple confirmation with count. Resolves true/null. */
export function confirmSimple({ title, message, repos, confirmLabel = 'Confirm', confirmClass = 'btn btn-primary' }) {
  return openModal({
    title, confirmLabel, confirmClass,
    build: () => [el('p', { text: message }), repos ? repoList(repos) : null].filter(Boolean),
  });
}

/** Prompt with a text input; `validate(value)` returns an error string or ''. Resolves string/null. */
export function promptText({ title, label, placeholder = '', hint = '', validate = () => '', confirmLabel = 'Continue', initial = '' }) {
  return openModal({
    title, confirmLabel,
    build: ({ setConfirmEnabled, confirmBtn }) => {
      const id = `prompt-${Math.random().toString(36).slice(2, 8)}`;
      const err = el('p', { class: 'note text-danger', 'aria-live': 'polite' });
      const input = el('input', { id, class: 'form-control form-control-block', type: 'text', placeholder, autocomplete: 'off', spellcheck: 'false' });
      input.value = initial;
      const check = () => {
        const v = input.value.trim();
        const e = v ? validate(v) : '';
        err.textContent = e;
        setConfirmEnabled(!!v && !e);
        confirmBtn._value = v;
      };
      input.addEventListener('input', check);
      input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && !confirmBtn.disabled) confirmBtn.click(); });
      check();
      return [el('div', {}, el('label', { for: id, class: 'form-label', text: label }), input, hint ? el('p', { class: 'note mt-1', text: hint }) : null, err)].filter(Boolean);
    },
  });
}
