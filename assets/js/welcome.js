// Короткий гайд «Что тут есть» при входе на сайт.
// «Понятно» — закрыть до следующего визита, «Больше не показывать» — насовсем. Открыть снова — пункт меню.
import { storage } from './utils.js';

const HIDE_KEY = 'uibhub.welcome.hidden';
const SEEN_THIS_VISIT = 'uibhub.welcome.seen';

let dialog;

export function initWelcome() {
  dialog = document.getElementById('welcome-dialog');
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog || event.target.closest('[data-close]')) dialog.close();
    if (event.target.closest('[data-welcome-never]')) {
      storage.set(HIDE_KEY, true);
      dialog.close();
    }
  });
  dialog.addEventListener('close', () => {
    try { sessionStorage.setItem(SEEN_THIS_VISIT, '1'); } catch { /* приватный режим — покажем в следующий раз */ }
  });
  document.addEventListener('click', (event) => {
    if (event.target.closest('[data-open-welcome]')) dialog.showModal();
  });

  if (storage.get(HIDE_KEY, false) || seenThisVisit()) return;
  // Не перебиваем окно, которое уже открыто (например, переход по ссылке на форму)
  setTimeout(() => {
    if (!document.querySelector('dialog[open]')) dialog.showModal();
  }, 600);
}

function seenThisVisit() {
  try { return sessionStorage.getItem(SEEN_THIS_VISIT) === '1'; } catch { return false; }
}
