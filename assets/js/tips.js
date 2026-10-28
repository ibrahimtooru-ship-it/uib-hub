// «Препод-конфиденциально»: лента анонимных советов — как сдавать, на что обращает внимание преподаватель.
// Пишут студенты после входа, публикуют модераторы. На сайте автор всегда «Аноним».
// Курсы из data/courses.json — только подсказки в форме (кто ведёт), а не справочник.
import { api, onAuthChange, requireLogin } from './auth.js';
import { CONFIG } from './config.js';
import { emoji } from './emoji.js';
import { escapeHtml, fetchJson, formatRelative } from './utils.js';

// Те же ключи проверяет Worker
const TOPICS = {
  how: { label: 'Как сдавать', style: 'bg-brand-50 text-brand-700' },
  focus: { label: 'На что обращает внимание', style: 'bg-amber-50 text-amber-800' },
  format: { label: 'Формат и оформление', style: 'bg-sky-50 text-sky-700' },
  deadlines: { label: 'Дедлайны и пересдачи', style: 'bg-red-50 text-red-700' },
  attendance: { label: 'Посещаемость', style: 'bg-emerald-50 text-emerald-700' },
  other: { label: 'Другое', style: 'bg-slate-100 text-slate-600' },
};
const TEXT_LIMITS = { min: 20, max: 800 };
const OTHER = '__other';

// Коды ошибок Worker'а
const ERRORS = {
  tip_too_short: `Совет слишком короткий — хотя бы ${TEXT_LIMITS.min} символов.`,
  tip_too_long: `Совет длиннее ${TEXT_LIMITS.max} символов. Сократи.`,
  tip_course_required: 'Укажи курс или преподавателя.',
  teacher_surname: 'Преподаватель — только имя и отчество, без фамилии.',
  rate_limited: 'Слишком много советов подряд. Попробуй через час.',
  auth_required: 'Сессия закончилась. Войди заново и отправь ещё раз.',
};

const state = { tips: [], courses: [], counts: {}, mine: new Set(), course: '', topic: '', sort: 'useful' };
const el = {};

let resolveReady;
export const coursesReady = new Promise((resolve) => { resolveReady = resolve; });

// Имена преподавателей из расписания — подсказки и в форме «Добавить работу», чтобы писали одинаково
export function courseTeachers() {
  return [...new Set(state.courses.flatMap((c) => [c.lecturer, c.seminar]).filter(Boolean))];
}

export async function initTips() {
  for (const id of ['feed', 'count', 'course', 'topics', 'sort', 'compose', 'form', 'status', 'counter']) el[id] = document.getElementById(`tips-${id}`);
  el.contact = document.getElementById('tips-contact');
  el.contact.href = `https://t.me/${CONFIG.TELEGRAM.moderatorUsername}`;

  try {
    const [tips, courses] = await Promise.all([
      fetchJson(`${CONFIG.DATA_PATH}tips.json`),
      fetchJson(`${CONFIG.DATA_PATH}courses.json`),
    ]);
    state.tips = tips.tips ?? [];
    state.courses = courses.courses ?? [];
  } catch (err) {
    console.error(err);
    el.feed.innerHTML = '<p class="text-sm font-semibold text-red-600">Не удалось загрузить советы.</p>';
  }
  resolveReady();

  fillFilters();
  fillComposer();
  bindEvents();
  render();
  loadVotes();
  onAuthChange(loadVotes);
}

function bindEvents() {
  el.course.addEventListener('change', () => { state.course = el.course.value; render(); });
  el.sort.addEventListener('change', () => { state.sort = el.sort.value; render(); });
  el.topics.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-topic]');
    if (!chip) return;
    state.topic = chip.dataset.topic === state.topic ? '' : chip.dataset.topic;
    renderTopicChips();
    render();
  });
  el.feed.addEventListener('click', (event) => {
    const vote = event.target.closest('[data-vote]');
    if (vote) toggleVote(vote.dataset.vote);
    const report = event.target.closest('[data-report]');
    if (report) reportTip(report);
  });
  document.addEventListener('click', (event) => {
    if (event.target.closest('[data-write-tip]')) openComposer();
  });
  el.compose.addEventListener('click', (event) => {
    if (event.target === el.compose || event.target.closest('[data-close]')) el.compose.close();
  });
  el.form.elements.course.addEventListener('change', updateTeacherOptions);
  el.form.elements.teacher.addEventListener('change', updateOtherInputs);
  el.form.elements.text.addEventListener('input', updateCounter);
  el.form.addEventListener('submit', onSubmit);
}

// --- Лента ---

function courseNames() {
  return [...new Set([...state.courses.map((c) => c.name), ...state.tips.map((t) => t.course)].filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'ru'));
}

function fillFilters() {
  el.course.insertAdjacentHTML('beforeend', courseNames().map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join(''));
  renderTopicChips();
}

function renderTopicChips() {
  el.topics.innerHTML = Object.entries(TOPICS).map(([key, t]) => {
    const active = state.topic === key;
    return `<button type="button" data-topic="${key}" aria-pressed="${active}" class="chip shrink-0 ${active ? 'is-active' : ''}">${t.label}</button>`;
  }).join('');
}

function render() {
  const items = state.tips
    .filter((t) => (!state.course || t.course === state.course) && (!state.topic || t.topic === state.topic))
    .sort((a, b) => (state.sort === 'useful' ? (state.counts[b.id] ?? 0) - (state.counts[a.id] ?? 0) : 0)
      || new Date(b.created_at) - new Date(a.created_at));

  el.count.textContent = state.tips.length ? `Советов: ${items.length}` : '';
  if (!items.length) {
    el.feed.innerHTML = state.tips.length ? emptyFiltered() : emptyFeed();
    return;
  }
  el.feed.innerHTML = items.map(tipPost).join('');
}

function emptyFeed() {
  return `
    <div class="card flex flex-col items-center px-6 py-14 text-center">
      ${emoji('shush', 80)}
      <p class="mt-4 font-display text-lg font-semibold text-slate-900">Пока тут тихо</p>
      <p class="mt-1 max-w-sm text-sm text-slate-500">Поделись первым: как сдать предмет, на что преподаватель обращает внимание, что лучше сделать заранее.</p>
      <button type="button" data-write-tip class="btn-primary mt-5">${emoji('memo', 18)}Написать первый совет</button>
    </div>`;
}

function emptyFiltered() {
  return `<div class="card px-6 py-10 text-center text-sm text-slate-500">По этому фильтру советов пока нет. <button type="button" data-write-tip class="font-semibold text-brand-700 hover:underline">Напиши свой</button>.</div>`;
}

function tipPost(t) {
  const topic = TOPICS[t.topic] ?? TOPICS.other;
  const count = state.counts[t.id] ?? 0;
  const voted = state.mine.has(t.id);
  const created = new Date(t.created_at);
  const about = [
    t.course && `<span class="inline-flex min-w-0 items-center gap-1">${emoji('books', 14)}<span class="truncate">${escapeHtml(t.course)}</span></span>`,
    t.teacher && `<span class="inline-flex items-center gap-1">${emoji('bust', 14)}${escapeHtml(t.teacher)}</span>`,
  ].filter(Boolean).join('');
  return `
    <article class="card p-4 sm:p-5">
      <header class="flex items-center gap-3">
        <span class="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-slate-100">${emoji('disguise', 26)}</span>
        <div class="min-w-0 flex-1">
          <div class="text-sm font-bold text-slate-800">Аноним</div>
          <div class="text-xs text-slate-400">${Number.isNaN(created.getTime()) ? '' : formatRelative(created)}</div>
        </div>
        <span class="shrink-0 rounded-full px-2.5 py-1 text-[11px] font-bold ${topic.style}">${topic.label}</span>
      </header>
      ${about ? `<div class="mt-3 flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-xs font-semibold text-slate-500">${about}</div>` : ''}
      <p class="mt-3 whitespace-pre-line break-words text-[15px] leading-relaxed text-slate-800">${escapeHtml(t.text)}</p>
      <footer class="mt-4 flex items-center justify-between gap-3 border-t border-slate-100 pt-3">
        <button type="button" data-vote="${escapeHtml(t.id)}" aria-pressed="${voted}"
          class="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-semibold ring-1 transition ${voted ? 'bg-brand-600 text-white ring-brand-600' : 'text-slate-600 ring-slate-200 hover:bg-slate-50'}">
          👍 Полезно${count ? ` · ${count}` : ''}
        </button>
        <button type="button" data-report="${escapeHtml(t.id)}" class="text-xs font-semibold text-slate-400 transition hover:text-red-600">Пожаловаться</button>
      </footer>
    </article>`;
}

// --- «Полезно» и жалобы ---

async function loadVotes() {
  if (!CONFIG.API_BASE || !state.tips.length) return;
  try {
    const res = await api('/tips/votes');
    if (!res.ok) return;
    const data = await res.json();
    state.counts = data.counts ?? {};
    state.mine = new Set(data.mine ?? []);
    render();
  } catch {
    // Счётчики не загрузились — лента всё равно читается
  }
}

async function toggleVote(id) {
  if (!(await requireLogin('Чтобы отметить совет полезным, войди в аккаунт.'))) return;
  try {
    const res = await api('/tips/vote', { method: 'POST', json: { id } });
    if (!res.ok) return;
    const data = await res.json();
    state.counts[id] = data.count;
    if (data.voted) state.mine.add(id); else state.mine.delete(id);
    render();
  } catch (err) {
    console.error(err);
  }
}

async function reportTip(button) {
  if (!(await requireLogin('Чтобы пожаловаться, войди в аккаунт.'))) return;
  const reason = prompt('Что не так с этим советом? Модераторы проверят и удалят, если он нарушает правила.\n\nНапример: оскорбление, неправда, личная информация.');
  if (reason === null) return;
  button.disabled = true;
  try {
    const res = await api('/tips/report', { method: 'POST', json: { id: button.dataset.report, reason } });
    button.textContent = res.ok ? 'Отправлено модераторам' : 'Не получилось';
  } catch {
    button.textContent = 'Нет связи';
    button.disabled = false;
  }
}

// --- Написать совет ---

function fillComposer() {
  const f = el.form.elements;
  f.course.innerHTML = [
    '<option value="">Выбери курс</option>',
    ...state.courses.map((c) => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}</option>`),
    `<option value="${OTHER}">Другой курс…</option>`,
  ].join('');
  f.topic.innerHTML = Object.entries(TOPICS).map(([key, t]) => `<option value="${key}">${t.label}</option>`).join('');
  updateTeacherOptions();
  updateCounter();
}

function updateTeacherOptions() {
  const f = el.form.elements;
  const course = state.courses.find((c) => c.name === f.course.value);
  // Сначала те, кто ведёт выбранный курс, потом остальные из расписания
  const own = course ? [...new Set([course.lecturer, course.seminar].filter(Boolean))] : [];
  const rest = courseTeachers().filter((t) => !own.includes(t));
  f.teacher.innerHTML = [
    '<option value="">Не указывать</option>',
    ...own.map((t) => `<option value="${escapeHtml(t)}">${escapeHtml(t)}${course?.lecturer === t && course?.seminar === t ? ' — ведёт курс' : course?.lecturer === t ? ' — лекции' : ' — семинары'}</option>`),
    rest.length ? `<optgroup label="Другие">${rest.map((t) => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('')}</optgroup>` : '',
    `<option value="${OTHER}">Другой преподаватель…</option>`,
  ].join('');
  if (own.length) f.teacher.value = own[0];
  updateOtherInputs();
}

function updateOtherInputs() {
  const f = el.form.elements;
  f.course_other.closest('label').classList.toggle('hidden', f.course.value !== OTHER);
  f.teacher_other.closest('label').classList.toggle('hidden', f.teacher.value !== OTHER);
}

function updateCounter() {
  const length = el.form.elements.text.value.trim().length;
  el.counter.textContent = `${length} / ${TEXT_LIMITS.max}`;
  el.counter.classList.toggle('text-red-600', length > TEXT_LIMITS.max);
}

async function openComposer() {
  if (!(await requireLogin('Чтобы написать совет, войди в аккаунт. На сайте ты будешь «Анонимом».'))) return;
  el.status.textContent = '';
  if (state.course) {
    el.form.elements.course.value = state.courses.some((c) => c.name === state.course) ? state.course : OTHER;
    updateTeacherOptions();
  }
  el.compose.showModal();
}

function setStatus(text, ok = false) {
  el.status.textContent = text;
  el.status.classList.toggle('text-emerald-700', ok);
  el.status.classList.toggle('text-red-600', !ok);
}

async function onSubmit(event) {
  event.preventDefault();
  const f = el.form.elements;
  const course = f.course.value === OTHER ? f.course_other.value.trim() : f.course.value;
  const teacher = f.teacher.value === OTHER ? f.teacher_other.value.trim() : f.teacher.value;
  const text = f.text.value.trim();

  if (!course && !teacher) return setStatus(ERRORS.tip_course_required);
  if (teacher.split(/\s+/).length > 2) return setStatus(ERRORS.teacher_surname);
  if (text.length < TEXT_LIMITS.min) return setStatus(ERRORS.tip_too_short);
  if (text.length > TEXT_LIMITS.max) return setStatus(ERRORS.tip_too_long);

  const button = el.form.querySelector('[type="submit"]');
  button.disabled = true;
  try {
    const res = await api('/tips', { method: 'POST', json: { course, teacher, topic: f.topic.value, text } });
    if (res.ok) {
      f.text.value = '';
      updateCounter();
      setStatus('Спасибо! Совет у модераторов — появится в ленте после проверки.', true);
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
