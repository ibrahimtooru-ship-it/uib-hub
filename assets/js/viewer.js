// Просмотр файла работы прямо на сайте, вместо страницы загрузки Safari:
// • фото — сразу картинкой;
// • PDF — в окне на компьютере, на телефоне — кнопкой «Открыть» во встроенном просмотрщике;
// • текст — первые строки прямо в окне;
// • Word, Excel, PowerPoint, ZIP — браузер их не показывает, а онлайн-просмотрщикам Microsoft и Google
//   нужна публичная ссылка (наши файлы закрыты). На телефоне — меню «Поделиться»: открыть в Word/Excel
//   или сохранить в «Файлы»; на компьютере — скачать.
import { emoji } from './emoji.js';
import { escapeHtml } from './utils.js';

const KINDS = {
  png: 'image', jpg: 'image', jpeg: 'image',
  pdf: 'pdf',
  txt: 'text',
  doc: 'word', docx: 'word',
  xls: 'excel', xlsx: 'excel',
  ppt: 'slides', pptx: 'slides',
  zip: 'zip',
};
const LABELS = { word: 'Документ Word', excel: 'Таблица Excel', slides: 'Презентация PowerPoint', zip: 'Архив ZIP', pdf: 'PDF', text: 'Текст', image: 'Фото' };
const ICONS = { word: 'memo', excel: 'bar_chart', slides: 'chart_up', zip: 'package', pdf: 'scroll', text: 'notepad', image: 'palette' };
const TEXT_PREVIEW_BYTES = 20_000;

// Телефон и планшет: тут есть системное «Поделиться», а PDF в iframe показывается плохо
const isTouch = () => matchMedia('(pointer: coarse)').matches;

const el = {};
let objectUrl = null;

export function initViewer() {
  for (const id of ['dialog', 'title', 'meta', 'body', 'actions']) el[id] = document.getElementById(`viewer-${id}`);
  el.dialog.addEventListener('click', (event) => {
    if (event.target === el.dialog || event.target.closest('[data-close]')) el.dialog.close();
  });
  // Ссылку на файл в памяти освобождаем, когда окно закрыто. Событие приходит с задержкой:
  // если за это время уже открыли другой файл, его не трогаем
  el.dialog.addEventListener('close', () => {
    if (el.dialog.open) return;
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = null;
    el.body.innerHTML = '';
  });
}

export async function openFile(blob, name) {
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  const kind = KINDS[ext] ?? 'other';
  const file = new File([blob], name, { type: blob.type });
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(file);

  el.title.textContent = name;
  el.meta.textContent = `${LABELS[kind] ?? 'Файл'} · ${formatSize(file.size)}`;
  const canShare = Boolean(isTouch() && navigator.canShare?.({ files: [file] }));
  el.body.innerHTML = await preview(kind, file, canShare);
  el.actions.innerHTML = '';
  for (const action of actions(kind, file, canShare)) el.actions.append(action);
  el.dialog.showModal();
}

async function preview(kind, file, canShare) {
  if (kind === 'image') {
    return `<img src="${objectUrl}" alt="${escapeHtml(file.name)}" class="mx-auto max-h-[60dvh] w-auto max-w-full rounded-xl object-contain">`;
  }
  if (kind === 'pdf' && !isTouch()) {
    return `<iframe src="${objectUrl}" title="${escapeHtml(file.name)}" class="h-[65dvh] w-full rounded-xl ring-1 ring-slate-200"></iframe>`;
  }
  if (kind === 'text') {
    const text = await file.slice(0, TEXT_PREVIEW_BYTES).text();
    const cut = file.size > TEXT_PREVIEW_BYTES ? '\n…' : '';
    return `<pre class="max-h-[55dvh] overflow-auto whitespace-pre-wrap rounded-xl bg-slate-50 p-4 text-sm text-slate-700 ring-1 ring-slate-100">${escapeHtml(text + cut)}</pre>`;
  }
  const hint = kind === 'pdf'
    ? 'Нажми «Открыть», чтобы листать PDF.'
    : (canShare ? 'Браузер не показывает такие файлы. Открой его в приложении: Word, Excel, «Файлы» или Telegram.' : 'Браузер не показывает такие файлы. Скачай и открой в программе.');
  return `
    <div class="flex flex-col items-center px-4 py-8 text-center">
      <span class="grid h-24 w-24 place-items-center rounded-3xl bg-slate-50 ring-1 ring-slate-100">${emoji(ICONS[kind] ?? 'paperclip', 56)}</span>
      <p class="mt-4 max-w-xs text-sm text-slate-500">${hint}</p>
    </div>`;
}

function actions(kind, file, canShare) {
  const buttons = [];

  if (kind === 'pdf' && isTouch()) {
    buttons.push(button('Открыть', 'btn-primary', () => window.open(objectUrl, '_blank')));
  }
  if (canShare) {
    // На iPhone и Android это системное меню: «Сохранить в Файлы», «Открыть в Word», отправить в Telegram
    const label = kind === 'image' ? 'Сохранить или отправить' : 'Открыть в приложении';
    buttons.push(button(label, buttons.length ? 'btn-secondary' : 'btn-primary', () => share(file)));
  } else {
    buttons.push(button('Скачать', buttons.length ? 'btn-secondary' : 'btn-primary', download));
  }
  return buttons;
}

async function share(file) {
  try {
    await navigator.share({ files: [file], title: file.name });
  } catch (err) {
    // Отмена в меню «Поделиться» — не ошибка; если поделиться нельзя, просто скачиваем
    if (err.name !== 'AbortError') download();
  }
}

function download() {
  const a = Object.assign(document.createElement('a'), { href: objectUrl, download: el.title.textContent });
  document.body.append(a);
  a.click();
  a.remove();
}

function button(text, style, onClick) {
  const node = Object.assign(document.createElement('button'), { type: 'button', className: `${style} flex-1 sm:flex-none`, textContent: text });
  node.addEventListener('click', onClick);
  return node;
}

function formatSize(bytes) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} МБ` : `${Math.max(1, Math.round(bytes / 1024))} КБ`;
}
