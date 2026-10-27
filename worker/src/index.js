// UIB Hub — приём работ в базу знаний (Cloudflare Worker).
//
//   POST /submit    ← форма «Добавить работу» на сайте (multipart: payload + необязательный file):
//                     работа и файл уходят в очередь (KV) и модераторам в Telegram с кнопками ✅ / ❌
//   POST /telegram  ← webhook бота: ✅ одним коммитом кладёт файл в files/ и работу в materials.json,
//                     ❌ удаляет заявку и файл из очереди
//
// Секреты (wrangler secret put): TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, GITHUB_TOKEN
// Переменные (wrangler.toml):    ALLOWED_ORIGIN, MODERATOR_CHAT_ID, GITHUB_REPO, GITHUB_BRANCH, MATERIALS_PATH,
//                                COMMIT_NAME, COMMIT_EMAIL
// KV namespace:                  SUBMISSIONS

const LIMITS = { subject: 120, work: 200, teacher: 80, tip: 1000, stackItems: 12, stackItem: 40, nick: 40, url: 500, programs: 3 };
const RATE_LIMIT_PER_HOUR = 5;
const PENDING_TTL = 60 * 60 * 24 * 30; // необработанная заявка живёт 30 дней
// Те же ограничения стоят в форме на сайте (assets/js/submit.js)
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const FILE_EXTENSIONS = ['pdf', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'txt', 'zip', 'png', 'jpg', 'jpeg'];

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    try {
      if (request.method === 'OPTIONS') return withCors(env, new Response(null, { status: 204 }));
      if (request.method === 'POST' && pathname === '/submit') return withCors(env, await handleSubmit(request, env));
      if (request.method === 'POST' && pathname === '/telegram') return await handleTelegram(request, env);
      return new Response('UIB Hub submissions worker');
    } catch (err) {
      console.error(err);
      return withCors(env, json({ ok: false, error: 'internal' }, 500));
    }
  },
};

// --- Приём заявки с сайта ---

async function readSubmission(request) {
  const type = request.headers.get('Content-Type') ?? '';
  if (type.includes('multipart/form-data')) {
    const form = await request.formData();
    const file = form.get('file');
    return { body: JSON.parse(form.get('payload') ?? 'null'), file: file && typeof file !== 'string' && file.size ? file : null };
  }
  return { body: await request.json(), file: null };
}

async function handleSubmit(request, env) {
  const origin = request.headers.get('Origin');
  if (env.ALLOWED_ORIGIN !== '*' && origin !== env.ALLOWED_ORIGIN) return json({ ok: false, error: 'forbidden' }, 403);

  let body;
  let file;
  try {
    ({ body, file } = await readSubmission(request));
  } catch {
    return json({ ok: false, error: 'bad_json' }, 400);
  }
  if (body?.type !== 'material') return json({ ok: false, error: 'unknown_type' }, 400);
  // Скрытое поле: люди его не видят, а боты заполняют. Делаем вид, что всё прошло
  if (body.website) return json({ ok: true });

  let attachment = null;
  if (file) {
    attachment = describeFile(file);
    if (attachment.error) return json({ ok: false, error: attachment.error }, 400);
  }

  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  if (!(await takeRateLimit(env, ip))) return json({ ok: false, error: 'rate_limited' }, 429);

  const { material, error } = cleanMaterial(body.data);
  if (error) return json({ ok: false, error }, 400);

  const pending = { material, attachment };
  if (attachment) {
    await env.SUBMISSIONS.put(`file:${material.id}`, await file.arrayBuffer(), { expirationTtl: PENDING_TTL });
  }
  await env.SUBMISSIONS.put(`pending:${material.id}`, JSON.stringify(pending), { expirationTtl: PENDING_TTL });

  const card = await telegram(env, 'sendMessage', {
    chat_id: env.MODERATOR_CHAT_ID,
    text: formatForModerators(material, attachment),
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ Опубликовать', callback_data: `a:${material.id}` },
        { text: '❌ Отклонить', callback_data: `r:${material.id}` },
      ]],
    },
  });
  // Файл отдельным сообщением под карточкой, чтобы модератор мог открыть его до решения
  if (attachment) {
    const form = new FormData();
    form.set('chat_id', env.MODERATOR_CHAT_ID);
    form.set('reply_to_message_id', String(card.message_id));
    form.set('document', file, attachment.name);
    await telegram(env, 'sendDocument', form);
  }
  return json({ ok: true, id: material.id });
}

function describeFile(file) {
  const name = String(file.name || 'file').slice(-120);
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  if (!FILE_EXTENSIONS.includes(ext)) return { error: 'file_type' };
  if (file.size > MAX_FILE_BYTES) return { error: 'file_too_big' };
  // Латиница для пути в репозитории; оригинальное имя остаётся подписью ссылки
  const slug = transliterate(name.slice(0, -(ext.length + 1)).toLowerCase())
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'file';
  return { name, size: file.size, ext, slug };
}

const TRANSLIT = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
  н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '',
  ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya', ә: 'a', ғ: 'g', қ: 'q', ң: 'n', ө: 'o', ұ: 'u', ү: 'u', һ: 'h', і: 'i',
};

function transliterate(text) {
  return [...text].map((ch) => TRANSLIT[ch] ?? ch).join('');
}

// KV не атомарный, так что лимит примерный — от массового спама его хватает
async function takeRateLimit(env, ip) {
  const key = `rl:${ip}`;
  const count = Number(await env.SUBMISSIONS.get(key)) || 0;
  if (count >= RATE_LIMIT_PER_HOUR) return false;
  await env.SUBMISSIONS.put(key, String(count + 1), { expirationTtl: 3600 });
  return true;
}

// Данным с сайта не доверяем: собираем запись заново, только из известных полей
function cleanMaterial(data) {
  if (!data || typeof data !== 'object') return { error: 'bad_data' };
  const str = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

  const subject = str(data.subject, LIMITS.subject);
  const work = str(data.work, LIMITS.work);
  if (!subject || !work) return { error: 'subject_and_work_required' };

  const programs = (Array.isArray(data.programs) ? data.programs : [])
    .filter((code) => typeof code === 'string' && /^[a-z0-9-]{1,40}$/.test(code))
    .slice(0, LIMITS.programs);
  if (!programs.length) return { error: 'program_required' };

  const year = Number(data.course_year);
  const got = Number(data.score?.got);
  const max = Number(data.score?.max);
  const score = data.score && Number.isFinite(got) && Number.isFinite(max) && max > 0 && got >= 0 && got <= max
    ? { got: Math.round(got), max: Math.round(max) }
    : null;

  const url = str(data.links?.[0]?.url, LIMITS.url);
  const links = /^https?:\/\/\S+$/i.test(url) ? [{ label: 'Материалы', url }] : [];

  const nick = str(data.author?.display, LIMITS.nick);
  const anonymous = data.author?.anonymous !== false || !nick || nick === 'Аноним';

  return {
    material: {
      id: `mat-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`,
      subject,
      work,
      programs,
      course_year: [1, 2, 3, 4].includes(year) ? year : null,
      semester: null,
      teacher: str(data.teacher, LIMITS.teacher) || null,
      score,
      stack: (Array.isArray(data.stack) ? data.stack : [])
        .map((item) => str(item, LIMITS.stackItem))
        .filter(Boolean)
        .slice(0, LIMITS.stackItems),
      tip: str(data.tip, LIMITS.tip),
      links,
      author: anonymous ? { display: 'Аноним', anonymous: true } : { display: nick, anonymous: false },
      created_at: new Date().toISOString(),
    },
  };
}

function formatForModerators(m, attachment) {
  const line = (label, value) => (value ? `<b>${label}:</b> ${escapeHtml(value)}` : null);
  return [
    '📚 <b>Новая работа для UIB Hub</b>',
    '',
    line('Предмет', m.subject),
    line('Работа', m.work),
    line('ОП', m.programs.join(', ')),
    line('Преподаватель', m.teacher),
    line('Курс', m.course_year && String(m.course_year)),
    line('Балл', m.score && `${m.score.got}/${m.score.max}`),
    line('Стек', m.stack.join(', ')),
    line('Совет', m.tip),
    line('Ссылка', m.links[0]?.url),
    line('Файл', attachment && `${attachment.name} (${(attachment.size / 1024 / 1024).toFixed(1)} МБ) — ниже`),
    line('Автор', m.author.display),
  ].filter((l) => l !== null).join('\n');
}

// --- Кнопки модератора ---

async function handleTelegram(request, env) {
  if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.TELEGRAM_WEBHOOK_SECRET) {
    return new Response('forbidden', { status: 403 });
  }
  const update = await request.json();
  const callback = update.callback_query;
  if (!callback?.data) return new Response('ok');

  // Нажимать кнопки можно только в чате модераторов
  if (String(callback.message?.chat?.id) !== String(env.MODERATOR_CHAT_ID)) {
    await answer(env, callback, 'Нет доступа');
    return new Response('ok');
  }

  const [action, id] = callback.data.split(':');
  const key = `pending:${id}`;
  const raw = await env.SUBMISSIONS.get(key);
  if (!raw) {
    await answer(env, callback, 'Эта заявка уже обработана');
    return new Response('ok');
  }

  const who = callback.from?.username ? `@${callback.from.username}` : (callback.from?.first_name ?? 'модератор');

  if (action === 'a') {
    // Сначала снимаем заявку с очереди, чтобы двойной клик не опубликовал её дважды
    await env.SUBMISSIONS.delete(key);
    try {
      const saved = JSON.parse(raw);
      // Заявки до появления файлов хранились как сама работа, без обёртки
      const pending = saved.material ? saved : { material: saved, attachment: null };
      const fileBytes = pending.attachment ? await env.SUBMISSIONS.get(`file:${id}`, 'arrayBuffer') : null;
      if (pending.attachment && !fileBytes) throw new Error('файл заявки не найден');
      await publish(env, pending, fileBytes);
    } catch (err) {
      console.error(err);
      await env.SUBMISSIONS.put(key, raw, { expirationTtl: PENDING_TTL });
      await answer(env, callback, `Не удалось опубликовать: ${String(err.message).slice(0, 150)}`);
      return new Response('ok');
    }
    await env.SUBMISSIONS.delete(`file:${id}`);
    await closeCard(env, callback, `✅ Опубликовано — ${who}`);
  } else if (action === 'r') {
    await env.SUBMISSIONS.delete(key);
    await env.SUBMISSIONS.delete(`file:${id}`);
    await closeCard(env, callback, `❌ Отклонено — ${who}`);
  }
  return new Response('ok');
}

async function closeCard(env, callback, status) {
  await telegram(env, 'editMessageText', {
    chat_id: callback.message.chat.id,
    message_id: callback.message.message_id,
    text: `${callback.message.text}\n\n${status}`,
    disable_web_page_preview: true,
  });
  await answer(env, callback, status);
}

function answer(env, callback, text) {
  return telegram(env, 'answerCallbackQuery', { callback_query_id: callback.id, text });
}

async function telegram(env, method, payload) {
  const isForm = payload instanceof FormData;
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: isForm ? undefined : { 'Content-Type': 'application/json' },
    body: isForm ? payload : JSON.stringify(payload),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram ${method}: ${data.description}`);
  return data.result;
}

// --- Публикация в GitHub ---
// Git Data API: файл и materials.json попадают в один коммит, значит одна сборка Pages на работу

async function publish(env, { material, attachment }, fileBytes) {
  const repo = `repos/${env.GITHUB_REPO}`;
  const branch = encodeURIComponent(env.GITHUB_BRANCH);
  const identity = { name: env.COMMIT_NAME, email: env.COMMIT_EMAIL };

  const entry = structuredClone(material);
  const files = [];
  if (attachment) {
    const path = `files/${material.id}/${attachment.slug}.${attachment.ext}`;
    files.push({ path, content: arrayBufferToBase64(fileBytes) });
    entry.links.unshift({ label: attachment.name, url: path, file: true });
  }

  // Если ветка ушла вперёд между чтением и записью, GitHub вернёт 422 — перечитываем и пробуем снова
  for (let attempt = 0; attempt < 3; attempt++) {
    const head = await github(env, 'GET', `${repo}/git/ref/heads/${branch}`);
    const parent = await github(env, 'GET', `${repo}/git/commits/${head.object.sha}`);
    const current = await github(env, 'GET', `${repo}/contents/${env.MATERIALS_PATH}?ref=${head.object.sha}`);
    const data = JSON.parse(fromBase64(current.content));
    data.materials ??= [];
    if (!data.materials.some((m) => m.id === entry.id)) data.materials.push(entry);

    const blobs = [
      ...files,
      { path: env.MATERIALS_PATH, content: toBase64(`${JSON.stringify(data, null, 2)}\n`) },
    ];
    const tree = [];
    for (const blob of blobs) {
      const created = await github(env, 'POST', `${repo}/git/blobs`, { content: blob.content, encoding: 'base64' });
      tree.push({ path: blob.path, mode: '100644', type: 'blob', sha: created.sha });
    }
    const newTree = await github(env, 'POST', `${repo}/git/trees`, { base_tree: parent.tree.sha, tree });
    const commit = await github(env, 'POST', `${repo}/git/commits`, {
      message: `Новая работа: ${material.subject} — ${material.work}`,
      tree: newTree.sha,
      parents: [head.object.sha],
      author: identity,
      committer: identity,
    });
    const res = await githubRaw(env, 'PATCH', `${repo}/git/refs/heads/${branch}`, { sha: commit.sha });
    if (res.status === 422) continue;
    if (!res.ok) throw new Error(`GitHub ${res.status}`);
    return;
  }
  throw new Error('GitHub: ветка постоянно меняется, попробуй ещё раз');
}

async function github(env, method, path, body) {
  const res = await githubRaw(env, method, path, body);
  if (!res.ok) throw new Error(`GitHub ${res.status}`);
  return res.json();
}

function githubRaw(env, method, path, body) {
  return fetch(`https://api.github.com/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'uib-hub-worker',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

// --- Утилиты ---

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  // Кусками: String.fromCharCode(...огромный массив) переполняет стек
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function toBase64(text) {
  return arrayBufferToBase64(new TextEncoder().encode(text));
}

function fromBase64(base64) {
  const binary = atob(base64.replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(binary, (ch) => ch.charCodeAt(0)));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}

function withCors(env, response) {
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', env.ALLOWED_ORIGIN);
  headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type');
  headers.set('Vary', 'Origin');
  return new Response(response.body, { status: response.status, headers });
}
