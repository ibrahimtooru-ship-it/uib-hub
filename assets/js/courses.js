// Курсы и преподаватели: только факты из расписания (кто ведёт лекции и семинары, курс, кредиты).
// Оценок и рейтингов преподавателей нет; новые курсы и исправления студенты присылают модераторам.
import { api, requireLogin } from './auth.js';
import { CONFIG } from './config.js';
import { emoji } from './emoji.js';
import { showWorks } from './materials.js';
import { escapeHtml, fetchJson } from './utils.js';

// Коды ошибок Worker'а
const ERRORS = {
  course_name_required: 'Укажи название курса.',
  rate_limited: 'Слишком много предложений подряд. Попробуй через час.',
  auth_required: 'Сессия закончилась. Войди заново и отправь ещё раз.',
};

const state = { courses: [], works: [], year: '', query: '' };
const el = {};

let resolveReady;
export const coursesReady = new Promise((resolve) => { resolveReady = resolve; });

// Имена преподавателей из расписания — подсказки в форме «Добавить работу», чтобы писали одинаково
export function courseTeachers() {
  return [...new Set(state.courses.flatMap((c) => [c.lecturer, c.seminar]).filter(Boolean))];
}

export async function initCourses() {
  for (const id of ['grid', 'years', 'search', 'count', 'suggest-dialog', 'suggest-form', 'suggest-status']) el[id] = document.getElementById(`courses-${id}`);
  el.contact = document.getElementById('courses-contact');
  el.contact.href = `https://t.me/${CONFIG.TELEGRAM.moderatorUsername}`;

  try {
    const [courses, materials] = await Promise.all([
      fetchJson(`${CONFIG.DATA_PATH}courses.json`),
      fetchJson(`${CONFIG.DATA_PATH}materials.json`),
    ]);
    state.courses = courses.courses ?? [];
    state.works = materials.materials ?? [];
  } catch (err) {
    console.error(err);
    el.grid.innerHTML = '<p class="text-sm font-semibold text-red-600">Не удалось загрузить курсы.</p>';
  }
  resolveReady();

  el.search.addEventListener('input', () => { state.query = el.search.value.trim().toLowerCase(); render(); });
  el.years.addEventListener('click', (event) => {
    const button = event.target.closest('[data-year]');
    if (!button) return;
    state.year = button.dataset.year;
    renderYears();
    render();
  });
  el.grid.addEventListener('click', (event) => {
    const button = event.target.closest('[data-works]');
    if (button) showWorks(button.dataset.works);
  });
  document.addEventListener('click', (event) => {
    if (event.target.closest('[data-suggest-course]')) openSuggest();
  });
  el['suggest-dialog'].addEventListener('click', (event) => {
    if (event.target === el['suggest-dialog'] || event.target.closest('[data-close]')) el['suggest-dialog'].close();
  });
  el['suggest-form'].addEventListener('submit', onSuggest);

  renderYears();
  render();
}

function worksFor(course) {
  const needle = (course.search ?? course.name).toLowerCase();
  return state.works.filter((m) => `${m.subject} ${m.work}`.toLowerCase().includes(needle)).length;
}

function renderYears() {
  const years = [...new Set(state.courses.map((c) => c.course_year).filter(Boolean))].sort();
  el.years.innerHTML = [['', 'Все курсы'], ...years.map((y) => [String(y), `${y} курс`])]
    .map(([value, label]) => `<button type="button" data-year="${value}" class="seg ${state.year === value ? 'is-active' : ''}" aria-pressed="${state.year === value}">${label}</button>`)
    .join('');
}

function render() {
  const items = state.courses.filter((c) => {
    if (state.year && String(c.course_year) !== state.year) return false;
    if (!state.query) return true;
    return [c.name, c.lecturer, c.seminar].join(' ').toLowerCase().includes(state.query);
  });
  el.count.textContent = `Курсов: ${items.length}`;
  el.grid.innerHTML = items.length
    ? items.map(courseCard).join('')
    : `<div class="card col-span-full px-6 py-12 text-center text-sm text-slate-500">Такого курса пока нет. <button type="button" data-suggest-course class="font-semibold text-brand-700 hover:underline">Предложи его</button>.</div>`;
}

function person(role, name) {
  return `
    <div class="flex items-center gap-2">
      <span class="w-20 shrink-0 text-xs font-semibold uppercase tracking-wider text-slate-400">${role}</span>
      <span class="min-w-0 truncate font-semibold text-slate-800">${escapeHtml(name || 'не указан')}</span>
    </div>`;
}

function courseCard(c) {
  const chips = [
    c.course_year && `${c.course_year} курс`,
    c.credits && `${c.credits} кредитов`,
    c.year,
  ].filter(Boolean).map((t) => `<span class="rounded-md bg-slate-100 px-1.5 py-0.5 text-[11px] font-bold text-slate-500">${escapeHtml(t)}</span>`).join('');
  // Один человек ведёт и лекции, и семинары — показываем одной строкой
  const people = c.lecturer && c.lecturer === c.seminar
    ? person('Ведёт', c.lecturer)
    : `${person('Лекции', c.lecturer)}${person('Семинары', c.seminar)}`;
  const works = worksFor(c);
  return `
    <article class="card flex flex-col p-5">
      <h3 class="font-bold leading-snug text-slate-900">${escapeHtml(c.name)}</h3>
      <div class="mt-2 flex flex-wrap gap-1">${chips}</div>
      <div class="mt-4 space-y-1.5 text-sm">${people}</div>
      <div class="mt-auto pt-4">
        <button type="button" data-works="${escapeHtml(c.search ?? c.name)}" class="btn-secondary w-full" ${works ? '' : 'disabled'}>
          ${emoji('books', 18)}${works ? `Работы по курсу · ${works}` : 'Работ пока нет'}
        </button>
      </div>
    </article>`;
}

async function openSuggest() {
  if (!(await requireLogin('Чтобы предложить курс, войди в аккаунт.'))) return;
  el['suggest-status'].textContent = '';
  el['suggest-dialog'].showModal();
}

async function onSuggest(event) {
  event.preventDefault();
  const f = el['suggest-form'].elements;
  const status = el['suggest-status'];
  const setStatus = (text, ok = false) => {
    status.textContent = text;
    status.classList.toggle('text-emerald-700', ok);
    status.classList.toggle('text-red-600', !ok);
  };
  if (!f.name.value.trim()) return setStatus(ERRORS.course_name_required);

  const button = el['suggest-form'].querySelector('[type="submit"]');
  button.disabled = true;
  try {
    const res = await api('/courses/suggest', {
      method: 'POST',
      json: {
        name: f.name.value, course_year: f.course_year.value, credits: f.credits.value,
        lecturer: f.lecturer.value, seminar: f.seminar.value, comment: f.comment.value,
      },
    });
    if (res.ok) {
      el['suggest-form'].reset();
      setStatus('Спасибо! Модераторы проверят и добавят курс.', true);
    } else {
      const { error } = await res.json().catch(() => ({}));
      setStatus(ERRORS[error] ?? 'Не получилось отправить. Попробуй ещё раз чуть позже.');
    }
  } catch (err) {
    console.error(err);
    setStatus('Нет связи с сервером. Проверь интернет и попробуй ещё раз.');
  } finally {
    button.disabled = false;
  }
}
