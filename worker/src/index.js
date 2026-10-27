// UIB Hub — приём работ в базу знаний (Cloudflare Worker).
//
//   POST /submit    ← форма «Добавить работу» на сайте: работа уходит в очередь (KV)
//                     и модераторам в Telegram с кнопками ✅ / ❌
//   POST /telegram  ← webhook бота: ✅ коммитит работу в materials.json через GitHub API,
//                     ❌ удаляет её из очереди
//
// Секреты (wrangler secret put): TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, GITHUB_TOKEN
// Переменные (wrangler.toml):    ALLOWED_ORIGIN, MODERATOR_CHAT_ID, GITHUB_REPO, GITHUB_BRANCH, MATERIALS_PATH,
//                                COMMIT_NAME, COMMIT_EMAIL
// KV namespace:                  SUBMISSIONS

const LIMITS = { subject: 120, work: 200, teacher: 80, tip: 1000, stackItems: 12, stackItem: 40, nick: 40, url: 500, programs: 3 };
const RATE_LIMIT_PER_HOUR = 5;
const PENDING_TTL = 60 * 60 * 24 * 30; // необработанная заявка живёт 30 дней

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

async function handleSubmit(request, env) {
  const origin = request.headers.get('Origin');
  if (env.ALLOWED_ORIGIN !== '*' && origin !== env.ALLOWED_ORIGIN) return json({ ok: false, error: 'forbidden' }, 403);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'bad_json' }, 400);
  }
  if (body?.type !== 'material') return json({ ok: false, error: 'unknown_type' }, 400);
  // Скрытое поле: люди его не видят, а боты заполняют. Делаем вид, что всё прошло
  if (body.website) return json({ ok: true });

  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  if (!(await takeRateLimit(env, ip))) return json({ ok: false, error: 'rate_limited' }, 429);

  const { material, error } = cleanMaterial(body.data);
  if (error) return json({ ok: false, error }, 400);

  await env.SUBMISSIONS.put(`pending:${material.id}`, JSON.stringify(material), { expirationTtl: PENDING_TTL });
  await telegram(env, 'sendMessage', {
    chat_id: env.MODERATOR_CHAT_ID,
    text: formatForModerators(material),
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ Опубликовать', callback_data: `a:${material.id}` },
        { text: '❌ Отклонить', callback_data: `r:${material.id}` },
      ]],
    },
  });
  return json({ ok: true, id: material.id });
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

function formatForModerators(m) {
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
      await publishMaterial(env, JSON.parse(raw));
    } catch (err) {
      console.error(err);
      await env.SUBMISSIONS.put(key, raw, { expirationTtl: PENDING_TTL });
      await answer(env, callback, `Не удалось опубликовать: ${String(err.message).slice(0, 150)}`);
      return new Response('ok');
    }
    await closeCard(env, callback, `✅ Опубликовано — ${who}`);
  } else if (action === 'r') {
    await env.SUBMISSIONS.delete(key);
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
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram ${method}: ${data.description}`);
  return data.result;
}

// --- Публикация в GitHub ---

async function publishMaterial(env, material) {
  const path = `repos/${env.GITHUB_REPO}/contents/${env.MATERIALS_PATH}`;
  // Если между чтением и записью файл успел измениться, GitHub вернёт 409 — перечитываем и пробуем снова
  for (let attempt = 0; attempt < 3; attempt++) {
    const file = await github(env, 'GET', `${path}?ref=${encodeURIComponent(env.GITHUB_BRANCH)}`);
    const data = JSON.parse(fromBase64(file.content));
    data.materials ??= [];
    if (!data.materials.some((m) => m.id === material.id)) data.materials.push(material);

    // Без явного автора GitHub подставил бы основную почту владельца токена
    const identity = { name: env.COMMIT_NAME, email: env.COMMIT_EMAIL };
    const res = await githubRaw(env, 'PUT', path, {
      message: `Новая работа: ${material.subject} — ${material.work}`,
      content: toBase64(`${JSON.stringify(data, null, 2)}\n`),
      sha: file.sha,
      branch: env.GITHUB_BRANCH,
      author: identity,
      committer: identity,
    });
    if (res.status === 409) continue;
    if (!res.ok) throw new Error(`GitHub ${res.status}`);
    return;
  }
  throw new Error('GitHub: файл постоянно меняется, попробуй ещё раз');
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

function toBase64(text) {
  let binary = '';
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
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
