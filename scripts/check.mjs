// Локальные проверки UIB Hub. Запуск: node scripts/check.mjs
// Вместо CI на GitHub: хук .githooks/pre-push запускает их перед каждым push.
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
let passed = 0;

function check(name, fn) {
  try {
    const problems = fn() ?? [];
    if (problems.length) {
      failures.push(name);
      console.log(`✗ ${name}`);
      for (const p of problems.slice(0, 20)) console.log(`    – ${p}`);
    } else {
      passed++;
      console.log(`✓ ${name}`);
    }
  } catch (err) {
    failures.push(name);
    console.log(`✗ ${name}\n    – ${err.message}`);
  }
}

async function checkAsync(name, fn) {
  try {
    const problems = (await fn()) ?? [];
    if (problems.length) throw new Error(problems.join('\n    – '));
    passed++;
    console.log(`✓ ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`✗ ${name}\n    – ${err.message}`);
  }
}

const read = (path) => readFileSync(join(ROOT, path), 'utf8');
const json = (path) => JSON.parse(read(path));
const importLocal = (path) => import(pathToFileURL(join(ROOT, path)).href);
const isDate = (value) => typeof value === 'string' && !Number.isNaN(new Date(value).getTime());
const duplicates = (values) => values.filter((v, i) => values.indexOf(v) !== i);

// --- Синтаксис ---

const jsFiles = [
  ...readdirSync(join(ROOT, 'assets/js')).map((f) => `assets/js/${f}`),
  'worker/src/index.js',
  'scripts/check.mjs',
];
check(`Синтаксис JS (${jsFiles.length} файлов)`, () => jsFiles.flatMap((file) => {
  const res = spawnSync(process.execPath, ['--check', join(ROOT, file)], { encoding: 'utf8' });
  return res.status === 0 ? [] : [`${file}: ${res.stderr.trim().split('\n').slice(0, 3).join(' ')}`];
}));

const dataFiles = readdirSync(join(ROOT, 'data')).filter((f) => f.endsWith('.json'));
check(`JSON в data/ (${dataFiles.length} файлов)`, () => dataFiles.flatMap((file) => {
  try { json(`data/${file}`); return []; } catch (err) { return [`${file}: ${err.message}`]; }
}));

// --- Данные ---

const { EMOJI } = await importLocal('assets/js/emoji.js');
const programs = json('data/programs.json');
const programCodes = new Set(programs.programs.map((p) => p.code));

check('programs.json: направления, коды и эмодзи', () => {
  const directionIds = new Set(programs.directions.map((d) => d.id));
  return [
    ...duplicates(programs.programs.map((p) => p.code)).map((c) => `код ОП повторяется: ${c}`),
    ...duplicates(programs.directions.map((d) => d.id)).map((id) => `направление повторяется: ${id}`),
    ...programs.programs.filter((p) => !directionIds.has(p.direction)).map((p) => `${p.code}: нет направления «${p.direction}»`),
    ...[...programs.directions, ...programs.programs].filter((x) => !EMOJI[x.emoji]).map((x) => `${x.code ?? x.id}: нет эмодзи «${x.emoji}» в emoji.js`),
    ...programs.programs.filter((p) => !/^[a-z0-9-]{1,40}$/.test(p.code)).map((p) => `${p.code}: код не пройдёт проверку Worker'а`),
  ];
});

check('materials.json: обязательные поля, ОП, баллы, ссылки', () => {
  const items = json('data/materials.json').materials;
  return [
    ...duplicates(items.map((m) => m.id)).map((id) => `id повторяется: ${id}`),
    ...items.flatMap((m) => {
      const where = m.id ?? '(без id)';
      const problems = [];
      if (!m.subject || !m.work) problems.push(`${where}: нет subject или work`);
      if (!m.programs?.length) problems.push(`${where}: не указана ОП`);
      for (const code of m.programs ?? []) if (!programCodes.has(code)) problems.push(`${where}: неизвестная ОП «${code}»`);
      if (m.score && !(m.score.got >= 0 && m.score.got <= m.score.max)) problems.push(`${where}: балл ${m.score.got}/${m.score.max}`);
      if (m.course_year != null && ![1, 2, 3, 4].includes(m.course_year)) problems.push(`${where}: курс ${m.course_year}`);
      for (const link of m.links ?? []) if (!/^https?:\/\//.test(link.url)) problems.push(`${where}: ссылка ${link.url}`);
      if (!isDate(m.created_at)) problems.push(`${where}: дата created_at`);
      return problems;
    }),
  ];
});

check('deadlines.json: id и даты', () => {
  const items = json('data/deadlines.json').deadlines;
  return [
    ...duplicates(items.map((d) => d.id)).map((id) => `id повторяется: ${id}`),
    ...items.filter((d) => !d.title || !isDate(d.due_at)).map((d) => `${d.id}: нет названия или кривая дата`),
  ];
});

check('guide.json: разделы, эмодзи, таблицы', () => {
  const guide = json('data/guide.json');
  return [
    ...duplicates(guide.sections.map((s) => s.id)).map((id) => `раздел повторяется: ${id}`),
    ...guide.sections.filter((s) => !EMOJI[s.emoji]).map((s) => `${s.id}: нет эмодзи «${s.emoji}»`),
    ...guide.sections.filter((s) => s.table?.rows.some((r) => r.length !== s.table.head.length)).map((s) => `${s.id}: в таблице разное число колонок`),
    ...duplicates(guide.checklist.map((c) => c.id)).map((id) => `пункт чеклиста повторяется: ${id}`),
  ];
});

// --- Разметка ---

check('index.html: все id, которые ищет JS, существуют', () => {
  const html = read('index.html');
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const wanted = jsFiles.filter((f) => f.startsWith('assets/')).flatMap((file) =>
    [...read(file).matchAll(/getElementById\(['`]([^'`$]+)['`]\)/g)].map((m) => [file, m[1]]));
  // materials.js и guide.js собирают id из префикса: kb-${name}, guide-${name}
  for (const [file, prefix, list] of [
    ['assets/js/materials.js', 'kb-', /for \(const id of \[([^\]]+)\]\)/],
    ['assets/js/guide.js', 'guide-', /for \(const id of \[([^\]]+)\]\)/],
  ]) {
    const names = read(file).match(list)?.[1].match(/'([^']+)'/g) ?? [];
    for (const name of names) wanted.push([file, prefix + name.slice(1, -1)]);
  }
  return wanted.filter(([, id]) => !ids.has(id)).map(([file, id]) => `${relative(ROOT, join(ROOT, file))}: нет #${id}`);
});

// --- Парсеры ---

await checkAsync('Разбор текста из Academo (3 формата)', async () => {
  const { parseAcademoText } = await importLocal('assets/js/academo-parser.js');
  const now = new Date('2026-10-27T17:00:00+05:00');
  const cases = {
    'шкала времени (название → время → курс)': ['Четверг, 29 октября 2026 г.\nТест 9\n09:50\nФилософия 26/27 5 semester', 'Тест 9', 'Философия', '2026-10-29T04:50:00.000Z'],
    'шкала времени (название → курс → время)': ['Четверг, 29 октября 2026 г.\nТест 9\nФилософия 26/27 5 semester\n09:50', 'Тест 9', 'Философия', '2026-10-29T04:50:00.000Z'],
    'виджет на главной': ['Дедлайны\nThread\nОбъектно-ориентированное программирование на языке JAVA 26/...\n3 ноября', 'Thread', 'Объектно-ориентированное программирование на языке JAVA', '2026-11-03T18:59:00.000Z'],
  };
  return Object.entries(cases).flatMap(([name, [text, title, course, due]]) => {
    const [event] = parseAcademoText(text, { now });
    const got = event && [event.title, event.course, event.due_at].join(' | ');
    const want = [title, course, due].join(' | ');
    return got === want ? [] : [`${name}: получилось «${got}», ждали «${want}»`];
  });
});

await checkAsync('Разбор .ics', async () => {
  const { parseICS } = await importLocal('assets/js/ics-parser.js');
  const ics = 'BEGIN:VEVENT\r\nUID:1\r\nSUMMARY:Отчёт\\, часть 1\r\nCATEGORIES:Сети\r\nDTSTART:20261029T185900Z\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:2\r\nSUMMARY:Квиз\r\nDTSTART;TZID=Asia/Almaty:20261101T100000\r\nEND:VEVENT';
  const [a, b] = parseICS(ics);
  const problems = [];
  if (a?.title !== 'Отчёт, часть 1' || a?.due_at !== '2026-10-29T18:59:00.000Z') problems.push(`UTC-событие: ${JSON.stringify(a)}`);
  if (b?.due_at !== '2026-11-01T05:00:00.000Z') problems.push(`событие с TZID: ${b?.due_at}`);
  return problems;
});

// --- Worker (Telegram, GitHub и KV — заглушки, в сеть ничего не уходит) ---

await checkAsync('Worker: приём, защита, модерация, публикация', async () => {
  const worker = (await importLocal('worker/src/index.js')).default;
  const kv = new Map();
  const env = {
    SUBMISSIONS: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v); }, delete: async (k) => { kv.delete(k); } },
    ALLOWED_ORIGIN: 'https://site.test', MODERATOR_CHAT_ID: '-1', GITHUB_REPO: 'me/repo', GITHUB_BRANCH: 'main',
    MATERIALS_PATH: 'data/materials.json', COMMIT_NAME: 'UIB Hub', COMMIT_EMAIL: 'bot@users.noreply.github.com',
    TELEGRAM_BOT_TOKEN: 'T', TELEGRAM_WEBHOOK_SECRET: 'S', GITHUB_TOKEN: 'G',
  };
  const telegram = [];
  let file = { sha: 'a', text: JSON.stringify({ materials: [] }) };
  let lastPut = null;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    url = String(url);
    if (url.startsWith('https://api.telegram.org/')) {
      telegram.push({ method: url.split('/').pop(), body: JSON.parse(opts.body) });
      return new Response(JSON.stringify({ ok: true, result: {} }));
    }
    if (url.startsWith('https://api.github.com/')) {
      if (opts.method === 'GET') return new Response(JSON.stringify({ sha: file.sha, content: Buffer.from(file.text).toString('base64') }));
      lastPut = JSON.parse(opts.body);
      file = { sha: 'b', text: Buffer.from(lastPut.content, 'base64').toString('utf8') };
      return new Response('{}');
    }
    throw new Error(`Неожиданный запрос в сеть: ${url}`);
  };

  const request = (path, body, headers = {}) => ({ url: `https://w.test${path}`, method: 'POST', headers: new Headers(headers), json: async () => body });
  const site = { Origin: 'https://site.test', 'CF-Connecting-IP': '1.1.1.1' };
  const work = { type: 'material', data: { subject: 'Тест', work: 'Лаба', programs: ['ai', 'BAD'], teacher: 'Иванов И.И.', links: [{ url: 'javascript:alert(1)' }], author: { anonymous: true } } };
  const problems = [];
  const expect = (ok, message) => { if (!ok) problems.push(message); };

  try {
    let res = await worker.fetch(request('/submit', work, site), env);
    const { id } = await res.json();
    expect(res.status === 200 && id, `приём работы: статус ${res.status}`);
    const saved = JSON.parse(kv.get(`pending:${id}`) ?? '{}');
    expect(saved.programs?.join() === 'ai' && saved.links?.length === 0 && saved.teacher === 'Иванов И.И.', 'Worker не очистил данные заявки');
    expect(telegram[0]?.method === 'sendMessage', 'карточка не ушла модераторам');

    res = await worker.fetch(request('/submit', work, { ...site, Origin: 'https://evil.test' }), env);
    expect(res.status === 403, `чужой сайт: статус ${res.status}`);
    res = await worker.fetch(request('/submit', { ...work, website: 'spam' }, site), env);
    expect(res.status === 200 && kv.size === 2, 'ловушка для ботов пропустила заявку');

    const press = (data, chat = -1, secret = 'S') => worker.fetch(request('/telegram',
      { callback_query: { id: 'q', data, from: { username: 'mod' }, message: { message_id: 1, chat: { id: chat }, text: 'Карточка' } } },
      { 'X-Telegram-Bot-Api-Secret-Token': secret }), env);
    res = await press(`a:${id}`, -1, 'wrong');
    expect(res.status === 403, 'вебхук без секрета не отклонён');
    await press(`a:${id}`, 999);
    expect(kv.has(`pending:${id}`), 'кнопка сработала в чужом чате');

    await press(`a:${id}`);
    const published = JSON.parse(file.text).materials;
    expect(published.length === 1 && published[0].id === id, 'работа не опубликована');
    expect(lastPut?.author?.email === env.COMMIT_EMAIL && lastPut?.committer?.email === env.COMMIT_EMAIL, 'в коммите не скрытая почта');
    await press(`a:${id}`);
    expect(JSON.parse(file.text).materials.length === 1, 'повторное нажатие опубликовало дважды');
  } finally {
    globalThis.fetch = realFetch;
  }
  return problems;
});

console.log(failures.length
  ? `\n✗ Не прошло: ${failures.length} из ${passed + failures.length}`
  : `\n✓ Все проверки прошли (${passed})`);
process.exit(failures.length ? 1 : 0);
