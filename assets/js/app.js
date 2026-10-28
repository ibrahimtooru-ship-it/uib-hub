import { initAuth } from './auth.js';
import { initCourses } from './courses.js';
import { initDeadlines } from './deadlines.js';
import { hydrateEmoji } from './emoji.js';
import { initGuide } from './guide.js';
import { initMaterials } from './materials.js';
import { initMarketplace, prefillOrder } from './marketplace.js';
import { initSubmit } from './submit.js';
import { initUpdates } from './update.js';
import { initViewer } from './viewer.js';
import { initWelcome } from './welcome.js';

const ROUTES = ['knowledge', 'guide', 'deadlines', 'teachers', 'marketplace', 'utils', 'memes'];
const DEFAULT_ROUTE = 'knowledge';

const sidebar = document.getElementById('sidebar');
const overlay = document.getElementById('sidebar-overlay');
const openButton = document.getElementById('sidebar-open');

// Хэш-роутинг работает на GitHub Pages без настройки 404.html: #/route?query
function parseHash() {
  const [path, query = ''] = location.hash.replace(/^#\/?/, '').split('?');
  return { route: ROUTES.includes(path) ? path : DEFAULT_ROUTE, params: new URLSearchParams(query) };
}

function navigate() {
  const { route, params } = parseHash();
  document.querySelectorAll('[data-page]').forEach((page) => { page.hidden = page.dataset.page !== route; });
  document.querySelectorAll('[data-route]').forEach((link) => {
    const active = link.dataset.route === route;
    link.classList.toggle('is-active', active);
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  if (route === 'marketplace') prefillOrder(params);
  setSidebarOpen(false);
  window.scrollTo(0, 0);
}

// На мобильных сайдбар выезжает поверх контента
function setSidebarOpen(open) {
  sidebar.classList.toggle('-translate-x-full', !open);
  overlay.classList.toggle('hidden', !open);
  openButton.setAttribute('aria-expanded', open);
}

openButton.addEventListener('click', () => setSidebarOpen(true));
overlay.addEventListener('click', () => setSidebarOpen(false));
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') setSidebarOpen(false); });

// Якоря внутри страницы: хэш занят роутером, поэтому скроллим вручную
document.addEventListener('click', (event) => {
  const link = event.target.closest('[data-anchor]');
  if (!link) return;
  event.preventDefault();
  const target = document.getElementById(link.dataset.anchor);
  if (!target) return;
  if (target.tagName === 'DETAILS') target.open = true;
  target.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

hydrateEmoji();
initAuth();
initViewer();
initUpdates();
initWelcome();
initMarketplace();
initSubmit();
window.addEventListener('hashchange', navigate);
navigate();
initMaterials();
initCourses();
initGuide();
initDeadlines();
