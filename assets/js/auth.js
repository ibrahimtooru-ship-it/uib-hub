// Аккаунты UIB Hub: баркод + свой пароль + никнейм. Проверяет и хранит их Worker (worker/src/index.js).
// Смотреть сайт можно без входа; вход нужен, чтобы добавить работу или скачать файл.
import { CONFIG } from './config.js';
import { emoji } from './emoji.js';
import { escapeHtml, storage } from './utils.js';

const SESSION_KEY = 'uibhub.session';
const BARCODE_RE = /^\d{5,10}$/;
const NICKNAME_RE = /^[\p{L}\p{N}_. -]{2,24}$/u;

// Коды ошибок Worker'а
const ERRORS = {
  bad_barcode: 'Баркод — это 5–10 цифр со студенческого.',
  bad_nickname: 'Ник: от 2 до 24 символов, буквы, цифры, пробел, точка, _ или -.',
  bad_password: 'Пароль должен быть не короче 8 символов.',
  barcode_taken: 'Аккаунт с этим баркодом уже есть. Попробуй войти.',
  nickname_taken: 'Такой ник уже занят, придумай другой.',
  bad_credentials: 'Неверный баркод или пароль.',
  too_many_attempts: 'Слишком много попыток. Подожди 15 минут.',
  rate_limited: 'Слишком много регистраций с этого адреса. Попробуй через час.',
};

let session = storage.get(SESSION_KEY, null); // { token, user: { nickname, barcode_hint } }
let mode = 'login';
let waiting = null; // resolve() для requireLogin, пока открыто окно входа
const listeners = new Set();
const el = {};

export const currentUser = () => session?.user ?? null;
export const onAuthChange = (fn) => listeners.add(fn);

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
  for (const id of ['dialog', 'form', 'title', 'reason', 'error', 'submit', 'tabs']) el[id] = document.getElementById(`auth-${id}`);
  el.boxes = document.querySelectorAll('[data-account]');

  document.addEventListener('click', (event) => {
    if (event.target.closest('[data-login]')) openDialog('');
    if (event.target.closest('[data-logout]')) logout();
  });
  el.tabs.addEventListener('click', (event) => {
    const tab = event.target.closest('[data-mode]');
    if (tab) setMode(tab.dataset.mode);
  });
  el.dialog.addEventListener('click', (event) => {
    if (event.target === el.dialog || event.target.closest('[data-close]')) el.dialog.close();
  });
  el.dialog.addEventListener('close', () => {
    waiting?.(Boolean(currentUser()));
    waiting = null;
  });
  el.form.addEventListener('submit', onSubmit);

  renderAccount();
  refreshSession();
}

// Ник могли поменять, а сессию — завершить на другом устройстве
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
  el.reason.textContent = reason || 'Войди по баркоду, чтобы добавлять работы и скачивать файлы.';
  setMode(mode);
  el.dialog.showModal();
  el.form.elements.barcode.focus();
}

function setMode(next) {
  mode = next;
  const register = mode === 'register';
  el.title.textContent = register ? 'Регистрация' : 'Вход';
  el.submit.textContent = register ? 'Создать аккаунт' : 'Войти';
  el.form.querySelectorAll('[data-register]').forEach((node) => node.classList.toggle('hidden', !register));
  el.form.elements.password.autocomplete = register ? 'new-password' : 'current-password';
  el.tabs.querySelectorAll('[data-mode]').forEach((tab) => {
    const active = tab.dataset.mode === mode;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-pressed', active);
  });
  el.error.textContent = '';
}

function validate(f) {
  if (!BARCODE_RE.test(f.barcode.value.trim())) return ERRORS.bad_barcode;
  if (mode === 'register') {
    if (!NICKNAME_RE.test(f.nickname.value.trim()) || f.nickname.value.trim().toLowerCase() === 'аноним') return ERRORS.bad_nickname;
    if (f.password.value.length < 8) return ERRORS.bad_password;
    if (f.password.value !== f.password2.value) return 'Пароли не совпадают.';
  } else if (!f.password.value) {
    return 'Введи пароль.';
  }
  return '';
}

async function onSubmit(event) {
  event.preventDefault();
  const f = el.form.elements;
  const problem = validate(f);
  el.error.textContent = problem;
  if (problem) return;

  const label = el.submit.textContent;
  el.submit.disabled = true;
  el.submit.textContent = mode === 'register' ? 'Создаю…' : 'Вхожу…';
  try {
    const res = await api(`/auth/${mode}`, {
      method: 'POST',
      json: {
        barcode: f.barcode.value.trim(),
        password: f.password.value,
        ...(mode === 'register' ? { nickname: f.nickname.value.trim() } : {}),
      },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      el.error.textContent = ERRORS[data.error] ?? 'Что-то пошло не так. Попробуй ещё раз.';
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
  try { await api('/auth/logout', { method: 'POST' }); } catch { /* выйдем и без сервера */ }
  setSession(null);
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
    const initial = escapeHtml([...user.nickname][0].toUpperCase());
    const avatar = `<span class="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-gradient-to-br from-brand-500 to-fuchsia-500 text-sm font-bold text-white">${initial}</span>`;
    box.innerHTML = compact
      // В мобильной шапке только показываем, кто вошёл; «Выйти» — в меню, чтобы не выйти случайно
      ? `<span class="flex items-center gap-2 text-sm font-semibold text-slate-700">${avatar}<span class="max-w-[7rem] truncate">${escapeHtml(user.nickname)}</span></span>`
      : `<div class="flex items-center gap-3 rounded-2xl bg-slate-50 p-2.5 ring-1 ring-slate-100">
          ${avatar}
          <div class="min-w-0 flex-1">
            <div class="truncate text-sm font-bold text-slate-800">${escapeHtml(user.nickname)}</div>
            <div class="text-xs text-slate-400">баркод ${escapeHtml(user.barcode_hint)}</div>
          </div>
          <button type="button" data-logout class="btn-ghost px-2 py-1 text-xs">Выйти</button>
        </div>`;
  });
}
