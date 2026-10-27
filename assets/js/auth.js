// Аккаунты UIB Hub: баркод + свой пароль + никнейм. Проверяет и хранит их Worker (worker/src/index.js).
// Смотреть сайт можно без входа; вход нужен, чтобы добавить работу, отправить заявку или скачать файл.
import { CONFIG } from './config.js';
import { emoji } from './emoji.js';
import { escapeHtml, storage } from './utils.js';

const SESSION_KEY = 'uibhub.session';
const BARCODE_RE = /^\d{5,10}$/;
const NICKNAME_RE = /^[\p{L}\p{N}_. -]{2,24}$/u;
const TELEGRAM_RE = /^@?[A-Za-z0-9_]{5,32}$/;

// Те же id проверяет Worker; картинки лежат в assets/avatars/
export const AVATARS = [
  { id: 'it', label: 'IT' },
  { id: 'marketing', label: 'Креатив и PR' },
  { id: 'finance', label: 'Финансы' },
  { id: 'accounting', label: 'Учёт' },
  { id: 'logistics', label: 'Логистика' },
  { id: 'intl', label: 'Межд. отношения' },
  { id: 'management', label: 'Менеджмент' },
  { id: 'law', label: 'Право' },
  { id: 'journalism', label: 'Журналистика' },
];

// Коды ошибок Worker'а
const ERRORS = {
  bad_barcode: 'Баркод — это 5–10 цифр со студенческого.',
  bad_nickname: 'Ник: от 2 до 24 символов, буквы, цифры, пробел, точка, _ или -.',
  bad_password: 'Пароль должен быть не короче 8 символов.',
  bad_contact: 'Telegram: ник латиницей, 5–32 символа, например @username.',
  bad_code: 'Неверный или устаревший код. Попроси у модератора новый.',
  barcode_taken: 'Аккаунт с этим баркодом уже есть. Попробуй войти.',
  nickname_taken: 'Такой ник уже занят, придумай другой.',
  bad_credentials: 'Неверный баркод или пароль.',
  too_many_attempts: 'Слишком много попыток. Подожди 15 минут.',
  rate_limited: 'Слишком много запросов с этого адреса. Попробуй через час.',
};

// Что показывать в окне в каждом режиме
const MODES = {
  login: { title: 'Вход', button: 'Войти', endpoint: '/auth/login' },
  register: { title: 'Регистрация', button: 'Создать аккаунт', endpoint: '/auth/register' },
  forgot: { title: 'Восстановление пароля', button: 'Отправить заявку', endpoint: '/auth/reset-request' },
  reset: { title: 'Новый пароль', button: 'Сохранить пароль', endpoint: '/auth/reset' },
};

let session = storage.get(SESSION_KEY, null); // { token, user: { nickname, barcode_hint, avatar } }
let mode = 'login';
let waiting = null; // resolve() для requireLogin, пока открыто окно входа
const listeners = new Set();
const el = {};

export const currentUser = () => session?.user ?? null;
export const onAuthChange = (fn) => listeners.add(fn);

export function avatarImage(id, size, className = '') {
  return `<img src="assets/avatars/${escapeHtml(id)}.jpg" alt="" width="${size}" height="${size}" style="width:${size}px;height:${size}px" loading="lazy" class="flex-none rounded-full object-cover ${className}">`;
}

// Аватарка, а без неё — кружок с первой буквой ника
function userBadge(user, size) {
  if (user.avatar) return avatarImage(user.avatar, size, 'ring-2 ring-white shadow-sm');
  return `<span class="grid flex-none place-items-center rounded-full bg-gradient-to-br from-brand-500 to-fuchsia-500 font-bold text-white" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.4)}px">${escapeHtml([...user.nickname][0].toUpperCase())}</span>`;
}

function setSession(next) {
  session = next;
  if (next) storage.set(SESSION_KEY, next);
  else storage.remove(SESSION_KEY);
  renderAccount();
  listeners.forEach((fn) => fn(currentUser()));
}

// Запрос к Worker'у с токеном сессии. Если сессия истекла, выходим из аккаунта
export async function api(path, { method = 'GET', body, json } = {}) {
  const headers = {};
  if (session?.token) headers.Authorization = `Bearer ${session.token}`;
  if (json !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${CONFIG.API_BASE}${path}`, {
    method,
    headers,
    body: json !== undefined ? JSON.stringify(json) : body,
  });
  if (res.status === 401 && session) setSession(null);
  return res;
}

// Открывает окно входа, если нужно. true — пользователь вошёл, false — закрыл окно
export function requireLogin(reason) {
  if (currentUser()) return Promise.resolve(true);
  openDialog(reason);
  return new Promise((resolve) => { waiting = resolve; });
}

export function initAuth() {
  for (const id of ['dialog', 'form', 'title', 'reason', 'error', 'notice', 'submit', 'tabs']) el[id] = document.getElementById(`auth-${id}`);
  el.profileDialog = document.getElementById('profile-dialog');
  el.profileAvatars = document.getElementById('profile-avatars');
  el.profileHeader = document.getElementById('profile-header');
  el.boxes = document.querySelectorAll('[data-account]');

  document.addEventListener('click', (event) => {
    if (event.target.closest('[data-login]')) openDialog('');
    if (event.target.closest('[data-profile]')) openProfile();
    if (event.target.closest('[data-logout]')) logout();
    const switchTo = event.target.closest('[data-auth-mode]');
    if (switchTo) setMode(switchTo.dataset.authMode);
  });
  el.tabs.addEventListener('click', (event) => {
    const tab = event.target.closest('[data-mode]');
    if (tab) setMode(tab.dataset.mode);
  });
  for (const dialog of [el.dialog, el.profileDialog]) {
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog || event.target.closest('[data-close]')) dialog.close();
    });
  }
  el.dialog.addEventListener('close', () => {
    waiting?.(Boolean(currentUser()));
    waiting = null;
  });
  el.form.addEventListener('submit', onSubmit);
  el.profileAvatars.addEventListener('click', (event) => {
    const option = event.target.closest('[data-avatar]');
    if (option) chooseAvatar(option.dataset.avatar || null);
  });

  renderAccount();
  refreshSession();
}

// Ник или аватарку могли поменять, а сессию — завершить на другом устройстве
async function refreshSession() {
  if (!session?.token || !CONFIG.API_BASE) return;
  try {
    const res = await api('/auth/me');
    if (res.ok) setSession({ ...session, user: (await res.json()).user });
  } catch {
    // Нет сети — остаёмся в аккаунте, проверим в следующий раз
  }
}

function openDialog(reason) {
  el.reason.textContent = reason || 'Войди по баркоду, чтобы добавлять работы, заявки и скачивать файлы.';
  setMode(mode === 'forgot' || mode === 'reset' ? 'login' : mode);
  el.dialog.showModal();
  el.form.elements.barcode.focus();
}

function setMode(next) {
  mode = next;
  const config = MODES[mode];
  el.title.textContent = config.title;
  el.submit.textContent = config.button;
  el.form.querySelectorAll('[data-modes]').forEach((node) => {
    node.classList.toggle('hidden', !node.dataset.modes.split(' ').includes(mode));
  });
  el.form.elements.password.autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  el.tabs.classList.toggle('hidden', mode === 'forgot' || mode === 'reset');
  el.tabs.querySelectorAll('[data-mode]').forEach((tab) => {
    const active = tab.dataset.mode === mode;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-pressed', active);
  });
  el.error.textContent = '';
  el.notice.textContent = '';
}

function validate(f) {
  if (!BARCODE_RE.test(f.barcode.value.trim())) return ERRORS.bad_barcode;
  if (mode === 'register' && (!NICKNAME_RE.test(f.nickname.value.trim()) || f.nickname.value.trim().toLowerCase() === 'аноним')) return ERRORS.bad_nickname;
  if (mode === 'forgot' && !TELEGRAM_RE.test(f.contact.value.trim())) return ERRORS.bad_contact;
  if (mode === 'reset' && f.code.value.replace(/[^A-Za-z0-9]/g, '').length !== 8) return 'Код из 8 символов, например ABCD-2345.';
  if (mode === 'register' || mode === 'reset') {
    if (f.password.value.length < 8) return ERRORS.bad_password;
    if (f.password.value !== f.password2.value) return 'Пароли не совпадают.';
  }
  if (mode === 'login' && !f.password.value) return 'Введи пароль.';
  return '';
}

function payload(f) {
  const barcode = f.barcode.value.trim();
  if (mode === 'login') return { barcode, password: f.password.value };
  if (mode === 'register') return { barcode, password: f.password.value, nickname: f.nickname.value.trim() };
  if (mode === 'forgot') return { barcode, contact: f.contact.value.trim() };
  return { barcode, code: f.code.value, password: f.password.value };
}

async function onSubmit(event) {
  event.preventDefault();
  const f = el.form.elements;
  const problem = validate(f);
  el.error.textContent = problem;
  el.notice.textContent = '';
  if (problem) return;

  const label = el.submit.textContent;
  el.submit.disabled = true;
  el.submit.textContent = 'Секунду…';
  try {
    const res = await api(MODES[mode].endpoint, { method: 'POST', json: payload(f) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      el.error.textContent = ERRORS[data.error] ?? 'Что-то пошло не так. Попробуй ещё раз.';
      return;
    }
    if (mode === 'forgot') {
      // Баркод оставляем: он понадобится, когда придёт код
      el.notice.textContent = 'Заявка у модераторов. Они напишут тебе в Telegram, попросят фото студенческого и пришлют код. Когда получишь его, нажми «У меня есть код».';
      return;
    }
    el.form.reset();
    setSession({ token: data.token, user: data.user });
    el.dialog.close();
  } catch (err) {
    console.error(err);
    el.error.textContent = 'Нет связи с сервером. Проверь интернет.';
  } finally {
    el.submit.disabled = false;
    el.submit.textContent = label;
  }
}

async function logout() {
  el.profileDialog.close();
  try { await api('/auth/logout', { method: 'POST' }); } catch { /* выйдем и без сервера */ }
  setSession(null);
}

// --- Профиль: аватарка и выход ---

function openProfile() {
  renderProfile();
  el.profileDialog.showModal();
}

function renderProfile() {
  const user = currentUser();
  if (!user) return;
  el.profileHeader.innerHTML = `
    ${userBadge(user, 64)}
    <div class="min-w-0">
      <div class="truncate font-display text-lg font-semibold text-slate-900">${escapeHtml(user.nickname)}</div>
      <div class="text-sm text-slate-400">баркод ${escapeHtml(user.barcode_hint)}</div>
    </div>`;
  const option = (id, inner, label) => {
    const active = (user.avatar ?? '') === id;
    return `
      <button type="button" data-avatar="${id}" aria-pressed="${active}" title="${escapeHtml(label)}"
        class="group flex flex-col items-center gap-1.5 rounded-2xl p-2 text-xs font-semibold transition ${active ? 'bg-brand-50 text-brand-700 ring-2 ring-brand-500' : 'text-slate-500 hover:bg-slate-50'}">
        ${inner}
        <span class="w-full truncate text-center">${escapeHtml(label)}</span>
      </button>`;
  };
  el.profileAvatars.innerHTML = [
    ...AVATARS.map((a) => option(a.id, avatarImage(a.id, 72, 'transition group-hover:scale-105'), a.label)),
    option('', `<span class="grid h-[72px] w-[72px] place-items-center rounded-full bg-slate-100 text-2xl font-bold text-slate-400">${escapeHtml([...user.nickname][0].toUpperCase())}</span>`, 'Без аватарки'),
  ].join('');
}

async function chooseAvatar(avatar) {
  const user = currentUser();
  if (!user || (user.avatar ?? null) === avatar) return;
  // Сразу показываем выбор, а если сервер откажет — откатываем
  const previous = session;
  setSession({ ...session, user: { ...user, avatar } });
  renderProfile();
  try {
    const res = await api('/auth/profile', { method: 'POST', json: { avatar } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    setSession({ ...session, user: (await res.json()).user });
  } catch (err) {
    console.error(err);
    if (currentUser()) setSession(previous);
  }
  renderProfile();
}

function renderAccount() {
  const user = currentUser();
  el.boxes?.forEach((box) => {
    const compact = box.dataset.account === 'compact';
    if (!user) {
      box.innerHTML = compact
        ? '<button type="button" data-login class="btn-secondary px-3 py-2">Войти</button>'
        : `<button type="button" data-login class="btn-secondary w-full">${emoji('key', 18)}Войти по баркоду</button>`;
      return;
    }
    box.innerHTML = compact
      ? `<button type="button" data-profile class="flex items-center gap-2 rounded-full p-0.5 pr-2 text-sm font-semibold text-slate-700 ring-1 ring-slate-200" aria-label="Профиль">${userBadge(user, 32)}<span class="max-w-[7rem] truncate">${escapeHtml(user.nickname)}</span></button>`
      : `<button type="button" data-profile class="flex w-full items-center gap-3 rounded-2xl bg-slate-50 p-2.5 text-left ring-1 ring-slate-100 transition hover:bg-slate-100" aria-label="Профиль">
          ${userBadge(user, 40)}
          <span class="min-w-0 flex-1">
            <span class="block truncate text-sm font-bold text-slate-800">${escapeHtml(user.nickname)}</span>
            <span class="block text-xs text-slate-400">${user.avatar ? 'профиль' : 'выбрать аватарку'}</span>
          </span>
          <svg class="shrink-0 text-slate-400" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m9 6 6 6-6 6"/></svg>
        </button>`;
  });
}
