// Primer-style flash toasts (bottom-right, auto-dismiss). Container #toasts is aria-live="polite".
import { el } from './ui.js';
import { icon } from './icons.js';

const KIND = {
  success: ['flash-success', 'check'],
  error: ['flash-error', 'alert'],
  info: ['flash-info', 'info'],
};

export function toast(message, kind = 'info', { timeout = kind === 'error' ? 8000 : 4000 } = {}) {
  const root = document.getElementById('toasts');
  if (!root) return undefined;
  const [cls, ic] = KIND[kind] || KIND.info;
  let removed = false;
  const remove = () => { if (!removed) { removed = true; node.remove(); } };
  const node = el('div', { class: `flash flash-toast ${cls} pointer-events-auto`, role: kind === 'error' ? 'alert' : 'status' },
    icon(ic),
    el('span', { class: 'min-w-0 flex-1 break-words', text: message }),
    el('button', { type: 'button', class: 'btn btn-octicon btn-sm -my-1 -mr-2', 'aria-label': 'Dismiss notification', onClick: remove }, icon('x')));
  root.append(node);
  while (root.children.length > 5) root.firstElementChild.remove();
  if (timeout > 0) setTimeout(remove, timeout);
  return remove;
}

export const success = (m) => toast(m, 'success');
export const error = (m) => toast(m, 'error');
export const info = (m) => toast(m, 'info');
