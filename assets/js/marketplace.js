// Ядро маркетплейса. Сейчас P2P без комиссии. Escrow включается сменой
// CONFIG.MARKETPLACE.paymentMode / serviceFeePercent и реализацией PAYMENT_ADAPTERS.escrow,
// а формы, карточки и расчёты остаются прежними.
import { CONFIG } from './config.js';
import { escapeHtml, formatDate, formatMoney } from './utils.js';

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

export function initMarketplace() {
  form = document.getElementById('order-form');
  summary = document.getElementById('order-summary');
  form.addEventListener('input', renderSummary);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const order = createOrder(readForm());
    window.open(orderContactUrl(order), '_blank', 'noopener');
  });
  renderSummary();
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
