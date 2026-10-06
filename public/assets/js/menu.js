// Accessible popover menu (Primer ActionMenu-like): button[aria-haspopup] + div[role=menu].
// Arrow/Home/End navigation, Enter/Space select, Esc + click-outside close, focus returns to the button.
// Items: { label, icon?, danger?, checked?, disabled?, title?, meta?, dot?, keepOpen?, onSelect }
//        | { divider: true } | { header: 'text' } | { text: 'muted note' }
import { el } from './ui.js';
import { icon } from './icons.js';
import { langDot } from './langcolors.js';

let openMenu = null; // { close }

function closeOpen() { openMenu?.close(false); }

document.addEventListener('mousedown', (e) => {
  if (openMenu && !openMenu.root.contains(e.target)) openMenu.close(false);
}, true);

/**
 * createMenu({ label, icon?, buttonClass?, align?: 'left'|'right', items: () => Item[] | Item[], ariaLabel?, selectable? })
 * → { root, button, setLabel(text), refresh(), close() }. `selectable` renders role=menuitemradio/checkbox + check column.
 */
export function createMenu({ label, icon: iconName, buttonClass = 'btn', align = 'left', items, ariaLabel, selectable = false, title, buttonContent }) {
  const root = el('div', { class: 'dropdown' });
  const labelSpan = el('span', { text: label });
  const button = el('button', {
    type: 'button', class: buttonClass, 'aria-haspopup': 'menu', 'aria-expanded': 'false',
    'aria-label': ariaLabel, title,
  });
  if (buttonContent) button.append(buttonContent);
  else {
    if (iconName) button.append(icon(iconName));
    button.append(labelSpan, icon('triangle-down'));
  }
  const menu = el('div', { class: `dropdown-menu${align === 'right' ? ' dropdown-menu-right' : ''}`, role: 'menu', tabindex: '-1', hidden: true });
  if (ariaLabel || label) menu.setAttribute('aria-label', ariaLabel || label);
  root.append(button, menu);

  const getItems = () => (typeof items === 'function' ? items() : items) || [];
  let entries = [];

  function build() {
    const frag = document.createDocumentFragment();
    entries = [];
    for (const it of getItems()) {
      if (it.divider) { frag.append(el('div', { class: 'dropdown-divider', role: 'separator' })); continue; }
      if (it.header) { frag.append(el('div', { class: 'dropdown-header', text: it.header })); continue; }
      if (it.text) { frag.append(el('div', { class: 'dropdown-text', text: it.text })); continue; }
      const role = selectable ? (it.multi ? 'menuitemcheckbox' : 'menuitemradio') : 'menuitem';
      const btn = el('button', {
        type: 'button', role, tabindex: '-1', title: it.title,
        class: `dropdown-item${it.danger ? ' dropdown-item-danger' : ''}`,
        'aria-disabled': it.disabled ? 'true' : undefined,
        'aria-checked': selectable ? String(Boolean(it.checked)) : undefined,
      });
      if (selectable) {
        const chk = el('span', { class: 'dropdown-check' });
        if (it.checked) chk.append(icon('check'));
        btn.append(chk);
      }
      if (it.dot !== undefined) btn.append(langDot(it.dot));
      if (it.icon) btn.append(icon(it.icon));
      btn.append(el('span', { class: 'truncate', text: it.label }));
      if (it.meta !== undefined) btn.append(el('span', { class: 'dropdown-meta', text: String(it.meta) }));
      btn.addEventListener('click', () => activate(it));
      entries.push(btn);
      frag.append(btn);
    }
    menu.replaceChildren(frag);
  }

  function activate(it) {
    if (it.disabled) return;
    if (!it.keepOpen) close(true);
    try { it.onSelect?.(); } catch { /* handler errors must not break the menu */ }
    if (it.keepOpen) { const i = entries.indexOf(document.activeElement); build(); focusAt(Math.max(0, i)); }
  }

  function focusAt(i) {
    if (!entries.length) { menu.focus(); return; }
    const n = entries.length;
    entries[((i % n) + n) % n].focus();
  }

  function open(focusLast = false) {
    if (openMenu && openMenu.root !== root) closeOpen();
    build();
    menu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    openMenu = api;
    const checked = entries.findIndex((b) => b.getAttribute('aria-checked') === 'true');
    focusAt(focusLast ? entries.length - 1 : checked >= 0 ? checked : 0);
  }

  function close(returnFocus = true) {
    if (menu.hidden) return;
    menu.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    if (openMenu === api) openMenu = null;
    if (returnFocus) button.focus();
  }

  button.addEventListener('click', () => (menu.hidden ? open() : close()));
  button.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); open(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); open(true); }
  });
  menu.addEventListener('keydown', (e) => {
    const i = entries.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); focusAt(i + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); focusAt(i - 1); }
    else if (e.key === 'Home') { e.preventDefault(); focusAt(0); }
    else if (e.key === 'End') { e.preventDefault(); focusAt(entries.length - 1); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
    else if (e.key === 'Tab') close(false);
  });

  const api = {
    root, button, menu,
    setLabel(text) { labelSpan.textContent = text; },
    refresh() { if (!menu.hidden) build(); },
    close,
    open,
  };
  return api;
}
