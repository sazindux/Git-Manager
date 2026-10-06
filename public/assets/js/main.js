import { get, post } from './api.js';
import { state, on, setUser, setTab } from './state.js';
import { $, $$, el, show, formatNumber } from './ui.js';
import * as toast from './toast.js';
import { APP_NAME } from './config.js';
import { icon, appMark } from './icons.js';
import { createMenu } from './menu.js';

const ERROR_MESSAGES = {
  access_denied: 'GitHub sign-in was cancelled.',
  bad_state: 'Sign-in failed (state mismatch). Please try again.',
  bad_code: 'Sign-in failed (invalid code). Please try again.',
  exchange_failed: 'Sign-in failed while talking to GitHub. Please try again.',
  user_failed: 'Signed in, but could not read your GitHub profile.',
  server_config: 'The server is missing its OAuth configuration.',
};

function showView(name) {
  show($('#view-loading'), name === 'loading');
  show($('#view-landing'), name === 'landing');
  show($('#view-dashboard'), name === 'dashboard');
  const skip = $('a[href^="#"]');
  if (skip) skip.setAttribute('href', name === 'landing' ? '#view-landing' : '#main');
}

function applyBranding() {
  document.title = APP_NAME;
  for (const n of $$('[data-app-name]')) n.textContent = APP_NAME;
  for (const n of $$('[data-app-name-heading]')) n.textContent = `Sign in to ${APP_NAME}`;
  $('#landing-mark')?.replaceWith(appMark(48));
  $('#header-mark')?.replaceWith(appMark(32));
  $('#login-mark')?.replaceWith(icon('mark-github'));
  for (const n of $$('[data-icon]')) n.prepend(icon(n.dataset.icon));
}

const AVATAR_RE = /^https:\/\/avatars\.githubusercontent\.com\//;
let profileMenu = null;

function avatarNode(user, size) {
  if (user?.avatar_url && AVATAR_RE.test(user.avatar_url)) {
    return el('img', { class: 'avatar', src: user.avatar_url, alt: '', width: size, height: size });
  }
  return el('span', { class: 'app-mark' }, icon('person'));
}

function buildProfileMenu() {
  const host = $('#profile-menu');
  if (!host) return;
  profileMenu = createMenu({
    ariaLabel: 'Open user menu',
    buttonClass: 'btn btn-octicon rounded-full',
    align: 'right',
    buttonContent: el('span', { class: 'inline-flex', id: 'avatar-slot' }, avatarNode(state.user, 32)),
    items: () => {
      const u = state.user;
      const scopes = u?.scopes?.length ? u.scopes.join(', ') : 'none';
      return [
        { header: `Signed in as ${u?.login || '—'}` },
        { text: `Scopes: ${scopes}` },
        { divider: true },
        { label: 'Your GitHub profile', icon: 'person', onSelect: () => { if (u?.login) window.open(`https://github.com/${encodeURIComponent(u.login)}`, '_blank', 'noopener,noreferrer'); } },
        { divider: true },
        { label: 'Sign out', icon: 'sign-out', onSelect: logout },
      ];
    },
  });
  host.replaceWith(profileMenu.root);
}

function renderUser(user) {
  const slot = $('#avatar-slot');
  if (slot) slot.replaceChildren(avatarNode(user, 32));
  if (profileMenu) profileMenu.button.title = user?.login ? `Signed in as ${user.login}` : '';
}

function renderRate(rate) {
  const badge = $('#rate-badge');
  if (rate.remaining === null) { badge.textContent = 'API —'; return; }
  badge.textContent = `${formatNumber(rate.remaining)}${rate.limit ? ` / ${formatNumber(rate.limit)}` : ''}`;
  const limit = rate.limit || 5000;
  badge.className = rate.remaining < limit * 0.04 ? 'Label Label--danger' : rate.remaining < limit * 0.2 ? 'Label Label--attention' : 'Label';
  badge.title = `GitHub API requests remaining${rate.reset ? ` · resets at ${new Date(rate.reset * 1000).toLocaleTimeString()}` : ''}`;
}

function renderCounts() {
  const c = $('#count-repos');
  if (!c) return;
  c.textContent = formatNumber(state.repos.length);
  show(c, state.reposLoaded || state.repos.length > 0);
}

function wireTabs() {
  const buttons = $$('[data-tab]');
  const apply = (tab) => {
    for (const b of buttons) {
      const on = b.dataset.tab === tab;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    }
    for (const t of ['repos', 'cleanup', 'analytics']) show($(`#tab-${t}`), t === tab);
  };
  for (const b of buttons) {
    b.addEventListener('click', () => setTab(b.dataset.tab));
    b.addEventListener('keydown', (e) => {
      const i = buttons.indexOf(b);
      let j = null;
      if (e.key === 'ArrowRight') j = (i + 1) % buttons.length;
      else if (e.key === 'ArrowLeft') j = (i - 1 + buttons.length) % buttons.length;
      else if (e.key === 'Home') j = 0;
      else if (e.key === 'End') j = buttons.length - 1;
      if (j === null) return;
      e.preventDefault();
      setTab(buttons[j].dataset.tab);
      buttons[j].focus();
    });
  }
  on('tab', apply);
  apply(state.activeTab);
}

let loggingOut = false;
async function logout() {
  if (loggingOut) return;
  loggingOut = true;
  try { await post('/api/auth/logout'); } catch { /* cookie is cleared server-side regardless */ }
  setUser(null);
  showView('landing');
  loggingOut = false;
  toast.info('Signed out.');
}

function handleUrlError() {
  const params = new URLSearchParams(location.search);
  const code = params.get('error');
  if (code) {
    toast.error(ERROR_MESSAGES[code] || 'Sign-in failed.');
    history.replaceState(null, '', location.pathname);
  }
}

async function bootstrap() {
  showView('loading');
  handleUrlError();
  applyBranding();
  wireTabs();
  buildProfileMenu();
  on('user', renderUser);
  on('repos', renderCounts);
  on('rate', renderRate);
  on('unauthorized', () => { if (state.user) { setUser(null); showView('landing'); toast.error('Session expired – please sign in again.'); } });

  try {
    const me = await get('/api/me');
    setUser(me);
    showView('dashboard');
    const { initDashboard } = await import('./dashboard.js');
    await initDashboard();
  } catch (err) {
    if (err?.status === 401) showView('landing');
    else {
      showView('landing');
      toast.error(err?.message || 'Could not reach the server.');
    }
  }
}

bootstrap();
