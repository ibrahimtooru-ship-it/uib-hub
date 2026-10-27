// Ядро маркетплейса. Сейчас P2P без комиссии. Escrow включается сменой
// CONFIG.MARKETPLACE.paymentMode / serviceFeePercent и реализацией PAYMENT_ADAPTERS.escrow,
// а формы, карточки и расчёты остаются прежними.
import { api, requireLogin } from './auth.js';
import { CONFIG } from './config.js';
import { escapeHtml, formatDate, formatMoney, storage } from './utils.js';

const CONTACT_KEY = 'uibhub.telegram';
const TELEGRAM_RE = /^@?[A-Za-z0-9_]{5,32}$/;
// Коды ошибок Worker'а
const ORDER_ERRORS = {
  subject_and_task_required: 'Укажи предмет и что нужно сделать.',
  bad_contact: 'Telegram: ник латиницей, 5–32 символа, например @username.',
  rate_limited: 'Слишком много заявок подряд. Попробуй через час.',
  auth_required: 'Сессия закончилась. Войди заново и отправь ещё раз.',
};

const CATEGORY_LABELS = {
  homework: 'Помощь с ДЗ / лабой',
  notes: 'Конспект',
  presentation: 'Презентация',
  tutoring: 'Репетиторство',
  other: 'Другое',
};

export function calcAmounts(price, feePercent = CONFIG.MARKETPLACE.serviceFeePercent) {
  const base = Math.max(0, Math.round(Number(price) || 0));
  const fee = Math.round((base * feePercent) / 100);
  return { price: base, service_fee_percent: feePercent, service_fee_amount: fee, total_amount: base + fee };
}

export function createOrder({ listingId = null, category = 'homework', subject, task, deadlineAt = null, price, comment = '' }) {
  return {
    id: `ord-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    listing_id: listingId,
    category,
    subject,
    task,
    deadline_at: deadlineAt,
    comment,
    currency: CONFIG.MARKETPLACE.currency,
    ...calcAmounts(price),
    payment_mode: CONFIG.MARKETPLACE.paymentMode,
    status: 'draft',
    created_at: new Date().toISOString(),
  };
}

export function orderBrief(order) {
  const lines = [
    '📝 Заявка UIB Hub',
    `Категория: ${CATEGORY_LABELS[order.category] ?? order.category}`,
    `Предмет: ${order.subject}`,
    `Задача: ${order.task}`,
    order.deadline_at && `Дедлайн: ${formatDate(new Date(order.deadline_at))}`,
    `Бюджет: ${formatMoney(order.total_amount, order.currency)}`,
    order.comment && `Комментарий: ${order.comment}`,
    `ID: ${order.id}`,
  ];
  return lines.filter(Boolean).join('\n');
}

const PAYMENT_ADAPTERS = {
  // Telegram откроет чат с уже набранным текстом ТЗ
  p2p: {
    contactUrl: (order, username) => `https://t.me/${username}?text=${encodeURIComponent(orderBrief(order))}`,
  },
  // escrow: {
  //   contactUrl: (order) => `https://t.me/${CONFIG.TELEGRAM.botUsername}?start=${order.id}`,
  //   // бот находит заказ по id, выставляет счёт на total_amount и держит деньги до подтверждения
  // },
};

export function orderContactUrl(order, username = CONFIG.TELEGRAM.ordersUsername) {
  const adapter = PAYMENT_ADAPTERS[order.payment_mode];
  if (!adapter) throw new Error(`Нет платёжного адаптера для режима "${order.payment_mode}"`);
  return adapter.contactUrl(order, username);
}

// --- Форма заявки (этап 3 расширит её до ленты объявлений) ---

let form;
let summary;
let status;

export function initMarketplace() {
  form = document.getElementById('order-form');
  summary = document.getElementById('order-summary');
  status = document.getElementById('order-status');
  form.elements.contact.value = storage.get(CONTACT_KEY, '');
  form.addEventListener('input', renderSummary);
  form.addEventListener('submit', onSubmit);
  renderSummary();
}

function setStatus(text, ok = false) {
  status.textContent = text;
  status.classList.toggle('text-emerald-700', ok);
  status.classList.toggle('text-red-600', !ok);
}

async function onSubmit(event) {
  event.preventDefault();
  const fields = readForm();
  const order = createOrder(fields);

  // Без Worker'а — старый путь: чат с модератором в Telegram
  if (!CONFIG.API_BASE) {
    window.open(orderContactUrl(order), '_blank', 'noopener');
    return;
  }

  if (!fields.subject || !fields.task) return setStatus(ORDER_ERRORS.subject_and_task_required);
  if (!TELEGRAM_RE.test(fields.contact)) return setStatus(ORDER_ERRORS.bad_contact);
  if (!(await requireLogin('Чтобы отправить заявку, войди в аккаунт.'))) return;

  const button = form.querySelector('[type="submit"]');
  button.disabled = true;
  setStatus('');
  try {
    const res = await api('/orders', {
      method: 'POST',
      json: { category: order.category, subject: order.subject, task: order.task, deadline_at: order.deadline_at, price: order.price, comment: order.comment, contact: fields.contact },
    });
    if (res.ok) {
      storage.set(CONTACT_KEY, fields.contact);
      form.reset();
      form.elements.contact.value = fields.contact;
      renderSummary();
      setStatus('Готово! Заявка у модераторов, они напишут тебе в Telegram.', true);
    } else {
      const { error } = await res.json().catch(() => ({}));
      setStatus(ORDER_ERRORS[error] ?? 'Не получилось отправить. Попробуй ещё раз чуть позже.');
    }
  } catch (err) {
    console.error(err);
    setStatus('Нет связи с сервером. Проверь интернет и попробуй ещё раз.');
  } finally {
    button.disabled = false;
  }
}

// Префилл из кнопки «🔥 Не успеваешь?» на дашборде
export function prefillOrder(params) {
  if (!form || !params.has('task')) return;
  form.elements.subject.value = params.get('subject') ?? '';
  form.elements.task.value = params.get('task') ?? '';
  const deadline = new Date(params.get('deadline'));
  if (!Number.isNaN(deadline.getTime())) form.elements.deadline.value = toLocalInputValue(deadline);
  renderSummary();
}

function readForm() {
  const f = form.elements;
  const deadline = f.deadline.value ? new Date(f.deadline.value) : null;
  return {
    category: f.category.value,
    subject: f.subject.value.trim(),
    task: f.task.value.trim(),
    deadlineAt: deadline && !Number.isNaN(deadline.getTime()) ? deadline.toISOString() : null,
    price: f.price.value,
    comment: f.comment.value.trim(),
    contact: f.contact.value.trim(),
  };
}

function renderSummary() {
  const amounts = calcAmounts(form.elements.price.value);
  const currency = CONFIG.MARKETPLACE.currency;
  summary.innerHTML = `
    <div class="flex justify-between text-slate-500"><span>Цена исполнителя</span><span>${formatMoney(amounts.price, currency)}</span></div>
    <div class="mt-1 flex justify-between text-slate-500"><span>Сервисный сбор (${escapeHtml(amounts.service_fee_percent)}%)</span><span>${formatMoney(amounts.service_fee_amount, currency)}</span></div>
    <div class="mt-2 flex justify-between border-t border-slate-200 pt-2 font-bold text-slate-900"><span>Итого</span><span>${formatMoney(amounts.total_amount, currency)}</span></div>`;
}

function toLocalInputValue(date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}
