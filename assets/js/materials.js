import { api, requireLogin } from './auth.js';
import { CONFIG } from './config.js';
import { emoji, subjectEmoji } from './emoji.js';
import { escapeHtml, fetchJson, formatRelative, safeUrl } from './utils.js';

const state = {
  items: [],
  directions: [],
  programs: new Map(), // code → программа из programs.json
  query: '',
  direction: '',
  program: '',
  year: '',
  subject: '',
  teacher: '',
  sort: 'new',
  tools: new Set(),
};

const el = {};

let resolveReady;
// Форма добавления работы ждёт справочники ОП и список предметов
export const materialsReady = new Promise((resolve) => { resolveReady = resolve; });

export function getCatalog() {
  return {
    directions: state.directions,
    programs: [...state.programs.values()],
    subjects: uniqueSorted(state.items.map((m) => m.subject)),
    teachers: uniqueSorted(state.items.map((m) => m.teacher)),
  };
}

export async function initMaterials() {
  for (const id of ['search', 'stats', 'directions', 'programs', 'years', 'subject', 'teacher', 'sort', 'reset', 'tools', 'count', 'grid']) {
    el[id] = document.getElementById(`kb-${id}`);
  }
  el.navCount = document.getElementById('nav-count-knowledge');

  try {
    const [materials, programs] = await Promise.all([
      fetchJson(`${CONFIG.DATA_PATH}materials.json`),
      fetchJson(`${CONFIG.DATA_PATH}programs.json`),
    ]);
    state.items = materials.materials ?? [];
    state.directions = programs.directions ?? [];
    state.programs = new Map((programs.programs ?? []).map((p) => [p.code, p]));
  } catch (err) {
    console.error(err);
    el.grid.innerHTML = '<p class="col-span-full text-sm font-semibold text-red-600">Не удалось загрузить базу знаний.</p>';
    resolveReady();
    return;
  }
  resolveReady();

  el.navCount.textContent = state.items.length;
  renderStats();
  renderDirections();
  renderPrograms();
  renderYears();
  fillSubjects();
  fillTeachers();
  renderTools();
  bindEvents();
  render();
}

async function downloadFile(button) {
  if (!(await requireLogin('Чтобы скачать файл, войди в аккаунт.'))) return;
  const label = button.querySelector('span');
  const text = label.textContent;
  button.disabled = true;
  label.textContent = 'Скачиваю…';
  try {
    const res = await api(`/files/${encodeURIComponent(button.dataset.download)}`);
    if (res.status === 401) {
      label.textContent = text;
      button.disabled = false;
      return downloadFile(button); // сессия истекла — войти и повторить
    }
    if (!res.ok) throw new Error(res.status === 404 ? 'Файл не найден' : `HTTP ${res.status}`);
    const url = URL.createObjectURL(await res.blob());
    const a = Object.assign(document.createElement('a'), { href: url, download: button.dataset.name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    label.textContent = text;
  } catch (err) {
    console.error(err);
    label.textContent = err.message === 'Файл не найден' ? err.message : 'Не получилось, ещё раз';
  } finally {
    button.disabled = false;
  }
}

function bindEvents() {
  el.grid.addEventListener('click', (event) => {
    const button = event.target.closest('[data-download]');
    if (button) downloadFile(button);
  });
  el.search.addEventListener('input', () => { state.query = el.search.value.trim().toLowerCase(); render(); });
  el.subject.addEventListener('change', () => { state.subject = el.subject.value; render(); });
  el.teacher.addEventListener('change', () => { state.teacher = el.teacher.value; render(); });
  el.sort.addEventListener('change', () => { state.sort = el.sort.value; render(); });

  el.directions.addEventListener('click', (event) => {
    const button = event.target.closest('[data-direction]');
    if (!button) return;
    state.direction = button.dataset.direction;
    state.program = '';
    renderDirections();
    renderPrograms();
    render();
  });
  el.programs.addEventListener('click', (event) => {
    const button = event.target.closest('[data-program]');
    if (!button) return;
    state.program = button.dataset.program === state.program ? '' : button.dataset.program;
    renderPrograms();
    render();
  });
  el.years.addEventListener('click', (event) => {
    const button = event.target.closest('[data-year]');
    if (!button) return;
    state.year = button.dataset.year;
    renderYears();
    render();
  });
  el.tools.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-tool]');
    if (!chip) return;
    const tool = chip.dataset.tool;
    if (state.tools.has(tool)) state.tools.delete(tool);
    else state.tools.add(tool);
    chip.classList.toggle('is-active', state.tools.has(tool));
    chip.setAttribute('aria-pressed', state.tools.has(tool));
    render();
  });
  el.reset.addEventListener('click', resetFilters);
}

function resetFilters() {
  Object.assign(state, { query: '', direction: '', program: '', year: '', subject: '', teacher: '', tools: new Set() });
  el.search.value = '';
  el.subject.value = '';
  el.teacher.value = '';
  renderDirections();
  renderPrograms();
  renderYears();
  renderTools();
  render();
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b), 'ru'));
}

function scorePercent(m) {
  return m.score?.max ? Math.round((m.score.got / m.score.max) * 100) : null;
}

function renderStats() {
  const percents = state.items.map(scorePercent).filter((p) => p !== null);
  const avg = percents.length ? Math.round(percents.reduce((a, b) => a + b, 0) / percents.length) : 0;
  const stats = [
    ['Работ', state.items.length],
    ['Предметов', uniqueSorted(state.items.map((m) => m.subject)).length],
    ['Средний балл', `${avg}%`],
    ['Программ', state.programs.size],
  ];
  el.stats.innerHTML = stats.map(([label, value]) => `
    <div class="rounded-2xl bg-white/15 px-4 py-3 backdrop-blur">
      <dd class="font-display text-xl font-semibold">${escapeHtml(value)}</dd>
      <dt class="text-xs font-medium text-white/75">${label}</dt>
    </div>`).join('');
}

function inDirection(m, direction) {
  return m.programs?.some((code) => state.programs.get(code)?.direction === direction);
}

function renderDirections() {
  const tile = (id, title, subtitle, icon) => {
    const active = state.direction === id;
    return `
      <button type="button" data-direction="${escapeHtml(id)}" aria-pressed="${active}"
        class="flex min-w-[200px] shrink-0 items-center gap-3 rounded-2xl p-3 pr-5 text-left transition ${active
          ? 'bg-slate-900 text-white shadow-lg shadow-slate-900/20'
          : 'bg-white text-slate-800 ring-1 ring-slate-200 hover:shadow-md hover:ring-brand-200'}">
        <span class="grid h-12 w-12 shrink-0 place-items-center rounded-xl ${active ? 'bg-white/10' : 'bg-slate-50'}">${emoji(icon, 32)}</span>
        <span class="min-w-0">
          <span class="block truncate text-sm font-bold">${escapeHtml(title)}</span>
          <span class="text-xs ${active ? 'text-white/60' : 'text-slate-400'}">${escapeHtml(subtitle)}</span>
        </span>
      </button>`;
  };

  el.directions.innerHTML = [
    tile('', 'Все кафедры', `${state.items.length} работ`, 'cap'),
    ...state.directions.map((d) => {
      const programs = [...state.programs.values()].filter((p) => p.direction === d.id).length;
      const works = state.items.filter((m) => inDirection(m, d.id)).length;
      return tile(d.id, d.name, `${d.short ? `${d.short} · ` : ''}${programs} ОП · ${works} работ`, d.emoji);
    }),
  ].join('');
}

// Программы показываем только внутри выбранного направления, иначе 18 чипов шумят
function renderPrograms() {
  if (!state.direction) { el.programs.innerHTML = ''; return; }
  el.programs.innerHTML = [...state.programs.values()]
    .filter((p) => p.direction === state.direction)
    .map((p) => {
      const active = state.program === p.code;
      const count = state.items.filter((m) => m.programs?.includes(p.code)).length;
      return `
        <button type="button" data-program="${escapeHtml(p.code)}" aria-pressed="${active}" title="${escapeHtml(p.name)}"
          class="inline-flex items-center gap-2 rounded-xl py-1.5 pl-1.5 pr-3 text-sm font-semibold transition ${active
            ? 'bg-brand-600 text-white shadow-md shadow-brand-600/25'
            : 'bg-white text-slate-700 ring-1 ring-slate-200 hover:ring-brand-200'}">
          <span class="grid h-7 w-7 place-items-center rounded-lg ${active ? 'bg-white/15' : 'bg-slate-50'}">${emoji(p.emoji, 20)}</span>
          ${escapeHtml(p.name)}
          <span class="text-xs ${active ? 'text-white/70' : 'text-slate-400'}">${count}</span>
        </button>`;
    }).join('');
}

function renderYears() {
  const years = uniqueSorted(state.items.map((m) => m.course_year)).sort((a, b) => a - b);
  el.years.innerHTML = [['', 'Все курсы'], ...years.map((y) => [String(y), `${y} курс`])]
    .map(([value, label]) => `<button type="button" data-year="${value}" class="seg ${state.year === value ? 'is-active' : ''}" aria-pressed="${state.year === value}">${label}</button>`)
    .join('');
}

function fillSubjects() {
  el.subject.insertAdjacentHTML('beforeend',
    uniqueSorted(state.items.map((m) => m.subject)).map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join(''));
}

// Список строится из самих работ; пока ни у одной нет преподавателя, фильтр не показываем
function fillTeachers() {
  const teachers = uniqueSorted(state.items.map((m) => m.teacher));
  el.teacher.classList.toggle('hidden', teachers.length === 0);
  el.teacher.insertAdjacentHTML('beforeend',
    teachers.map((t) => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join(''));
}

function renderTools() {
  el.tools.innerHTML = uniqueSorted(state.items.flatMap((m) => m.stack ?? []))
    .map((tool) => {
      const active = state.tools.has(tool);
      return `<button type="button" class="chip ${active ? 'is-active' : ''}" data-tool="${escapeHtml(tool)}" aria-pressed="${active}">${escapeHtml(tool)}</button>`;
    })
    .join('');
}

function matches(m) {
  if (state.direction && !inDirection(m, state.direction)) return false;
  if (state.program && !m.programs?.includes(state.program)) return false;
  if (state.year && String(m.course_year) !== state.year) return false;
  if (state.subject && m.subject !== state.subject) return false;
  if (state.teacher && m.teacher !== state.teacher) return false;
  // Выбранные инструменты должны быть в стеке работы все сразу (AND)
  for (const tool of state.tools) if (!m.stack?.includes(tool)) return false;
  if (state.query) {
    const haystack = [m.subject, m.work, m.teacher, m.tip, ...(m.stack ?? [])].join(' ').toLowerCase();
    if (!haystack.includes(state.query)) return false;
  }
  return true;
}

function render() {
  const items = state.items.filter(matches).sort(state.sort === 'score'
    ? (a, b) => (scorePercent(b) ?? -1) - (scorePercent(a) ?? -1)
    : (a, b) => new Date(b.created_at) - new Date(a.created_at));

  const filtered = state.query || state.direction || state.program || state.year || state.subject || state.teacher || state.tools.size;
  el.reset.classList.toggle('hidden', !filtered);
  el.count.textContent = `Найдено работ: ${items.length}`;
  el.grid.innerHTML = items.length ? items.map(materialCard).join('') : emptyState();
}

function emptyState() {
  return `
    <div class="card col-span-full flex flex-col items-center px-6 py-14 text-center">
      ${emoji('search', 72)}
      <p class="mt-4 font-semibold text-slate-800">Ничего не нашлось</p>
      <p class="mt-1 text-sm text-slate-500">Ослабь фильтры или стань первым, кто поделится такой работой.</p>
    </div>`;
}

const SCORE_COLORS = [[90, '#10b981'], [75, '#6d4aff'], [60, '#f59e0b'], [0, '#ef4444']];

function scoreRing(m) {
  const pct = scorePercent(m);
  if (pct === null) return '';
  const color = SCORE_COLORS.find(([min]) => pct >= min)[1];
  return `
    <div class="grid h-14 w-14 shrink-0 place-items-center rounded-full" style="background: conic-gradient(${color} ${pct}%, #eef0f4 0)" title="${pct}%">
      <div class="flex h-11 w-11 flex-col items-center justify-center rounded-full bg-white leading-none">
        <span class="text-sm font-extrabold text-slate-900">${escapeHtml(m.score.got)}</span>
        <span class="text-[10px] font-semibold text-slate-400">/${escapeHtml(m.score.max)}</span>
      </div>
    </div>`;
}

// Файл работы хранится закрыто в Worker'е и скачивается только после входа; обычные ссылки просто открываем
function linkButton(link, materialId) {
  const label = escapeHtml(link.label);
  if (link.file) {
    return `<button type="button" data-download="${escapeHtml(materialId)}" data-name="${label}" title="${label}" class="inline-flex max-w-[14rem] items-center gap-1 rounded-lg bg-emerald-50 px-2 py-1 text-emerald-700 transition hover:bg-emerald-100 disabled:opacity-60">
      <svg class="shrink-0" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v12m0 0-5-5m5 5 5-5M5 20h14"/></svg>
      <span class="truncate">${label}</span></button>`;
  }
  const href = escapeHtml(safeUrl(link.url));
  return `<a href="${href}" target="_blank" rel="noopener" title="${label}" class="inline-flex max-w-[14rem] items-center gap-1 rounded-lg bg-brand-50 px-2 py-1 text-brand-700 transition hover:bg-brand-100">${emoji('paperclip', 14)}<span class="truncate">${label}</span></a>`;
}

export function materialCard(m) {
  const programChips = (m.programs ?? []).map((code) =>
    `<span class="rounded-md bg-brand-50 px-1.5 py-0.5 text-[11px] font-bold text-brand-700">${escapeHtml(state.programs.get(code)?.short ?? code)}</span>`);
  if (m.course_year) programChips.push(`<span class="rounded-md bg-slate-100 px-1.5 py-0.5 text-[11px] font-bold text-slate-500">${escapeHtml(m.course_year)} курс</span>`);

  const author = m.author?.anonymous
    ? `${emoji('disguise', 18)}<span>Аноним</span>`
    : `${emoji('bust', 18)}<span>${escapeHtml(m.author?.display ?? 'Аноним')}</span>`;
  const created = new Date(m.created_at);

  return `
    <article class="card flex flex-col p-5 transition duration-200 hover:-translate-y-0.5 hover:shadow-xl hover:shadow-slate-200/80">
      <div class="flex items-start gap-3">
        <div class="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-slate-50 ring-1 ring-slate-100">${emoji(subjectEmoji(m.subject), 30)}</div>
        <div class="min-w-0 flex-1">
          <h3 class="font-bold leading-snug text-slate-900">${escapeHtml(m.subject)}</h3>
          <div class="mt-1.5 flex flex-wrap gap-1">${programChips.join('')}</div>
        </div>
        ${scoreRing(m)}
      </div>

      <p class="mt-4 text-[15px] font-semibold leading-snug text-slate-800">${escapeHtml(m.work)}</p>
      ${m.teacher ? `<p class="mt-1.5 flex items-center gap-1.5 text-sm text-slate-500">${emoji('cap', 16)}<span>${escapeHtml(m.teacher)}</span></p>` : ''}
      <div class="mt-3 flex flex-wrap gap-1.5">
        ${(m.stack ?? []).map((t) => `<span class="rounded-lg bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-600">${escapeHtml(t)}</span>`).join('')}
      </div>

      ${m.tip ? `
        <div class="mt-4 flex gap-2.5 rounded-xl bg-amber-50 p-3 text-sm leading-relaxed text-amber-950 ring-1 ring-amber-100">
          ${emoji('bulb', 20, 'mt-0.5 shrink-0')}<p>${escapeHtml(m.tip)}</p>
        </div>` : ''}

      <footer class="mt-auto pt-4">
        <div class="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-3 text-xs font-semibold text-slate-500">
          <span class="flex items-center gap-1.5">${author}${Number.isNaN(created.getTime()) ? '' : `<span class="text-slate-300">·</span><span class="font-medium">${formatRelative(created)}</span>`}</span>
          <span class="flex min-w-0 flex-wrap gap-1.5">
            ${(m.links ?? []).map((link) => linkButton(link, m.id)).join('')}
          </span>
        </div>
      </footer>
    </article>`;
}
