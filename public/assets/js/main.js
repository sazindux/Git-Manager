import { get, post } from './api.js';
import { state, on, setUser, setTab } from './state.js';
import { $, $$, show } from './ui.js';
import * as toast from './toast.js';

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
}

function renderUser(user) {
  const avatar = $('#user-avatar');
  if (user?.avatar_url && /^https:\/\/avatars\.githubusercontent\.com\//.test(user.avatar_url)) {
    avatar.src = user.avatar_url;
    avatar.alt = `${user.login} avatar`;
  } else {
    avatar.removeAttribute('src');
  }
  $('#user-login').textContent = user?.login || '';
}

function renderRate(rate) {
  const badge = $('#rate-badge');
  if (rate.remaining === null) { badge.textContent = 'API: —'; return; }
  badge.textContent = `API: ${rate.remaining}${rate.limit ? ` / ${rate.limit}` : ''}`;
  badge.className = rate.remaining < 200 ? 'badge-danger' : rate.remaining < 1000 ? 'badge-warn' : 'badge';
  if (rate.reset) badge.title = `Resets at ${new Date(rate.reset * 1000).toLocaleTimeString()}`;
}

function wireTabs() {
  const buttons = $$('[data-tab]');
  const apply = (tab) => {
    for (const b of buttons) b.setAttribute('aria-pressed', String(b.dataset.tab === tab));
    for (const t of ['repos', 'cleanup', 'analytics']) show($(`#tab-${t}`), t === tab);
  };
  for (const b of buttons) b.addEventListener('click', () => setTab(b.dataset.tab));
  on('tab', apply);
  apply(state.activeTab);
}

async function logout() {
  const btn = $('#btn-logout');
  btn.disabled = true;
  try { await post('/api/auth/logout'); } catch { /* cookie is cleared server-side regardless */ }
  setUser(null);
  showView('landing');
  btn.disabled = false;
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
  wireTabs();
  $('#btn-logout').addEventListener('click', logout);
  on('user', renderUser);
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
