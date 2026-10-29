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
      for (const link of m.links ?? []) {
        // Загруженный файл хранится закрыто в Worker'е: в базе только его имя, без публичной ссылки
        const ok = link.file ? !link.url && typeof link.label === 'string' : /^https?:\/\//.test(link.url);
        if (!ok) problems.push(`${where}: ссылка ${link.url}`);
      }
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

check('courses.json: только факты, преподаватели без фамилий и контактов', () => {
  const courses = json('data/courses.json').courses;
  return [
    ...duplicates(courses.map((c) => c.id)).map((id) => `курс повторяется: ${id}`),
    ...courses.flatMap((c) => {
      const problems = [];
      if (!c.id || !c.name) problems.push(`${c.id ?? '(без id)'}: нет id или названия`);
      if (c.course_year != null && ![1, 2, 3, 4].includes(c.course_year)) problems.push(`${c.id}: курс ${c.course_year}`);
      if (c.credits != null && !(Number.isInteger(c.credits) && c.credits > 0 && c.credits <= 30)) problems.push(`${c.id}: кредиты ${c.credits}`);
      for (const code of c.programs ?? []) if (!programCodes.has(code)) problems.push(`${c.id}: неизвестная ОП «${code}»`);
      for (const role of ['lecturer', 'seminar']) {
        const name = c[role];
        if (!name) continue;
        // Имя и отчество — два слова; третье почти всегда фамилия
        if (name.trim().split(/\s+/).length > 2) problems.push(`${c.id}: «${name}» — похоже на фамилию, оставь имя и отчество`);
        if (/@|https?:|\d{3}/.test(name)) problems.push(`${c.id}: в имени преподавателя контакт или ссылка`);
      }
      return problems;
    }),
  ];
});

check('tips.json: анонимно, темы, без фамилий', () => {
  const tips = json('data/tips.json').tips;
  const topics = ['how', 'focus', 'format', 'deadlines', 'attendance', 'other'];
  return [
    ...duplicates(tips.map((t) => t.id)).map((id) => `совет повторяется: ${id}`),
    ...tips.flatMap((t) => {
      const problems = [];
      if (!/^tip-[a-z0-9-]+$/.test(t.id ?? '')) problems.push(`кривой id: ${t.id}`);
      if (!topics.includes(t.topic)) problems.push(`${t.id}: тема «${t.topic}»`);
      if (!t.text || t.text.length < 20 || t.text.length > 800) problems.push(`${t.id}: длина текста`);
      if (!t.course && !t.teacher) problems.push(`${t.id}: нет курса и преподавателя`);
      if (t.teacher && t.teacher.trim().split(/\s+/).length > 2) problems.push(`${t.id}: «${t.teacher}» — похоже на фамилию`);
      if ('author' in t || 'barcode' in t) problems.push(`${t.id}: в совете есть автор`);
      if (!isDate(t.created_at)) problems.push(`${t.id}: дата`);
      return problems;
    }),
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

check('Аватарки: списки на сайте и в Worker совпадают, картинки на месте', () => {
  const site = [...read('assets/js/auth.js').matchAll(/\{ id: '([a-z]+)', label:/g)].map((m) => m[1]);
  const worker = read('worker/src/index.js').match(/const AVATARS = \[([^\]]+)\]/)?.[1].match(/'([a-z]+)'/g)?.map((x) => x.slice(1, -1)) ?? [];
  const files = readdirSync(join(ROOT, 'assets/avatars')).map((f) => f.replace(/\.jpg$/, ''));
  return [
    ...(site.join() === worker.join() ? [] : [`сайт: ${site.join()} ≠ Worker: ${worker.join()}`]),
    ...site.filter((id) => !files.includes(id)).map((id) => `нет картинки assets/avatars/${id}.jpg`),
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
    ['assets/js/auth.js', 'auth-', /for \(const id of \[([^\]]+)\]\)/],
    ['assets/js/tips.js', 'tips-', /for \(const id of \[([^\]]+)\]\)/],
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

await checkAsync('Worker: аккаунты, сброс пароля, аватарки, работы, заявки, файлы, советы, /stats', async () => {
  const worker = (await importLocal('worker/src/index.js')).default;
  // KV в памяти: значение + metadata, как в Cloudflare
  const kv = new Map();
  const env = {
    SUBMISSIONS: {
      get: async (k, type) => { const v = kv.get(k)?.value ?? null; return type === 'json' && v !== null ? JSON.parse(v) : v; },
      list: async ({ prefix = '' } = {}) => ({ keys: [...kv.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }),
      getWithMetadata: async (k) => kv.get(k) ?? { value: null, metadata: null },
      put: async (k, value, opts = {}) => { kv.set(k, { value, metadata: opts.metadata ?? null }); },
      delete: async (k) => { kv.delete(k); },
    },
    ALLOWED_ORIGIN: 'https://site.test', MODERATOR_CHAT_ID: '-1', GITHUB_REPO: 'me/repo', GITHUB_BRANCH: 'main',
    MATERIALS_PATH: 'data/materials.json', COMMIT_NAME: 'UIB Hub', COMMIT_EMAIL: 'bot@users.noreply.github.com',
    TELEGRAM_BOT_TOKEN: 'T', TELEGRAM_WEBHOOK_SECRET: 'S', GITHUB_TOKEN: 'G',
  };
  const telegram = [];
  const github = fakeGitHub({ 'data/materials.json': Buffer.from(JSON.stringify({ materials: [] })) });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    url = String(url);
    if (url.startsWith('https://api.telegram.org/')) {
      const isForm = opts.body instanceof FormData;
      telegram.push({ method: url.split('/').pop(), body: isForm ? Object.fromEntries(opts.body) : JSON.parse(opts.body) });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 77 } }));
    }
    if (url.startsWith('https://api.github.com/repos/me/repo/')) return github.handle(url, opts);
    throw new Error(`Неожиданный запрос в сеть: ${url}`);
  };

  const site = { Origin: 'https://site.test', 'CF-Connecting-IP': '1.1.1.1' };
  const auth = (token) => (token ? { Authorization: `Bearer ${token}` } : {});
  const call = (method, path, { body, token, headers = site } = {}) => worker.fetch({
    url: `https://w.test${path}`,
    method,
    headers: new Headers({ ...headers, 'Content-Type': 'application/json', ...auth(token) }),
    json: async () => body,
  }, env);
  const upload = (token, payload, file, headers = site) => {
    const form = new FormData();
    form.set('payload', JSON.stringify(payload));
    if (file) form.set('file', file);
    return worker.fetch({
      url: 'https://w.test/submit',
      method: 'POST',
      headers: new Headers({ ...headers, 'Content-Type': 'multipart/form-data; boundary=x', ...auth(token) }),
      formData: async () => form,
    }, env);
  };
  const press = (data, chat = -1, secret = 'S') => worker.fetch({
    url: 'https://w.test/telegram',
    method: 'POST',
    headers: new Headers({ 'X-Telegram-Bot-Api-Secret-Token': secret }),
    json: async () => ({ callback_query: { id: 'q', data, from: { username: 'mod' }, message: { message_id: 1, chat: { id: chat }, text: 'Карточка' } } }),
  }, env);
  const materials = () => JSON.parse(github.read('data/materials.json')).materials;
  const pendingCount = () => [...kv.keys()].filter((k) => k.startsWith('pending:')).length;
  const work = { type: 'material', data: { subject: 'Тест', work: 'Лаба', programs: ['ai', 'BAD'], teacher: 'Иванов И.И.', links: [{ url: 'javascript:alert(1)' }], author: { anonymous: true } } };
  const pdfBytes = Buffer.from('%PDF-1.4 тестовый файл');
  const problems = [];
  const expect = (ok, message) => { if (!ok) problems.push(message); };

  try {
    // --- Аккаунты ---
    let res = await call('POST', '/auth/register', { body: { barcode: '12ab', password: 'secret123', nickname: 'Кот' } });
    expect(res.status === 400 && (await res.json()).error === 'bad_barcode', 'принят кривой баркод');
    res = await call('POST', '/auth/register', { body: { barcode: '1111111', password: 'short', nickname: 'Кот' } });
    expect(res.status === 400 && (await res.json()).error === 'bad_password', 'принят короткий пароль');
    res = await call('POST', '/auth/register', { body: { barcode: '1111111', password: 'secret123', nickname: 'Аноним' } });
    expect(res.status === 400, 'можно занять служебный ник «Аноним»');

    res = await call('POST', '/auth/register', { body: { barcode: '1111111', password: 'secret123', nickname: 'Кот Учёный' } });
    const reg = await res.json();
    expect(res.status === 200 && reg.token && reg.user?.nickname === 'Кот Учёный', `регистрация: ${res.status}`);
    expect(!JSON.stringify(reg).includes('1111111'), 'сайту отдан баркод целиком');
    expect(!JSON.stringify(kv.get('user:1111111')?.value).includes('secret123'), 'пароль хранится открытым текстом');
    res = await call('POST', '/auth/register', { body: { barcode: '1111111', password: 'other1234', nickname: 'Другой' } });
    expect(res.status === 409 && (await res.json()).error === 'barcode_taken', 'второй аккаунт на тот же баркод');
    res = await call('POST', '/auth/register', { body: { barcode: '2222222', password: 'other1234', nickname: 'кот учёный' } });
    expect(res.status === 409 && (await res.json()).error === 'nickname_taken', 'ник занят без учёта регистра');

    res = await call('POST', '/auth/login', { body: { barcode: '1111111', password: 'wrong-pass' } });
    expect(res.status === 401, 'вход с неверным паролем');
    res = await call('POST', '/auth/login', { body: { barcode: '1111111', password: 'secret123' } });
    let { token } = await res.json();
    expect(res.status === 200 && token, `вход с верным паролем: ${res.status}`);
    res = await call('GET', '/auth/me', { token });
    expect(res.status === 200 && (await res.json()).user?.nickname === 'Кот Учёный', '/auth/me по токену');
    res = await call('GET', '/auth/me', { token: 'x'.repeat(43) });
    expect(res.status === 401, 'принят чужой токен');

    await call('POST', '/auth/register', { body: { barcode: '3333333', password: 'right-pass', nickname: 'Брутфорс' } });
    for (let i = 0; i < 10; i++) await call('POST', '/auth/login', { body: { barcode: '3333333', password: `guess${i}` } });
    res = await call('POST', '/auth/login', { body: { barcode: '3333333', password: 'right-pass' } });
    expect(res.status === 429, 'нет защиты от перебора пароля');

    res = await call('POST', '/auth/login', { body: { barcode: '1111111', password: 'secret123' }, headers: { ...site, Origin: 'https://evil.test' } });
    expect(res.status === 403, 'вход с чужого сайта');

    // --- Приём работ: только после входа ---
    res = await upload(null, work, null);
    expect(res.status === 401, 'работа принята без входа');

    telegram.length = 0;
    res = await upload(token, { type: 'material', data: { ...work.data, author: { anonymous: false } } }, null);
    const { id: plainId } = await res.json();
    expect(res.status === 200 && plainId, `приём работы: ${res.status}`);
    const saved = JSON.parse(kv.get(`pending:${plainId}`)?.value ?? '{}').material ?? {};
    expect(saved.programs?.join() === 'ai' && saved.links?.length === 0 && saved.teacher === 'Иванов И.И.', 'Worker не очистил данные заявки');
    expect(saved.author?.display === 'Кот Учёный', `автор не взят из аккаунта: ${saved.author?.display}`);
    expect(telegram[0]?.method === 'sendMessage' && telegram[0].body.text.includes('1111111'), 'модераторы не видят баркод автора');

    telegram.length = 0;
    res = await upload(token, work, new File([pdfBytes], 'Отчёт по ООП.pdf'));
    const { id } = await res.json();
    expect(res.status === 200 && kv.get(`file:${id}`), `приём файла: ${res.status}`);
    const doc = telegram.find((t) => t.method === 'sendDocument');
    expect(doc && doc.body.reply_to_message_id === '77', 'файл не ушёл модераторам под карточкой');

    res = await upload(token, work, new File(['MZ'], 'virus.exe'));
    expect(res.status === 400 && (await res.json()).error === 'file_type', 'принят файл .exe');
    res = await upload(token, work, new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'big.pdf'));
    expect(res.status === 400 && (await res.json()).error === 'file_too_big', 'принят файл больше 10 МБ');

    const before = pendingCount();
    res = await upload(token, { ...work, website: 'spam' }, null);
    expect(res.status === 200 && pendingCount() === before, 'ловушка для ботов пропустила заявку');
    res = await press(`a:${id}`, -1, 'wrong');
    expect(res.status === 403, 'вебхук без секрета не отклонён');
    await press(`a:${id}`, 999);
    expect(kv.has(`pending:${id}`), 'кнопка сработала в чужом чате');

    // --- Публикация: файл уходит в закрытое хранилище, а не в репозиторий; первый PATCH ловит конфликт ---
    github.conflictOnce();
    await press(`a:${id}`);
    const published = materials().find((m) => m.id === id);
    const fileLink = published?.links.find((l) => l.file);
    expect(published, 'работа с файлом не опубликована');
    expect(fileLink?.label === 'Отчёт по ООП.pdf' && !fileLink.url, `у файла публичная ссылка: ${fileLink?.url}`);
    expect(github.commits.length === 1 && github.commits[0].files === 1, `ожидался 1 коммит только с materials.json, было ${github.commits.map((c) => c.files)}`);
    expect(!github.files().some((f) => f.startsWith('files/')), 'файл попал в публичный репозиторий');
    expect(github.commits.every((c) => c.author.email === env.COMMIT_EMAIL && c.committer.email === env.COMMIT_EMAIL), 'в коммите не скрытая почта');
    expect(!JSON.stringify(materials()).includes('1111111'), 'баркод попал в опубликованную работу');
    expect(!kv.has(`file:${id}`) && !kv.has(`pending:${id}`) && kv.has(`stored:${id}`), 'файл не переехал из очереди в хранилище');
    await press(`a:${id}`);
    expect(materials().filter((m) => m.id === id).length === 1, 'повторное нажатие опубликовало дважды');

    // --- Скачивание: только после входа ---
    res = await call('GET', `/files/${id}`);
    expect(res.status === 401, 'файл скачан без входа');
    res = await call('GET', `/files/${id}`, { token });
    expect(res.status === 200 && Buffer.from(await res.arrayBuffer()).equals(pdfBytes), 'скачанный файл не совпадает');
    expect((res.headers.get('Content-Disposition') ?? '').includes(`filename*=UTF-8''${encodeURIComponent('Отчёт по ООП.pdf')}`), 'имя файла при скачивании');
    res = await call('GET', '/files/mat-nope', { token });
    expect(res.status === 404, `несуществующий файл: ${res.status}`);

    // --- Публикация без файла, отклонение, выход ---
    await press(`a:${plainId}`);
    expect(materials().some((m) => m.id === plainId), 'работа без файла не опубликована');
    res = await upload(token, work, new File([pdfBytes], 'lab.pdf'));
    const { id: rejectId } = await res.json();
    await press(`r:${rejectId}`);
    expect(!kv.has(`pending:${rejectId}`) && !kv.has(`file:${rejectId}`), 'после отклонения остались заявка или файл');

    // --- Аватарка ---
    res = await call('POST', '/auth/profile', { body: { avatar: 'it' } });
    expect(res.status === 401, 'аватарка меняется без входа');
    res = await call('POST', '/auth/profile', { body: { avatar: '../../etc' }, token });
    expect(res.status === 400, 'принята аватарка не из списка');
    res = await call('POST', '/auth/profile', { body: { avatar: 'law' }, token });
    expect(res.status === 200 && (await res.json()).user?.avatar === 'law', 'аватарка не сохранилась');
    res = await upload(token, { type: 'material', data: { ...work.data, author: { anonymous: false } } }, null);
    const { id: avatarWorkId } = await res.json();
    expect(JSON.parse(kv.get(`pending:${avatarWorkId}`)?.value ?? '{}').material?.author?.avatar === 'law', 'аватарка не попала в подпись работы');
    await press(`r:${avatarWorkId}`);
    res = await call('POST', '/auth/profile', { body: { avatar: null }, token });
    expect(res.status === 200 && (await res.json()).user?.avatar === null, 'нельзя убрать аватарку');

    // --- Заявка маркетплейса: в чат модераторов, а не в чей-то личный Telegram ---
    const order = { category: 'notes', subject: 'Философия', task: 'Конспект 8 лекций', deadline_at: '2026-10-30T20:39:00.000Z', price: 3000, comment: 'Тетрадь', contact: 'student_tg' };
    res = await call('POST', '/orders', { body: order });
    expect(res.status === 401, 'заявка принята без входа');
    res = await call('POST', '/orders', { body: { ...order, contact: 'кот' }, token });
    expect(res.status === 400 && (await res.json()).error === 'bad_contact', 'принят кривой Telegram');
    telegram.length = 0;
    res = await call('POST', '/orders', { body: order, token });
    const card = telegram.find((t) => t.method === 'sendMessage')?.body;
    expect(res.status === 200 && card?.chat_id === env.MODERATOR_CHAT_ID, `заявка не дошла до модераторов: ${res.status}`);
    expect(card?.text.includes('@student_tg') && card.text.includes('1111111') && card.text.includes('31 октября') && card.text.includes('01:39'), `карточка заявки: ${card?.text}`);

    // --- Восстановление пароля через модераторов ---
    res = await call('POST', '/auth/reset-request', { body: { barcode: '9999999', contact: '@ghost_user' } });
    const unknown = res.status;
    telegram.length = 0;
    res = await call('POST', '/auth/reset-request', { body: { barcode: '1111111', contact: '@kot_tg' } });
    expect(res.status === 200 && unknown === 200, 'ответ выдаёт, существует ли баркод');
    const resetCard = telegram.find((t) => t.method === 'sendMessage')?.body;
    expect(resetCard?.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data === 'k:1111111' && resetCard.text.includes('@kot_tg'), 'заявка на сброс не дошла до модераторов');

    telegram.length = 0;
    await press('k:1111111', 999);
    expect(!kv.has('reset:1111111'), 'код выдан из чужого чата');
    await press('k:1111111');
    const issued = telegram.find((t) => t.method === 'editMessageText')?.body.text ?? '';
    const code = issued.match(/[A-Z2-9]{4}-[A-Z2-9]{4}/)?.[0];
    expect(code && issued.includes('@kot_tg'), `код не показан модератору: ${issued}`);
    telegram.length = 0;
    await press('k:1111111');
    expect(telegram.some((t) => t.body.text === 'Заявка устарела или код уже выдан'), 'код выдан второй раз по той же заявке');

    res = await call('POST', '/auth/reset', { body: { barcode: '1111111', code: 'AAAA-AAAA', password: 'new-pass-123' } });
    expect(res.status === 400 && (await res.json()).error === 'bad_code', 'принят неверный код');
    res = await call('POST', '/auth/reset', { body: { barcode: '1111111', code: code?.toLowerCase(), password: 'new-pass-123' } });
    const reset = await res.json();
    expect(res.status === 200 && reset.token, `сброс по коду: ${res.status}`);
    res = await call('GET', '/auth/me', { token });
    expect(res.status === 401, 'старая сессия работает после сброса пароля');
    res = await call('POST', '/auth/login', { body: { barcode: '1111111', password: 'secret123' } });
    expect(res.status === 401, 'старый пароль работает после сброса');
    res = await call('POST', '/auth/reset', { body: { barcode: '1111111', code, password: 'another-pass' } });
    expect(res.status === 400, 'код сработал второй раз');
    token = reset.token;

    // Сессии до сброса паролей хранили только баркод — они должны продолжать работать
    kv.set('session:legacy-token-0123456789abcdef', { value: '2222222', metadata: null });
    await call('POST', '/auth/register', { body: { barcode: '2222222', password: 'legacy-pass', nickname: 'Старожил' } });
    res = await call('GET', '/auth/me', { token: 'legacy-token-0123456789abcdef' });
    expect(res.status === 200, 'сессия старого формата перестала работать');

    // --- Препод-конфиденциально: анонимные советы через модераторов ---
    const tipText = 'Лабы принимает только с отчётом в PDF, на защите спрашивает теорию.';
    res = await call('POST', '/tips', { body: { course: 'ООП на Java', topic: 'how', text: tipText } });
    expect(res.status === 401, 'совет принят без входа');
    res = await call('POST', '/tips', { body: { course: 'ООП на Java', topic: 'how', text: 'коротко' }, token });
    expect(res.status === 400 && (await res.json()).error === 'tip_too_short', 'принят слишком короткий совет');
    res = await call('POST', '/tips', { body: { course: 'ООП на Java', teacher: 'Иванова Анна Петровна', topic: 'how', text: tipText }, token });
    expect(res.status === 400 && (await res.json()).error === 'teacher_surname', 'принят преподаватель с фамилией');
    telegram.length = 0;
    res = await call('POST', '/tips', { body: { course: 'ООП на Java', teacher: 'Багила Кенесовна', topic: 'focus', text: tipText }, token });
    const { id: tipId } = await res.json();
    const tipCard = telegram.find((t) => t.method === 'sendMessage')?.body;
    expect(res.status === 200 && tipCard?.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data === `ta:${tipId}` && tipCard.text.includes('1111111'), `совет не дошёл до модераторов: ${res.status}`);
    expect(!github.files().includes('data/tips.json'), 'совет попал на сайт до проверки');

    await press(`ta:${tipId}`, 999);
    expect(!github.files().includes('data/tips.json'), 'совет опубликован из чужого чата');
    await press(`ta:${tipId}`);
    const tips = () => JSON.parse(github.read('data/tips.json') ?? '{"tips":[]}').tips;
    const publishedTip = tips().find((t) => t.id === tipId);
    expect(publishedTip?.teacher === 'Багила Кенесовна' && publishedTip.topic === 'focus', 'совет не опубликован');
    expect(!JSON.stringify(tips()).includes('1111111') && !JSON.stringify(tips()).includes('Кот'), 'в опубликованном совете виден автор');
    await press(`ta:${tipId}`);
    expect(tips().filter((t) => t.id === tipId).length === 1, 'совет опубликован дважды');

    res = await call('POST', '/tips', { body: { course: 'Философия', topic: 'how', text: 'Это плохой совет, который не пройдёт модерацию.' }, token });
    const { id: rejectedTip } = await res.json();
    await press(`tr:${rejectedTip}`);
    expect(!tips().some((t) => t.id === rejectedTip) && !kv.has(`pendingtip:${rejectedTip}`), 'отклонённый совет остался');

    res = await call('POST', '/tips/vote', { body: { id: tipId } });
    expect(res.status === 401, '«Полезно» без входа');
    res = await call('POST', '/tips/vote', { body: { id: tipId }, token });
    expect((await res.json()).count === 1, '«Полезно» не засчитано');
    res = await call('GET', '/tips/votes', { token });
    const votes = await res.json();
    expect(votes.counts?.[tipId] === 1 && votes.mine?.includes(tipId), 'счётчики «Полезно»');
    res = await call('POST', '/tips/vote', { body: { id: tipId }, token });
    expect((await res.json()).count === 0, 'повторное «Полезно» не сняло голос');

    telegram.length = 0;
    res = await call('POST', '/tips/report', { body: { id: tipId, reason: 'неправда' }, token });
    const report = telegram.find((t) => t.method === 'sendMessage')?.body;
    expect(res.status === 200 && report?.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data === `td:${tipId}`, 'жалоба не дошла до модераторов');
    expect(tips().some((t) => t.id === tipId), 'жалоба сама скрыла совет');
    await press(`td:${tipId}`);
    expect(!tips().some((t) => t.id === tipId), '«Удалить совет» не убрал его с сайта');

    await call('POST', '/auth/logout', { token });
    res = await call('GET', '/auth/me', { token });
    expect(res.status === 401, 'после выхода токен ещё работает');

    // --- /stats в чате модераторов ---
    const say = (text, chat = -1) => worker.fetch({
      url: 'https://w.test/telegram',
      method: 'POST',
      headers: new Headers({ 'X-Telegram-Bot-Api-Secret-Token': 'S' }),
      json: async () => ({ message: { message_id: 5, text, chat: { id: chat } } }),
    }, env);
    telegram.length = 0;
    await say('/stats', 999);
    await say('привет');
    expect(telegram.length === 0, 'бот ответил не на /stats или в чужом чате');
    await say('/stats@uib_hub_mod_bot');
    const stats = telegram.find((m) => m.method === 'sendMessage')?.body.text ?? '';
    const users = [...kv.keys()].filter((k) => k.startsWith('user:')).length;
    expect(stats.includes(`Аккаунтов: <b>${users}</b>`), `в /stats неверное число аккаунтов: ${stats.split('\n')[2]}`);
    expect(stats.includes(`Работ в базе: <b>${materials().length}</b>`), 'в /stats неверное число работ');
  } finally {
    globalThis.fetch = realFetch;
  }
  return problems;
});

// Минимальный GitHub Git Data API в памяти: ref → commit → дерево файлов
function fakeGitHub(initialFiles) {
  const blobs = new Map();
  const trees = new Map([['t0', new Map(Object.entries(initialFiles))]]);
  const commitTrees = new Map([['c0', 't0']]);
  const meta = new Map(); // sha коммита → автор и коммиттер
  const commits = [];     // коммиты, которые реально попали в ветку
  let head = 'c0';
  let counter = 0;
  let conflict = false;
  const reply = (data, status = 200) => new Response(JSON.stringify(data), { status });

  return {
    commits,
    conflictOnce: () => { conflict = true; },
    read: (path) => trees.get(commitTrees.get(head)).get(path),
    files: () => [...trees.get(commitTrees.get(head)).keys()],
    handle(url, opts) {
      const path = url.replace('https://api.github.com/repos/me/repo/', '');
      const body = opts.body ? JSON.parse(opts.body) : null;
      if (path === 'git/ref/heads/main') return reply({ object: { sha: head } });
      if (path.startsWith('git/commits/')) return reply({ tree: { sha: commitTrees.get(path.split('/').pop()) } });
      if (path.startsWith('contents/')) {
        const [file, query] = path.slice('contents/'.length).split('?ref=');
        // ref — sha коммита или имя ветки
        const bytes = trees.get(commitTrees.get(query === 'main' ? head : query)).get(file);
        // Как настоящий GitHub: файла ещё нет — 404
        return bytes ? reply({ content: bytes.toString('base64') }) : reply({ message: 'Not Found' }, 404);
      }
      if (path === 'git/blobs') {
        const sha = `b${++counter}`;
        blobs.set(sha, Buffer.from(body.content, 'base64'));
        return reply({ sha });
      }
      if (path === 'git/trees') {
        const sha = `t${++counter}`;
        const files = new Map(trees.get(body.base_tree));
        for (const entry of body.tree) files.set(entry.path, blobs.get(entry.sha));
        trees.set(sha, files);
        return reply({ sha, size: body.tree.length });
      }
      if (path === 'git/commits') {
        const sha = `c${++counter}`;
        commitTrees.set(sha, body.tree);
        meta.set(sha, { author: body.author, committer: body.committer });
        return reply({ sha });
      }
      if (path === 'git/refs/heads/main') {
        if (conflict) {
          // Кто-то успел закоммитить раньше: ветка ушла вперёд
          conflict = false;
          const sha = `c${++counter}`;
          commitTrees.set(sha, commitTrees.get(head));
          head = sha;
          return reply({ message: 'Update is not a fast forward' }, 422);
        }
        const parentFiles = trees.get(commitTrees.get(head));
        const newFiles = trees.get(commitTrees.get(body.sha));
        const changed = [...newFiles].filter(([p, v]) => !parentFiles.get(p)?.equals(v)).length;
        commits.push({ ...meta.get(body.sha), files: changed });
        head = body.sha;
        return reply({ object: { sha: head } });
      }
      return reply({ message: `не поддержано: ${opts.method} ${path}` }, 500);
    },
  };
}

console.log(failures.length
  ? `\n✗ Не прошло: ${failures.length} из ${passed + failures.length}`
  : `\n✓ Все проверки прошли (${passed})`);
process.exit(failures.length ? 1 : 0);
