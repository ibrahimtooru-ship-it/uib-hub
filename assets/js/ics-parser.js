// Минимальный парсер iCalendar (RFC 5545): достаём из VEVENT только то, что нужно для дедлайнов.
// Формат экспорта Academo не подтверждён, поэтому поддерживаем UTC (Z), локальное время с TZID и даты без времени.

export function parseICS(text, { defaultOffset = '+05:00' } = {}) {
  const lines = text
    .replace(/\r\n?/g, '\n')
    .replace(/\n[ \t]/g, '') // склеиваем «сложенные» строки
    .split('\n');

  const rawEvents = [];
  let current = null;

  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { current = {}; continue; }
    if (line === 'END:VEVENT') { if (current) rawEvents.push(current); current = null; continue; }
    if (!current) continue;

    const colon = findValueSeparator(line);
    if (colon < 0) continue;
    const [name, ...paramParts] = line.slice(0, colon).split(';');
    const params = Object.fromEntries(paramParts.map((part) => {
      const [key, value = ''] = part.split('=');
      return [key.toUpperCase(), value.replace(/^"|"$/g, '')];
    }));
    current[name.toUpperCase()] = { value: line.slice(colon + 1), params };
  }

  return rawEvents.map((raw) => toDeadline(raw, defaultOffset)).filter(Boolean);
}

// Первое двоеточие вне кавычек: в параметрах бывают URL вида ALTREP="https://..."
function findValueSeparator(line) {
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') quoted = !quoted;
    else if (line[i] === ':' && !quoted) return i;
  }
  return -1;
}

function parseIcsDate(prop, defaultOffset) {
  if (!prop) return null;
  const match = prop.value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!match) return null;
  // Дата без времени (VALUE=DATE) означает «до конца дня»
  const [, y, mo, d, h = '23', mi = '59', s = '00', utc] = match;
  const date = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}${utc ? 'Z' : defaultOffset}`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function unescapeText(value) {
  return value.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1').trim();
}

function toDeadline(raw, defaultOffset) {
  // Moodle-подобные LMS ставят DTSTART = DTEND = срок сдачи; у событий с длительностью дедлайн — конец
  const due = parseIcsDate(raw.DTEND, defaultOffset) ?? parseIcsDate(raw.DTSTART, defaultOffset);
  if (!due) return null;

  const title = unescapeText(raw.SUMMARY?.value ?? 'Без названия');
  return {
    id: `ics-${raw.UID?.value ?? `${title}-${due.getTime()}`}`,
    title,
    course: unescapeText(raw.CATEGORIES?.value ?? ''),
    type: 'other',
    groups: [],
    due_at: due.toISOString(),
    url: raw.URL?.value ?? null,
    source: 'academo-ics',
  };
}
