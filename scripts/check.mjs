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
        // Загруженный файл лежит в репозитории и связан с работой по id
        const ok = link.file ? link.url.startsWith(`files/${m.id}/`) : /^https?:\/\//.test(link.url);
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

  const request = (path, body, headers = {}) => ({ url: `https://w.test${path}`, method: 'POST', headers: new Headers(headers), json: async () => body });
  const upload = (payload, file, headers = site) => {
    const form = new FormData();
    form.set('payload', JSON.stringify(payload));
    if (file) form.set('file', file);
    return { url: 'https://w.test/submit', method: 'POST', headers: new Headers({ ...headers, 'Content-Type': 'multipart/form-data; boundary=x' }), formData: async () => form };
  };
  const site = { Origin: 'https://site.test', 'CF-Connecting-IP': '1.1.1.1' };
  const work = { type: 'material', data: { subject: 'Тест', work: 'Лаба', programs: ['ai', 'BAD'], teacher: 'Иванов И.И.', links: [{ url: 'javascript:alert(1)' }], author: { anonymous: true } } };
  const pdfBytes = Buffer.from('%PDF-1.4 тестовый файл');
  const problems = [];
  const expect = (ok, message) => { if (!ok) problems.push(message); };
  const press = (data, chat = -1, secret = 'S') => worker.fetch(request('/telegram',
    { callback_query: { id: 'q', data, from: { username: 'mod' }, message: { message_id: 1, chat: { id: chat }, text: 'Карточка' } } },
    { 'X-Telegram-Bot-Api-Secret-Token': secret }), env);
  const materials = () => JSON.parse(github.read('data/materials.json')).materials;

  try {
    // Заявка без файла (старый JSON-формат тоже принимается)
    let res = await worker.fetch(request('/submit', work, { ...site, 'Content-Type': 'application/json' }), env);
    const { id: plainId } = await res.json();
    expect(res.status === 200 && plainId, `приём работы: статус ${res.status}`);
    const saved = JSON.parse(kv.get(`pending:${plainId}`) ?? '{}').material ?? {};
    expect(saved.programs?.join() === 'ai' && saved.links?.length === 0 && saved.teacher === 'Иванов И.И.', 'Worker не очистил данные заявки');
    expect(telegram[0]?.method === 'sendMessage', 'карточка не ушла модераторам');

    // Заявка с файлом
    telegram.length = 0;
    res = await worker.fetch(upload(work, new File([pdfBytes], 'Отчёт по ООП.pdf')), env);
    const { id } = await res.json();
    expect(res.status === 200 && kv.get(`file:${id}`), `приём файла: статус ${res.status}`);
    const doc = telegram.find((t) => t.method === 'sendDocument');
    expect(doc && doc.body.reply_to_message_id === '77', 'файл не ушёл модераторам под карточкой');

    res = await worker.fetch(upload(work, new File(['MZ'], 'virus.exe')), env);
    expect(res.status === 400 && (await res.json()).error === 'file_type', 'принят файл .exe');
    res = await worker.fetch(upload(work, new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'big.pdf')), env);
    expect(res.status === 400 && (await res.json()).error === 'file_too_big', 'принят файл больше 10 МБ');

    // Защита
    res = await worker.fetch(upload(work, null, { ...site, Origin: 'https://evil.test' }), env);
    expect(res.status === 403, `чужой сайт: статус ${res.status}`);
    const pendingBefore = [...kv.keys()].filter((k) => k.startsWith('pending:')).length;
    res = await worker.fetch(upload({ ...work, website: 'spam' }, null), env);
    expect(res.status === 200 && [...kv.keys()].filter((k) => k.startsWith('pending:')).length === pendingBefore, 'ловушка для ботов пропустила заявку');
    res = await press(`a:${id}`, -1, 'wrong');
    expect(res.status === 403, 'вебхук без секрета не отклонён');
    await press(`a:${id}`, 999);
    expect(kv.has(`pending:${id}`), 'кнопка сработала в чужом чате');

    // Публикация с файлом: один коммит, файл и работа вместе; первый PATCH ловит конфликт
    github.conflictOnce();
    await press(`a:${id}`);
    const published = materials().find((m) => m.id === id);
    const fileLink = published?.links.find((l) => l.file);
    expect(published, 'работа с файлом не опубликована');
    expect(fileLink?.label === 'Отчёт по ООП.pdf' && fileLink.url === `files/${id}/otchyot-po-oop.pdf`, `ссылка на файл: ${fileLink?.url}`);
    expect(github.read(fileLink?.url ?? '')?.equals(pdfBytes), 'файл в репозитории не совпадает с загруженным');
    expect(github.commits.length === 1 && github.commits[0].files === 2, `ожидался 1 коммит с 2 файлами, было ${github.commits.map((c) => c.files)}`);
    expect(github.commits.every((c) => c.author.email === env.COMMIT_EMAIL && c.committer.email === env.COMMIT_EMAIL), 'в коммите не скрытая почта');
    expect(!kv.has(`file:${id}`) && !kv.has(`pending:${id}`), 'после публикации в очереди остался мусор');
    await press(`a:${id}`);
    expect(materials().filter((m) => m.id === id).length === 1, 'повторное нажатие опубликовало дважды');

    // Публикация без файла и отклонение
    await press(`a:${plainId}`);
    expect(materials().some((m) => m.id === plainId) && github.commits.at(-1).files === 1, 'работа без файла не опубликована');
    res = await worker.fetch(upload(work, new File([pdfBytes], 'lab.pdf')), env);
    const { id: rejectId } = await res.json();
    await press(`r:${rejectId}`);
    expect(!kv.has(`pending:${rejectId}`) && !kv.has(`file:${rejectId}`), 'после отклонения остались заявка или файл');
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
    handle(url, opts) {
      const path = url.replace('https://api.github.com/repos/me/repo/', '');
      const body = opts.body ? JSON.parse(opts.body) : null;
      if (path === 'git/ref/heads/main') return reply({ object: { sha: head } });
      if (path.startsWith('git/commits/')) return reply({ tree: { sha: commitTrees.get(path.split('/').pop()) } });
      if (path.startsWith('contents/')) {
        const [file, query] = path.slice('contents/'.length).split('?ref=');
        return reply({ content: trees.get(commitTrees.get(query)).get(file).toString('base64') });
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
