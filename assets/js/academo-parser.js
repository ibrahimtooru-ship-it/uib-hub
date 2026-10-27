// Разбор текста, скопированного со страниц Academo (Ctrl+A, Ctrl+C):
// • «Шкала времени» (/student/deadline-calendar): «Четверг, 29 октября 2026 г.» → название → «09:50» → курс
// • виджет «Дедлайны» на главной: название → курс → «29 октября» (без года и времени)
// Строку курса узнаём по хвосту «26/27 5 semester», а не по позиции: порядок строк при копировании
// зависит от вёрстки, и курс может оказаться и до, и после времени.

const MONTHS = {
  января: 0, февраля: 1, марта: 2, апреля: 3, мая: 4, июня: 5,
  июля: 6, августа: 7, сентября: 8, октября: 9, ноября: 10, декабря: 11,
};

const DATE_RE = new RegExp(
  `^(?:([а-яё]+),\\s*)?(\\d{1,2})\\s+(${Object.keys(MONTHS).join('|')})(?:\\s+(\\d{4}))?(?:\\s*г\\.?)?$`, 'i');
const TIME_RE = /^(\d{1,2}):(\d{2})$/;
// «Философия 26/27 5 semester» или обрезанное в виджете «…на языке JAVA 26/...»
const COURSE_RE = /\s+\d{2}\/(?:\d{2}\s+\d+\s*semester|\S*(?:\.\.\.|…))\s*$/i;

export function parseAcademoText(text, { offset = '+05:00', now = new Date() } = {}) {
  const lines = text.split(/\r?\n|\t/).map((l) => l.trim()).filter(Boolean);
  const events = [];
  let buffer = [];       // строки-кандидаты в название (сюда же попадает мусор страницы)
  let course = null;     // курс, встреченный до времени
  let currentDate = null;
  let last = null;       // последнее событие: курс может прийти уже после времени

  const push = (date, hours, minutes) => {
    let title;
    if (course !== null || buffer.length < 2) {
      title = buffer.at(-1);
    } else {
      // Курс без метки семестра (другой формат) — считаем его второй строкой
      [title, course] = buffer.slice(-2);
    }
    const due = title && makeDate(date, hours, minutes, offset);
    if (due) {
      last = {
        id: `academo-${title}-${due.toISOString()}`,
        title,
        course: (course ?? '').replace(COURSE_RE, ''),
        type: 'other',
        groups: [],
        due_at: due.toISOString(),
        url: null,
        source: 'academo',
      };
      events.push(last);
    }
    buffer = [];
    course = null;
  };

  for (const line of lines) {
    const date = line.match(DATE_RE);
    if (date) {
      const [, weekday, day, month, year] = date;
      const parsed = { day: Number(day), month: MONTHS[month.toLowerCase()], year: year ? Number(year) : null };
      if (weekday || year) {
        // Заголовок дня на «Шкале времени»
        currentDate = parsed;
        buffer = [];
        course = null;
        last = null;
      } else if (buffer.length) {
        // Дата в конце карточки виджета: года нет, время не указано
        parsed.year = inferYear(parsed, now);
        push(parsed, 23, 59);
      }
      continue;
    }

    const time = line.match(TIME_RE);
    if (time) {
      if (buffer.length && currentDate) push(currentDate, Number(time[1]), Number(time[2]));
      else buffer = [];
      continue;
    }

    if (COURSE_RE.test(` ${line}`)) {
      if (buffer.length) course = line;
      else if (last && !last.course) last.course = line.replace(COURSE_RE, '');
      continue;
    }

    buffer.push(line);
  }

  return events;
}

// Ближайшая будущая дата: в октябре «5 января» — это уже следующий год
function inferYear({ day, month }, now) {
  const year = now.getFullYear();
  const candidate = new Date(year, month, day, 23, 59);
  return candidate < now - 864e5 ? year + 1 : year;
}

function makeDate({ day, month, year }, hours, minutes, offset) {
  const pad = (n) => String(n).padStart(2, '0');
  const date = new Date(`${year}-${pad(month + 1)}-${pad(day)}T${pad(hours)}:${pad(minutes)}:00${offset}`);
  return Number.isNaN(date.getTime()) ? null : date;
}
