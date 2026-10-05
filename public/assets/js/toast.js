import { el } from './ui.js';

const KIND_CLASS = {
  success: 'border-emerald-400/40 bg-emerald-500/15 text-emerald-100',
  error: 'border-rose-400/40 bg-rose-500/15 text-rose-100',
  info: 'border-sky-400/40 bg-sky-500/15 text-sky-100',
};

export function toast(message, kind = 'info', { timeout = kind === 'error' ? 8000 : 4000 } = {}) {
  const root = document.getElementById('toasts');
  if (!root) return;
  const node = el('div', {
    class: `pointer-events-auto glass-strong flex items-start gap-3 border px-4 py-3 text-sm ${KIND_CLASS[kind] || KIND_CLASS.info}`,
    role: kind === 'error' ? 'alert' : 'status',
  },
    el('span', { class: 'flex-1 break-words', text: message }),
    el('button', { type: 'button', class: 'text-current/70 hover:text-current', 'aria-label': 'Dismiss', onClick: () => remove() }, '×'),
  );
  let removed = false;
  const remove = () => { if (!removed) { removed = true; node.remove(); } };
  root.append(node);
  while (root.children.length > 5) root.firstElementChild.remove();
  if (timeout > 0) setTimeout(remove, timeout);
  return remove;
}

export const success = (m) => toast(m, 'success');
export const error = (m) => toast(m, 'error');
export const info = (m) => toast(m, 'info');
