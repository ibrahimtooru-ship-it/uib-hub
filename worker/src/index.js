// UIB Hub — аккаунты и приём работ в базу знаний (Cloudflare Worker).
//
//   POST /auth/register  ← баркод + свой пароль UIB Hub + никнейм → токен сессии
//   POST /auth/login     ← баркод + пароль → токен сессии
//   GET  /auth/me        ← кто вошёл (по токену)
//   POST /auth/logout    ← завершить сессию
//   POST /auth/profile   ← выбрать аватарку
//   POST /auth/reset-request ← «Забыл пароль»: заявка модераторам, они выдают одноразовый код лично
//   POST /auth/reset     ← баркод + код от модератора + новый пароль
//   POST /orders         ← заявка маркетплейса «Ищу исполнителя» (после входа) → в чат модераторов
//   POST /courses/suggest ← новый курс или исправление (после входа) → модераторам, на сайт сам не попадает
//   POST /submit        ← форма «Добавить работу» (только после входа; multipart: payload + необязательный file):
//                          работа и файл уходят в очередь (KV) и модераторам в Telegram с кнопками ✅ / ❌
//   GET  /files/:id      ← скачать файл работы (только после входа)
//   POST /telegram       ← webhook бота: ✅ публикует работу в materials.json (файл остаётся закрытым в KV),
//                          ❌ удаляет заявку и файл
//
// Секреты (wrangler secret put): TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, GITHUB_TOKEN
// Переменные (wrangler.toml):    ALLOWED_ORIGIN, MODERATOR_CHAT_ID, GITHUB_REPO, GITHUB_BRANCH, MATERIALS_PATH,
//                                COMMIT_NAME, COMMIT_EMAIL
// KV namespace:                  SUBMISSIONS — заявки, файлы, аккаунты и сессии

const LIMITS = { subject: 120, work: 200, teacher: 80, tip: 1000, stackItems: 12, stackItem: 40, url: 500, programs: 3 };
const RATE_LIMIT_PER_HOUR = 5;
const PENDING_TTL = 60 * 60 * 24 * 30;   // необработанная заявка живёт 30 дней
const SESSION_TTL = 60 * 60 * 24 * 30;   // вход держится 30 дней
const LOGIN_FAILS_LIMIT = 10;            // неудачных входов на баркод за 15 минут
// Те же ограничения стоят на сайте (assets/js/submit.js, assets/js/auth.js)
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const FILE_TYPES = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  txt: 'text/plain; charset=utf-8',
  zip: 'application/zip',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
};
const BARCODE_RE = /^\d{5,10}$/;
const NICKNAME_RE = /^[\p{L}\p{N}_. -]{2,24}$/u;
const TELEGRAM_RE = /^@?[A-Za-z0-9_]{5,32}$/;
// Те же id и картинки в assets/js/auth.js и assets/avatars/
const AVATARS = ['it', 'marketing', 'finance', 'accounting', 'logistics', 'intl', 'management', 'law', 'journalism'];
const RESET_TTL = 60 * 60 * 24;          // код сброса пароля действует сутки
// Без похожих символов (0/O, 1/I/L), чтобы код легко продиктовать
const RESET_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
// Workers ограничивают PBKDF2 сотней тысяч итераций
const PBKDF2_ITERATIONS = 100000;

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    const route = `${request.method} ${pathname}`;
    try {
      if (request.method === 'OPTIONS') return withCors(env, new Response(null, { status: 204 }));
      if (request.method === 'POST' && pathname === '/telegram') return await handleTelegram(request, env);

      // Всё остальное вызывает только сайт
      if (env.ALLOWED_ORIGIN !== '*' && request.headers.get('Origin') !== env.ALLOWED_ORIGIN) {
        return withCors(env, json({ ok: false, error: 'forbidden' }, 403));
      }
      if (route === 'POST /auth/register') return withCors(env, await handleRegister(request, env));
      if (route === 'POST /auth/login') return withCors(env, await handleLogin(request, env));
      if (route === 'GET /auth/me') return withCors(env, await handleMe(request, env));
      if (route === 'POST /auth/logout') return withCors(env, await handleLogout(request, env));
      if (route === 'POST /auth/profile') return withCors(env, await handleProfile(request, env));
      if (route === 'POST /auth/reset-request') return withCors(env, await handleResetRequest(request, env));
      if (route === 'POST /auth/reset') return withCors(env, await handleReset(request, env));
      if (route === 'POST /orders') return withCors(env, await handleOrder(request, env));
      if (route === 'POST /courses/suggest') return withCors(env, await handleCourseSuggest(request, env));
      if (route === 'POST /submit') return withCors(env, await handleSubmit(request, env));
      if (request.method === 'GET' && pathname.startsWith('/files/')) return withCors(env, await handleDownload(request, env, pathname.slice(7)));
      return withCors(env, json({ ok: false, error: 'not_found' }, 404));
    } catch (err) {
      console.error(err);
      return withCors(env, json({ ok: false, error: 'internal' }, 500));
    }
  },
};

// --- Аккаунты ---

async function readJson(request) {
  try { return await request.json(); } catch { return null; }
}

async function handleRegister(request, env) {
  const body = await readJson(request);
  const barcode = String(body?.barcode ?? '').trim();
  const nickname = String(body?.nickname ?? '').trim().replace(/\s+/g, ' ');
  const password = String(body?.password ?? '');

  if (!BARCODE_RE.test(barcode)) return json({ ok: false, error: 'bad_barcode' }, 400);
  if (!NICKNAME_RE.test(nickname) || nickname.toLowerCase() === 'аноним') return json({ ok: false, error: 'bad_nickname' }, 400);
  if (password.length < 8 || password.length > 128) return json({ ok: false, error: 'bad_password' }, 400);

  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  if (!(await takeRateLimit(env, `reg:${ip}`))) return json({ ok: false, error: 'rate_limited' }, 429);
  if (await env.SUBMISSIONS.get(`user:${barcode}`)) return json({ ok: false, error: 'barcode_taken' }, 409);
  if (await env.SUBMISSIONS.get(`nick:${nickname.toLowerCase()}`)) return json({ ok: false, error: 'nickname_taken' }, 409);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const user = {
    barcode,
    nickname,
    salt: bytesToBase64(salt),
    hash: bytesToBase64(await hashPassword(password, salt)),
    created_at: new Date().toISOString(),
  };
  await env.SUBMISSIONS.put(`user:${barcode}`, JSON.stringify(user));
  await env.SUBMISSIONS.put(`nick:${nickname.toLowerCase()}`, barcode);
  return json({ ok: true, token: await createSession(env, user), user: publicUser(user) });
}

async function handleLogin(request, env) {
  const body = await readJson(request);
  const barcode = String(body?.barcode ?? '').trim();
  const password = String(body?.password ?? '');
  if (!BARCODE_RE.test(barcode) || !password) return json({ ok: false, error: 'bad_credentials' }, 401);

  // Защита от перебора: после 10 ошибок вход по этому баркоду закрыт на 15 минут
  const failKey = `fail:${barcode}`;
  const fails = Number(await env.SUBMISSIONS.get(failKey)) || 0;
  if (fails >= LOGIN_FAILS_LIMIT) return json({ ok: false, error: 'too_many_attempts' }, 429);

  const raw = await env.SUBMISSIONS.get(`user:${barcode}`);
  const user = raw && JSON.parse(raw);
  const ok = user && timingSafeEqual(await hashPassword(password, base64ToBytes(user.salt)), base64ToBytes(user.hash));
  if (!ok) {
    await env.SUBMISSIONS.put(failKey, String(fails + 1), { expirationTtl: 900 });
    return json({ ok: false, error: 'bad_credentials' }, 401);
  }
  await env.SUBMISSIONS.delete(failKey);
  return json({ ok: true, token: await createSession(env, user), user: publicUser(user) });
}

async function handleMe(request, env) {
  const user = await currentUser(request, env);
  return user ? json({ ok: true, user: publicUser(user) }) : json({ ok: false, error: 'auth_required' }, 401);
}

async function handleLogout(request, env) {
  const token = bearerToken(request);
  if (token) await env.SUBMISSIONS.delete(`session:${token}`);
  return json({ ok: true });
}

async function handleProfile(request, env) {
  const user = await currentUser(request, env);
  if (!user) return json({ ok: false, error: 'auth_required' }, 401);
  const body = await readJson(request);
  const avatar = body?.avatar ?? null;
  if (avatar !== null && !AVATARS.includes(avatar)) return json({ ok: false, error: 'bad_avatar' }, 400);
  const updated = { ...user, avatar };
  await env.SUBMISSIONS.put(`user:${user.barcode}`, JSON.stringify(updated));
  return json({ ok: true, user: publicUser(updated) });
}

// --- Восстановление пароля через модераторов ---
// Почты у аккаунтов нет, поэтому личность подтверждает человек: модератор сверяет студенческий
// и лично передаёт одноразовый код. Существует ли баркод, сайту не сообщаем — ответ всегда одинаковый.

async function handleResetRequest(request, env) {
  const body = await readJson(request);
  const barcode = String(body?.barcode ?? '').trim();
  const contact = String(body?.contact ?? '').trim().replace(/^@?/, '@');
  if (!BARCODE_RE.test(barcode)) return json({ ok: false, error: 'bad_barcode' }, 400);
  if (!TELEGRAM_RE.test(contact)) return json({ ok: false, error: 'bad_contact' }, 400);

  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  if (!(await takeRateLimit(env, `reset:${ip}`))) return json({ ok: false, error: 'rate_limited' }, 429);

  const raw = await env.SUBMISSIONS.get(`user:${barcode}`);
  if (raw && !(await env.SUBMISSIONS.get(`resetreq:${barcode}`))) {
    const user = JSON.parse(raw);
    await env.SUBMISSIONS.put(`resetreq:${barcode}`, contact, { expirationTtl: RESET_TTL });
    await telegram(env, 'sendMessage', {
      chat_id: env.MODERATOR_CHAT_ID,
      text: [
        '🔑 <b>Сброс пароля</b>',
        '',
        `<b>Аккаунт:</b> ${escapeHtml(user.nickname)} · баркод ${barcode}`,
        `<b>Написать:</b> ${escapeHtml(contact)}`,
        '',
        'Попроси фото студенческого с этим баркодом. Если всё сходится — нажми кнопку и передай код лично.',
      ].join('\n'),
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '🔑 Выдать код', callback_data: `k:${barcode}` }]] },
    });
  }
  return json({ ok: true });
}

async function issueResetCode(env, callback, barcode) {
  const contact = await env.SUBMISSIONS.get(`resetreq:${barcode}`);
  if (!contact) {
    await answer(env, callback, 'Заявка устарела или код уже выдан');
    return;
  }
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const code = [...bytes].map((b) => RESET_ALPHABET[b % RESET_ALPHABET.length]).join('');
  const pretty = `${code.slice(0, 4)}-${code.slice(4)}`;
  await env.SUBMISSIONS.put(`reset:${barcode}`, bytesToBase64(await sha256(code)), { expirationTtl: RESET_TTL });
  await env.SUBMISSIONS.delete(`resetreq:${barcode}`);
  const who = callback.from?.username ? `@${callback.from.username}` : (callback.from?.first_name ?? 'модератор');
  await closeCard(env, callback, `✅ Код выдал ${who}: ${pretty}\nПередай его лично ${contact}. Действует 24 часа, одноразовый.`);
}

async function handleReset(request, env) {
  const body = await readJson(request);
  const barcode = String(body?.barcode ?? '').trim();
  const code = String(body?.code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const password = String(body?.password ?? '');
  if (!BARCODE_RE.test(barcode) || code.length !== 8) return json({ ok: false, error: 'bad_code' }, 400);
  if (password.length < 8 || password.length > 128) return json({ ok: false, error: 'bad_password' }, 400);

  // Тот же счётчик, что у входа: перебирать коды так же бесполезно, как пароли
  const failKey = `fail:${barcode}`;
  const fails = Number(await env.SUBMISSIONS.get(failKey)) || 0;
  if (fails >= LOGIN_FAILS_LIMIT) return json({ ok: false, error: 'too_many_attempts' }, 429);

  const stored = await env.SUBMISSIONS.get(`reset:${barcode}`);
  const raw = await env.SUBMISSIONS.get(`user:${barcode}`);
  if (!stored || !raw || !timingSafeEqual(await sha256(code), base64ToBytes(stored))) {
    await env.SUBMISSIONS.put(failKey, String(fails + 1), { expirationTtl: 900 });
    return json({ ok: false, error: 'bad_code' }, 400);
  }

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const user = JSON.parse(raw);
  // Новая версия сессий: все старые входы (вдруг пароль украли) перестают действовать
  const updated = { ...user, salt: bytesToBase64(salt), hash: bytesToBase64(await hashPassword(password, salt)), session_version: (user.session_version ?? 0) + 1 };
  await env.SUBMISSIONS.put(`user:${barcode}`, JSON.stringify(updated));
  await env.SUBMISSIONS.delete(`reset:${barcode}`);
  await env.SUBMISSIONS.delete(failKey);
  return json({ ok: true, token: await createSession(env, updated), user: publicUser(updated) });
}

async function createSession(env, user) {
  const token = bytesToBase64(crypto.getRandomValues(new Uint8Array(32))).replace(/[+/=]/g, (ch) => ({ '+': '-', '/': '_', '=': '' }[ch]));
  await env.SUBMISSIONS.put(`session:${token}`, `${user.barcode}:${user.session_version ?? 0}`, { expirationTtl: SESSION_TTL });
  return token;
}

function bearerToken(request) {
  const header = request.headers.get('Authorization') ?? '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

async function currentUser(request, env) {
  const token = bearerToken(request);
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  const session = await env.SUBMISSIONS.get(`session:${token}`);
  if (!session) return null;
  // Сессии до появления сброса пароля хранили только баркод, без версии
  const [barcode, version = '0'] = session.split(':');
  const raw = await env.SUBMISSIONS.get(`user:${barcode}`);
  const user = raw && JSON.parse(raw);
  return user && String(user.session_version ?? 0) === version ? user : null;
}

// Баркод на сайт целиком не отдаём: он виден только модераторам
function publicUser(user) {
  return { nickname: user.nickname, barcode_hint: `•••${user.barcode.slice(-3)}`, avatar: user.avatar ?? null };
}

async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

async function hashPassword(password, salt) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERATIONS }, key, 256);
  return new Uint8Array(bits);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

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
  const user = await currentUser(request, env);
  if (!user) return json({ ok: false, error: 'auth_required' }, 401);

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

  if (!(await takeRateLimit(env, `submit:${user.barcode}`))) return json({ ok: false, error: 'rate_limited' }, 429);

  const { material, error } = cleanMaterial(body.data, user);
  if (error) return json({ ok: false, error }, 400);

  const pending = { material, attachment, account: { barcode: user.barcode, nickname: user.nickname } };
  if (attachment) {
    await env.SUBMISSIONS.put(`file:${material.id}`, await file.arrayBuffer(), { expirationTtl: PENDING_TTL });
  }
  await env.SUBMISSIONS.put(`pending:${material.id}`, JSON.stringify(pending), { expirationTtl: PENDING_TTL });

  const card = await telegram(env, 'sendMessage', {
    chat_id: env.MODERATOR_CHAT_ID,
    text: formatForModerators(material, attachment, user),
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

// --- Заявка маркетплейса ---
// Раньше сайт открывал чат с модератором в Telegram; из своего же аккаунта это «Избранное».
// Теперь заявка, как и работа, приходит карточкой в чат модераторов.

const ORDER_CATEGORIES = { homework: 'Помощь с ДЗ / лабой', notes: 'Конспект', presentation: 'Презентация', tutoring: 'Репетиторство', other: 'Другое' };

async function handleOrder(request, env) {
  const user = await currentUser(request, env);
  if (!user) return json({ ok: false, error: 'auth_required' }, 401);
  const body = await readJson(request);
  const str = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

  const subject = str(body?.subject, LIMITS.subject);
  const task = str(body?.task, LIMITS.tip);
  const contact = str(body?.contact, 33).replace(/^@?/, '@');
  if (!subject || !task) return json({ ok: false, error: 'subject_and_task_required' }, 400);
  if (!TELEGRAM_RE.test(contact)) return json({ ok: false, error: 'bad_contact' }, 400);
  if (!(await takeRateLimit(env, `order:${user.barcode}`))) return json({ ok: false, error: 'rate_limited' }, 429);

  const price = Math.max(0, Math.min(10_000_000, Math.round(Number(body?.price) || 0)));
  const deadline = new Date(body?.deadline_at);
  const line = (label, value) => (value ? `<b>${label}:</b> ${escapeHtml(value)}` : null);
  await telegram(env, 'sendMessage', {
    chat_id: env.MODERATOR_CHAT_ID,
    text: [
      '🛒 <b>Заявка маркетплейса</b>',
      '',
      line('Категория', ORDER_CATEGORIES[body?.category] ?? 'Другое'),
      line('Предмет', subject),
      line('Задача', task),
      // Время UIB (UTC+5) сдвигом вручную: в старых базах часовых поясов Asia/Almaty ещё UTC+6
      line('Дедлайн', Number.isNaN(deadline.getTime()) ? null : new Date(deadline.getTime() + 5 * 3600e3).toLocaleString('ru-RU', { timeZone: 'UTC', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })),
      line('Бюджет', price ? `${price.toLocaleString('ru-RU')} ₸` : 'не указан'),
      line('Комментарий', str(body?.comment, 500)),
      line('Написать', contact),
      line('Аккаунт', `${user.nickname} · баркод ${user.barcode}`),
    ].filter(Boolean).join('\n'),
    parse_mode: 'HTML',
  });
  return json({ ok: true });
}

// --- Предложение курса ---
// В data/courses.json — только факты из расписания. Модератор проверяет предложение
// (без фамилий, оценок и контактов преподавателей) и добавляет курс вручную.

async function handleCourseSuggest(request, env) {
  const user = await currentUser(request, env);
  if (!user) return json({ ok: false, error: 'auth_required' }, 401);
  const body = await readJson(request);
  const str = (value, max) => (typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, max) : '');

  const name = str(body?.name, 120);
  if (!name) return json({ ok: false, error: 'course_name_required' }, 400);
  if (!(await takeRateLimit(env, `course:${user.barcode}`))) return json({ ok: false, error: 'rate_limited' }, 429);

  const year = Number(body?.course_year);
  const credits = Number(body?.credits);
  const line = (label, value) => (value ? `<b>${label}:</b> ${escapeHtml(value)}` : null);
  await telegram(env, 'sendMessage', {
    chat_id: env.MODERATOR_CHAT_ID,
    text: [
      '📘 <b>Курс: предложение</b>',
      '',
      line('Название', name),
      line('Курс', [1, 2, 3, 4].includes(year) ? String(year) : null),
      line('Кредиты', credits > 0 && credits <= 30 ? String(credits) : null),
      line('Лекции', str(body?.lecturer, 80)),
      line('Семинары', str(body?.seminar, 80)),
      line('Комментарий', str(body?.comment, 300)),
      line('Аккаунт', `${user.nickname} · баркод ${user.barcode}`),
      '',
      'Если всё верно — добавь в data/courses.json: имя и отчество без фамилии, без оценок и контактов.',
    ].filter((l) => l !== null).join('\n'),
    parse_mode: 'HTML',
  });
  return json({ ok: true });
}

function describeFile(file) {
  const name = String(file.name || 'file').slice(-120);
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  if (!FILE_TYPES[ext]) return { error: 'file_type' };
  if (file.size > MAX_FILE_BYTES) return { error: 'file_too_big' };
  return { name, size: file.size, ext };
}

// KV не атомарный, так что лимит примерный — от массового спама его хватает
async function takeRateLimit(env, key) {
  const fullKey = `rl:${key}`;
  const count = Number(await env.SUBMISSIONS.get(fullKey)) || 0;
  if (count >= RATE_LIMIT_PER_HOUR) return false;
  await env.SUBMISSIONS.put(fullKey, String(count + 1), { expirationTtl: 3600 });
  return true;
}

// Данным с сайта не доверяем: собираем запись заново, только из известных полей. Автор — из аккаунта
function cleanMaterial(data, user) {
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
  const anonymous = data.author?.anonymous !== false;

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
      author: anonymous ? { display: 'Аноним', anonymous: true } : { display: user.nickname, anonymous: false, avatar: user.avatar ?? null },
      created_at: new Date().toISOString(),
    },
  };
}

function formatForModerators(m, attachment, user) {
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
    line('На сайте', m.author.display),
    // Баркод видят только модераторы: если работа окажется чужой, знаем, кто прислал
    line('Аккаунт', `${user.nickname} · баркод ${user.barcode}`),
  ].filter((l) => l !== null).join('\n');
}

// --- Скачивание файла ---

async function handleDownload(request, env, id) {
  const user = await currentUser(request, env);
  if (!user) return json({ ok: false, error: 'auth_required' }, 401);
  if (!/^mat-[a-z0-9-]{1,60}$/.test(id)) return json({ ok: false, error: 'not_found' }, 404);

  const { value, metadata } = await env.SUBMISSIONS.getWithMetadata(`stored:${id}`, 'arrayBuffer');
  if (!value) return json({ ok: false, error: 'not_found' }, 404);
  const name = metadata?.name ?? `${id}.${metadata?.ext ?? 'bin'}`;
  return new Response(value, {
    headers: {
      'Content-Type': FILE_TYPES[metadata?.ext] ?? 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${name.replace(/[^\x20-\x7e]|"/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      'Cache-Control': 'private, no-store',
    },
  });
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
  if (action === 'k') {
    await issueResetCode(env, callback, id);
    return new Response('ok');
  }
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
    const saved = JSON.parse(raw);
    // Заявки до появления файлов хранились как сама работа, без обёртки
    const pending = saved.material ? saved : { material: saved, attachment: null };
    try {
      if (pending.attachment) {
        // Файл переезжает из очереди в постоянное закрытое хранилище; в репозиторий он не попадает
        const bytes = await env.SUBMISSIONS.get(`file:${id}`, 'arrayBuffer');
        if (!bytes) throw new Error('файл заявки не найден');
        await env.SUBMISSIONS.put(`stored:${id}`, bytes, { metadata: { name: pending.attachment.name, ext: pending.attachment.ext } });
      }
      await publish(env, pending);
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
// Git Data API: один коммит с materials.json, значит одна сборка Pages на работу

async function publish(env, { material, attachment }) {
  const repo = `repos/${env.GITHUB_REPO}`;
  const branch = encodeURIComponent(env.GITHUB_BRANCH);
  const identity = { name: env.COMMIT_NAME, email: env.COMMIT_EMAIL };

  const entry = structuredClone(material);
  // Ссылки на файл в репозитории нет: сайт скачивает его через /files/:id после входа
  if (attachment) entry.links.unshift({ label: attachment.name, file: true, size: attachment.size });

  // Если ветка ушла вперёд между чтением и записью, GitHub вернёт 422 — перечитываем и пробуем снова
  for (let attempt = 0; attempt < 3; attempt++) {
    const head = await github(env, 'GET', `${repo}/git/ref/heads/${branch}`);
    const parent = await github(env, 'GET', `${repo}/git/commits/${head.object.sha}`);
    const current = await github(env, 'GET', `${repo}/contents/${env.MATERIALS_PATH}?ref=${head.object.sha}`);
    const data = JSON.parse(fromBase64(current.content));
    data.materials ??= [];
    if (!data.materials.some((m) => m.id === entry.id)) data.materials.push(entry);

    const blob = await github(env, 'POST', `${repo}/git/blobs`, { content: toBase64(`${JSON.stringify(data, null, 2)}\n`), encoding: 'base64' });
    const tree = await github(env, 'POST', `${repo}/git/trees`, {
      base_tree: parent.tree.sha,
      tree: [{ path: env.MATERIALS_PATH, mode: '100644', type: 'blob', sha: blob.sha }],
    });
    const commit = await github(env, 'POST', `${repo}/git/commits`, {
      message: `Новая работа: ${material.subject} — ${material.work}`,
      tree: tree.sha,
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

function bytesToBase64(bytes) {
  let binary = '';
  // Кусками: String.fromCharCode(...огромный массив) переполняет стек
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function base64ToBytes(base64) {
  return Uint8Array.from(atob(base64.replace(/\s/g, '')), (ch) => ch.charCodeAt(0));
}

function toBase64(text) {
  return bytesToBase64(new TextEncoder().encode(text));
}

function fromBase64(base64) {
  return new TextDecoder().decode(base64ToBytes(base64));
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
  headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  headers.set('Access-Control-Expose-Headers', 'Content-Disposition');
  headers.set('Access-Control-Max-Age', '86400');
  headers.set('Vary', 'Origin');
  return new Response(response.body, { status: response.status, headers });
}
