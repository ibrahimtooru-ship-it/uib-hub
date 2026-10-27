// Плашка «Сайт обновился»: сайт сам замечает новую версию (код, одобренные работы, дедлайны)
// и предлагает перезагрузиться. Особенно нужно на телефоне в режиме приложения — там нет кнопки браузера.
//
// Как замечаем: после загрузки запоминаем ETag всех своих файлов (страница, скрипты, данные),
// потом раз в 5 минут и при возвращении на вкладку сверяем их HEAD-запросами. Список файлов
// берём из того, что страница реально загрузила, так что поддерживать его вручную не нужно.
const CHECK_EVERY_MS = 5 * 60 * 1000;
const TRACKED = /\.(html|js|json|css|webmanifest)$|\/$/;

const el = {};
let urls = [];
let baseline = null;
let checking = false;

export function initUpdates() {
  el.banner = document.getElementById('update-banner');
  document.getElementById('update-dismiss').addEventListener('click', () => el.banner.classList.add('hidden'));
  document.addEventListener('click', (event) => {
    if (event.target.closest('[data-reload]')) location.reload();
  });

  // Данные грузятся асинхронно — снимаем «отпечаток», когда всё уже загружено
  addEventListener('load', () => setTimeout(takeBaseline, 3000));
  setInterval(checkForUpdate, CHECK_EVERY_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkForUpdate();
  });
}

async function takeBaseline() {
  const own = performance.getEntriesByType('resource')
    .map((entry) => new URL(entry.name))
    .filter((url) => url.origin === location.origin && TRACKED.test(url.pathname))
    .map((url) => url.origin + url.pathname);
  urls = [...new Set([location.origin + location.pathname, ...own])];
  baseline = await fingerprint();
}

async function fingerprint() {
  const tags = await Promise.all(urls.map(async (url) => {
    try {
      const res = await fetch(url, { method: 'HEAD', cache: 'no-store' });
      return res.ok ? (res.headers.get('ETag') ?? res.headers.get('Last-Modified') ?? '') : null;
    } catch {
      return null;
    }
  }));
  // Нет сети или файл временно недоступен — сравнивать не с чем
  return tags.includes(null) ? null : tags.join('|');
}

export async function checkForUpdate() {
  if (checking || document.visibilityState !== 'visible') return;
  checking = true;
  try {
    if (!baseline) {
      if (urls.length) baseline = await fingerprint();
      return;
    }
    const current = await fingerprint();
    if (current && current !== baseline) el.banner.classList.remove('hidden');
  } finally {
    checking = false;
  }
}
