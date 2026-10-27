import { parseAcademoText } from './academo-parser.js';
import { CONFIG } from './config.js';
import { emoji } from './emoji.js';
import { parseICS } from './ics-parser.js';
import { escapeHtml, fetchJson, formatDate, formatTimeLeft, safeUrl, storage } from './utils.js';

const HOUR = 36e5;
const PERSONAL_KEY = 'uibhub.personalDeadlines';
const GROUP_KEY = 'uibhub.group';
const HIDDEN_KEY = 'uibhub.hiddenDeadlines';

export const PRIORITIES = {
  critical: {
    label: 'Critical', hint: 'меньше 24 ч', icon: 'police_light',
    ring: 'ring-red-200 pulse-critical', bar: 'bg-red-500', soft: 'bg-red-50', badge: 'bg-red-100 text-red-700', text: 'text-red-600',
  },
  high: {
    label: 'High', hint: '1–3 дня', icon: 'fire',
    ring: 'ring-orange-200', bar: 'bg-orange-500', soft: 'bg-orange-50', badge: 'bg-orange-100 text-orange-700', text: 'text-orange-600',
  },
  medium: {
    label: 'Medium', hint: '3–7 дней', icon: 'calendar',
    ring: 'ring-amber-200', bar: 'bg-amber-400', soft: 'bg-amber-50', badge: 'bg-amber-100 text-amber-800', text: 'text-amber-600',
  },
  low: {
    label: 'Low', hint: 'больше 7 дней', icon: 'seedling',
    ring: 'ring-emerald-200', bar: 'bg-emerald-500', soft: 'bg-emerald-50', badge: 'bg-emerald-100 text-emerald-700', text: 'text-emerald-600',
  },
};

export function getPriority(dueAt, now = Date.now()) {
  const hoursLeft = (dueAt - now) / HOUR;
  if (hoursLeft < 24) return 'critical';
  if (hoursLeft < 72) return 'high';
  if (hoursLeft < 168) return 'medium';
  return 'low';
}

const state = {
  shared: [],
  personal: storage.get(PERSONAL_KEY, []),
  group: storage.get(GROUP_KEY, ''),
  // Общие дедлайны удалить нельзя, только скрыть у себя
  hidden: new Set(storage.get(HIDDEN_KEY, [])),
  loadError: null,
};

const el = {};

export async function initDeadlines() {
  el.list = document.getElementById('deadline-list');
  el.stats = document.getElementById('deadline-stats');
  el.group = document.getElementById('group-select');
  el.icsInput = document.getElementById('ics-input');
  el.icsClear = document.getElementById('ics-clear');
  el.icsStatus = document.getElementById('ics-status');
  el.sidebar = document.getElementById('sidebar-deadline');
  el.navBadge = document.getElementById('nav-badge-deadlines');
  el.restore = document.getElementById('deadlines-restore');
  initAcademoPaste();

  el.list.addEventListener('click', (event) => {
    const button = event.target.closest('[data-remove]');
    if (button) removeDeadline(button.dataset.remove);
  });
  el.restore.addEventListener('click', () => {
    state.hidden.clear();
    storage.remove(HIDDEN_KEY);
    render();
  });

  el.group.addEventListener('change', () => {
    state.group = el.group.value;
    storage.set(GROUP_KEY, state.group);
    render();
  });
  el.icsInput.addEventListener('change', onIcsSelected);
  el.icsClear.addEventListener('click', () => {
    state.personal = [];
    storage.remove(PERSONAL_KEY);
    setIcsStatus('');
    render();
  });

  try {
    const data = await fetchJson(`${CONFIG.DATA_PATH}deadlines.json`);
    state.shared = data.deadlines ?? [];
  } catch (err) {
    console.error(err);
    state.loadError = 'Не удалось загрузить общие дедлайны.';
  }

  fillGroupOptions();
  if (state.personal.length) setIcsStatus(`Твой календарь: ${state.personal.length} событий`);
  render();
  setInterval(render, 60_000); // обновляем таймеры и приоритеты
}

function fillGroupOptions() {
  const groups = [...new Set(state.shared.flatMap((d) => d.groups ?? []))].sort((a, b) => a.localeCompare(b, 'ru'));
  el.group.insertAdjacentHTML('beforeend',
    groups.map((g) => `<option value="${escapeHtml(g)}">${escapeHtml(g)}</option>`).join(''));
  el.group.value = groups.includes(state.group) ? state.group : '';
}

// Личные дедлайны копятся из разных источников (.ics, вставка из Academo); повторы склеиваем по id
function addPersonal(events) {
  const upcoming = events.filter((e) => new Date(e.due_at) > Date.now());
  const byId = new Map([...state.personal, ...upcoming].map((e) => [e.id, e]));
  state.personal = [...byId.values()].filter((e) => new Date(e.due_at) > Date.now());
  storage.set(PERSONAL_KEY, state.personal);
  return upcoming.length;
}

async function onIcsSelected(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const events = parseICS(await file.text(), { defaultOffset: CONFIG.DEFAULT_UTC_OFFSET });
    const added = addPersonal(events);
    setIcsStatus(`Добавлено ${added} предстоящих событий (всего в файле: ${events.length})`);
  } catch (err) {
    console.error(err);
    setIcsStatus('Не удалось прочитать файл. Это точно .ics из Academo?');
  }
  event.target.value = '';
  render();
}

function initAcademoPaste() {
  const dialog = document.getElementById('academo-dialog');
  const textarea = document.getElementById('academo-text');
  const preview = document.getElementById('academo-preview');
  const save = document.getElementById('academo-save');
  let parsed = [];

  document.getElementById('academo-open').addEventListener('click', () => {
    textarea.value = '';
    textarea.dispatchEvent(new Event('input'));
    dialog.showModal();
    textarea.focus();
  });
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog || event.target.closest('[data-close]')) dialog.close();
  });

  textarea.addEventListener('input', () => {
    parsed = parseAcademoText(textarea.value, { offset: CONFIG.DEFAULT_UTC_OFFSET })
      .filter((e) => new Date(e.due_at) > Date.now());
    save.disabled = parsed.length === 0;
    if (!textarea.value.trim()) {
      preview.innerHTML = '';
    } else if (!parsed.length) {
      preview.innerHTML = '<p class="font-semibold text-amber-700">Не нашёл ни одного будущего дедлайна. Скопируй страницу «Шкала времени» целиком.</p>';
    } else {
      preview.innerHTML = `
        <p class="font-semibold text-emerald-700">Найдено: ${parsed.length}</p>
        <ul class="mt-2 max-h-48 space-y-1 overflow-y-auto">
          ${parsed.map((e) => `<li class="flex justify-between gap-3 rounded-lg bg-white px-2.5 py-1.5 ring-1 ring-slate-100">
            <span class="min-w-0 truncate"><b class="text-slate-800">${escapeHtml(e.title)}</b> <span class="text-slate-400">${escapeHtml(e.course)}</span></span>
            <span class="shrink-0 text-slate-500">${formatDate(new Date(e.due_at))}</span></li>`).join('')}
        </ul>`;
    }
  });

  save.addEventListener('click', () => {
    const added = addPersonal(parsed);
    setIcsStatus(`Добавлено из Academo: ${added}. Всего в твоём календаре: ${state.personal.length}`);
    dialog.close();
    render();
  });
}

function removeDeadline(id) {
  if (state.personal.some((d) => d.id === id)) {
    state.personal = state.personal.filter((d) => d.id !== id);
    storage.set(PERSONAL_KEY, state.personal);
    el.icsClear.classList.toggle('hidden', state.personal.length === 0);
  } else {
    state.hidden.add(id);
    storage.set(HIDDEN_KEY, [...state.hidden]);
  }
  render();
}

function setIcsStatus(text) {
  el.icsStatus.textContent = text;
  el.icsClear.classList.toggle('hidden', state.personal.length === 0);
}

function visibleDeadlines(now) {
  const shared = state.shared.filter((d) => !state.hidden.has(d.id)
    && (!state.group || !d.groups?.length || d.groups.includes(state.group)));

  // Дедлайн может быть и в общем файле, и в личном .ics: убираем дубли по названию и сроку
  const seen = new Set();
  return [...shared, ...state.personal]
    .map((d) => ({ ...d, due: new Date(d.due_at) }))
    .filter((d) => {
      const key = `${d.title.trim().toLowerCase()}|${Math.floor(d.due / 60000)}`;
      if (Number.isNaN(d.due.getTime()) || d.due <= now || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((d) => ({ ...d, priority: getPriority(d.due, now) }))
    .sort((a, b) => a.due - b.due);
}

function render() {
  const now = Date.now();
  const items = visibleDeadlines(now);
  renderSidebar(items, now);

  const hiddenCount = state.shared.filter((d) => state.hidden.has(d.id)).length;
  el.restore.textContent = `Вернуть скрытые (${hiddenCount})`;
  el.restore.classList.toggle('hidden', hiddenCount === 0);

  el.stats.innerHTML = Object.entries(PRIORITIES).map(([key, p]) => {
    const count = items.filter((d) => d.priority === key).length;
    return `
      <div class="card flex items-center gap-3 p-4">
        <span class="grid h-12 w-12 shrink-0 place-items-center rounded-xl ${p.soft}">${emoji(p.icon, 30)}</span>
        <div>
          <div class="font-display text-2xl font-semibold leading-none ${p.text}">${count}</div>
          <div class="mt-1 text-xs font-semibold text-slate-500">${p.label} · ${p.hint}</div>
        </div>
      </div>`;
  }).join('');

  if (state.loadError && items.length === 0) {
    el.list.innerHTML = `<li class="card p-5 text-sm font-semibold text-red-600">${escapeHtml(state.loadError)}</li>`;
    return;
  }
  el.list.innerHTML = items.length
    ? items.map((d) => deadlineCard(d, now)).join('')
    : `<li class="card flex flex-col items-center px-6 py-12 text-center">${emoji('party', 72)}<p class="mt-3 font-semibold text-slate-700">Дедлайнов нет. Можно выдохнуть.</p></li>`;
}

// Ближайший дедлайн и счётчик срочных в сайдбаре видны с любой страницы
function renderSidebar(items, now) {
  const urgent = items.filter((d) => d.priority === 'critical' || d.priority === 'high').length;
  el.navBadge.textContent = urgent;
  el.navBadge.classList.toggle('hidden', urgent === 0);

  const next = items[0];
  if (!next) { el.sidebar.innerHTML = ''; return; }
  const p = PRIORITIES[next.priority];
  el.sidebar.innerHTML = `
    <a href="#/deadlines" class="block rounded-2xl p-3 ring-1 transition hover:brightness-[0.98] ${p.soft} ${p.ring.replace(' pulse-critical', '')}">
      <div class="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-500">${emoji(p.icon, 16)}Ближайший дедлайн</div>
      <div class="mt-1.5 line-clamp-2 text-sm font-bold leading-snug text-slate-800">${escapeHtml(next.title)}</div>
      <div class="mt-1 text-xs font-bold ${p.text}">через ${formatTimeLeft(next.due - now)}</div>
    </a>`;
}

function deadlineCard(d, now) {
  const p = PRIORITIES[d.priority];
  const needsHelp = d.priority === 'critical' || d.priority === 'high';
  const helpHref = `#/marketplace?${new URLSearchParams({ subject: d.course ?? '', task: d.title, deadline: d.due_at })}`;
  const isPersonal = d.source?.startsWith('academo');

  return `
    <li class="group relative overflow-hidden rounded-2xl bg-white p-5 pl-6 pr-12 ring-1 ${p.ring}">
      <span class="absolute inset-y-0 left-0 w-1.5 ${p.bar}"></span>
      <button type="button" data-remove="${escapeHtml(d.id)}" title="${isPersonal ? 'Удалить' : 'Скрыть у меня'}" aria-label="${isPersonal ? 'Удалить дедлайн' : 'Скрыть дедлайн'}"
        class="absolute right-3 top-3 grid h-8 w-8 place-items-center rounded-lg text-slate-300 transition hover:bg-red-50 hover:text-red-600 focus-visible:text-red-600">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"/></svg>
      </button>
      <div class="flex flex-wrap items-start gap-4">
        <span class="grid h-12 w-12 shrink-0 place-items-center rounded-xl ${p.soft}">${emoji(p.icon, 30)}</span>
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-2 text-xs font-bold">
            <span class="rounded-md px-2 py-0.5 ${p.badge}">${p.label}</span>
            ${d.source?.startsWith('academo') ? '<span class="rounded-md bg-slate-100 px-2 py-0.5 text-slate-500">мой Academo</span>' : ''}
          </div>
          <h3 class="mt-2 font-bold leading-snug text-slate-900">${escapeHtml(d.title)}</h3>
          ${d.course ? `<p class="text-sm text-slate-500">${escapeHtml(d.course)}</p>` : ''}
        </div>
        <div class="text-right">
          <div class="font-display text-lg font-semibold ${p.text}">${formatTimeLeft(d.due - now)}</div>
          <div class="text-xs font-medium text-slate-400">${formatDate(d.due)}</div>
        </div>
      </div>
      ${needsHelp || d.url ? `
        <div class="mt-4 flex flex-wrap gap-2 sm:pl-16">
          ${needsHelp ? `<a href="${escapeHtml(helpHref)}" class="btn-primary">${emoji('rocket', 18)}Не успеваешь? Заказать помощь</a>` : ''}
          ${d.url ? `<a href="${escapeHtml(safeUrl(d.url))}" target="_blank" rel="noopener" class="btn-secondary">Открыть в Academo ↗</a>` : ''}
        </div>` : ''}
    </li>`;
}
