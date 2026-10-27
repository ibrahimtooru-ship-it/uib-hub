const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

// Ссылки приходят из пользовательского контента: пропускаем только http(s)
export function safeUrl(url) {
  try {
    const parsed = new URL(url, location.href);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : '#';
  } catch {
    return '#';
  }
}

export async function fetchJson(path) {
  const res = await fetch(path, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

// localStorage может быть недоступен (приватный режим, запрет cookies)
export const storage = {
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* не критично */ }
  },
  remove(key) {
    try { localStorage.removeItem(key); } catch { /* не критично */ }
  },
};

const dateFormatter = new Intl.DateTimeFormat('ru-RU', {
  weekday: 'short', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
});

export function formatDate(date) {
  return dateFormatter.format(date);
}

const relativeFormatter = new Intl.RelativeTimeFormat('ru', { numeric: 'auto' });

export function formatRelative(date, now = Date.now()) {
  const days = Math.round((date - now) / 864e5);
  if (Math.abs(days) < 30) return relativeFormatter.format(days, 'day');
  const months = Math.round(days / 30);
  if (Math.abs(months) < 12) return relativeFormatter.format(months, 'month');
  return relativeFormatter.format(Math.round(days / 365), 'year');
}

export function formatTimeLeft(ms) {
  if (ms <= 0) return 'просрочено';
  const totalMinutes = Math.floor(ms / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days} д ${hours} ч`;
  if (hours > 0) return `${hours} ч ${minutes} мин`;
  return `${minutes} мин`;
}

export function formatMoney(amount, currency = 'KZT') {
  return new Intl.NumberFormat('ru-RU', { style: 'currency', currency, currencyDisplay: 'narrowSymbol', maximumFractionDigits: 0 }).format(amount);
}
