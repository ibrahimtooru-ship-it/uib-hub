// Форма «Добавить работу» прямо на сайте. Работа не публикуется сразу, а уходит на модерацию:
// • если задан CONFIG.SUBMIT_ENDPOINT — POST в бэкенд (очередь модерации);
// • иначе — готовое сообщение модератору в Telegram (одна кнопка «Отправить»).
import { CONFIG } from './config.js';
import { escapeHtml, safeUrl } from './utils.js';
import { getCatalog, materialCard, materialsReady } from './materials.js';

const el = {};

// Коды ошибок, которые возвращает worker/src/index.js
const SERVER_ERRORS = {
  rate_limited: 'Слишком много заявок подряд. Попробуй через час.',
  subject_and_work_required: 'Укажи предмет и название работы.',
  program_required: 'Выбери свою ОП.',
  forbidden: 'Отправка с этого адреса не разрешена.',
};

export function initSubmit() {
  el.dialog = document.getElementById('submit-dialog');
  el.form = document.getElementById('submit-form');
  el.preview = document.getElementById('submit-preview');
  el.error = document.getElementById('submit-error');
  el.done = document.getElementById('submit-done');
  el.doneText = document.getElementById('submit-done-text');
  el.tgLink = document.getElementById('submit-telegram');
  el.copy = document.getElementById('submit-copy');

  document.addEventListener('click', (event) => {
    if (event.target.closest('[data-open-submit]')) open();
  });
  el.dialog.addEventListener('click', (event) => {
    if (event.target === el.dialog || event.target.closest('[data-close]')) el.dialog.close();
  });
  el.form.addEventListener('input', renderPreview);
  el.form.addEventListener('submit', onSubmit);
  el.form.elements.anonymous.addEventListener('change', () => {
    el.form.elements.nick.disabled = el.form.elements.anonymous.checked;
  });
}

async function open() {
  await materialsReady;
  fillOptions();
  showForm(true);
  el.dialog.showModal();
  renderPreview();
}

let filled = false;
function fillOptions() {
  if (filled) return;
  filled = true;
  const { directions, programs, subjects, teachers } = getCatalog();
  document.getElementById('submit-teachers').innerHTML =
    teachers.map((t) => `<option value="${escapeHtml(t)}"></option>`).join('');
  el.form.elements.program.insertAdjacentHTML('beforeend', directions.map((d) => `
    <optgroup label="${escapeHtml(d.name)}">
      ${programs.filter((p) => p.direction === d.id).map((p) => `<option value="${escapeHtml(p.code)}">${escapeHtml(p.name)}</option>`).join('')}
    </optgroup>`).join(''));
  document.getElementById('submit-subjects').innerHTML =
    subjects.map((s) => `<option value="${escapeHtml(s)}"></option>`).join('');
}

function readMaterial() {
  const f = el.form.elements;
  const got = f.got.value === '' ? null : Number(f.got.value);
  const max = Number(f.max.value) || 100;
  const link = f.link.value.trim();
  const anonymous = f.anonymous.checked || !f.nick.value.trim();
  return {
    id: `pending-${Date.now().toString(36)}`,
    subject: f.subject.value.trim(),
    work: f.work.value.trim(),
    programs: f.program.value ? [f.program.value] : [],
    course_year: Number(f.year.value) || null,
    semester: null,
    teacher: f.teacher.value.trim() || null,
    score: got === null ? null : { got, max },
    stack: f.stack.value.split(',').map((s) => s.trim()).filter(Boolean),
    tip: f.tip.value.trim(),
    links: link ? [{ label: 'Материалы', url: link }] : [],
    author: anonymous ? { display: 'Аноним', anonymous: true } : { display: f.nick.value.trim(), anonymous: false },
    created_at: new Date().toISOString(),
  };
}

function validate(m) {
  if (!m.subject || !m.work) return 'Укажи предмет и название работы.';
  if (!m.programs.length) return 'Выбери свою ОП.';
  if (m.score && (m.score.got < 0 || m.score.got > m.score.max)) return 'Балл не может быть больше максимума.';
  if (m.links.length && safeUrl(m.links[0].url) === '#') return 'Ссылка должна начинаться с http:// или https://';
  return '';
}

function renderPreview() {
  const m = readMaterial();
  el.preview.innerHTML = materialCard({
    ...m,
    subject: m.subject || 'Предмет',
    work: m.work || 'Название работы',
  });
}

async function onSubmit(event) {
  event.preventDefault();
  const material = readMaterial();
  const problem = validate(material);
  el.error.textContent = problem;
  if (problem) return;

  if (CONFIG.SUBMIT_ENDPOINT) {
    const button = el.form.querySelector('[type="submit"]');
    button.disabled = true;
    try {
      const res = await fetch(CONFIG.SUBMIT_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'material', data: material, website: el.form.elements.website.value }),
      });
      if (res.ok) {
        showDone('Готово! Работа ушла на модерацию и появится в базе после проверки.', null);
      } else {
        const { error } = await res.json().catch(() => ({}));
        el.error.textContent = SERVER_ERRORS[error] ?? 'Не получилось отправить. Попробуй ещё раз чуть позже.';
      }
    } catch (err) {
      console.error(err);
      el.error.textContent = 'Нет связи с сервером. Проверь интернет и попробуй ещё раз.';
    } finally {
      button.disabled = false;
    }
    return;
  }

  showDone('Последний шаг: открой Telegram и нажми «Отправить». Модератор проверит работу и добавит её в базу.', moderatorMessage(material));
}

function moderatorMessage(m) {
  const program = getCatalog().programs.find((p) => p.code === m.programs[0]);
  return [
    '📚 Новая работа для UIB Hub',
    `Предмет: ${m.subject}`,
    `Работа: ${m.work}`,
    `ОП: ${program?.name ?? m.programs[0]}`,
    m.teacher && `Преподаватель: ${m.teacher}`,
    m.course_year && `Курс: ${m.course_year}`,
    m.score && `Балл: ${m.score.got}/${m.score.max}`,
    m.stack.length && `Стек: ${m.stack.join(', ')}`,
    m.tip && `Совет: ${m.tip}`,
    m.links[0] && `Ссылка: ${m.links[0].url}`,
    `Автор: ${m.author.display}`,
    '',
    'JSON для materials.json:',
    JSON.stringify(m),
  ].filter((line) => line !== false && line !== null && line !== undefined && line !== 0).join('\n');
}

function showForm(visible) {
  el.form.classList.toggle('hidden', !visible);
  el.done.classList.toggle('hidden', visible);
  el.error.textContent = '';
}

function showDone(text, message) {
  showForm(false);
  el.doneText.textContent = text;
  el.tgLink.classList.toggle('hidden', !message);
  el.copy.classList.toggle('hidden', !message);
  if (!message) return;
  el.tgLink.href = `https://t.me/${CONFIG.TELEGRAM.moderatorUsername}?text=${encodeURIComponent(message)}`;
  el.copy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(message);
      el.copy.textContent = 'Скопировано ✓';
    } catch {
      el.copy.textContent = 'Не удалось скопировать';
    }
  };
  el.copy.textContent = 'Скопировать текст';
}
