import { CONFIG } from './config.js';
import { emoji } from './emoji.js';
import { escapeHtml, fetchJson, safeUrl, storage } from './utils.js';

const CHECKLIST_KEY = 'uibhub.guide.checklist';

const el = {};
let glossary = [];

export async function initGuide() {
  for (const id of ['checklist', 'progress', 'topics', 'grades', 'glossary', 'glossary-search', 'note']) {
    el[id] = document.getElementById(`guide-${id}`);
  }

  let data;
  try {
    data = await fetchJson(`${CONFIG.DATA_PATH}guide.json`);
  } catch (err) {
    console.error(err);
    el.topics.innerHTML = '<p class="text-sm font-semibold text-red-600">Не удалось загрузить памятку.</p>';
    return;
  }

  el.note.textContent = data.note ?? '';
  renderChecklist(data.checklist ?? []);
  el.topics.innerHTML = (data.sections ?? []).map(topicCard).join('');
  el.grades.innerHTML = (data.grade_scale ?? []).map(gradeRow).join('');

  glossary = data.glossary ?? [];
  el['glossary-search'].addEventListener('input', renderGlossary);
  renderGlossary();
}

// Отметки чеклиста личные, поэтому живут в localStorage
function renderChecklist(items) {
  const done = new Set(storage.get(CHECKLIST_KEY, []));
  const updateProgress = () => {
    const count = items.filter((item) => done.has(item.id)).length;
    el.progress.textContent = `${count} из ${items.length}`;
  };

  el.checklist.innerHTML = items.map((item) => `
    <label class="flex cursor-pointer items-start gap-3 rounded-xl p-2.5 transition hover:bg-white/60">
      <input type="checkbox" data-id="${escapeHtml(item.id)}" ${done.has(item.id) ? 'checked' : ''}
        class="peer mt-0.5 h-5 w-5 shrink-0 cursor-pointer rounded-md border-amber-300 accent-brand-600">
      <span class="text-sm font-semibold text-slate-700 peer-checked:text-slate-400 peer-checked:line-through">${escapeHtml(item.text)}</span>
    </label>`).join('');

  el.checklist.addEventListener('change', (event) => {
    const id = event.target.dataset.id;
    if (!id) return;
    if (event.target.checked) done.add(id);
    else done.delete(id);
    storage.set(CHECKLIST_KEY, [...done]);
    updateProgress();
  });
  updateProgress();
}

function topicCard(s) {
  return `
    <details id="guide-${escapeHtml(s.id)}" class="card group p-5 open:shadow-lg open:shadow-slate-200/70" ${s.id === 'syllabus' ? 'open' : ''}>
      <summary class="flex cursor-pointer list-none items-start gap-4 [&::-webkit-details-marker]:hidden">
        <span class="grid h-14 w-14 shrink-0 place-items-center rounded-2xl bg-slate-50 ring-1 ring-slate-100">${emoji(s.emoji, 36)}</span>
        <span class="min-w-0 flex-1">
          <span class="block font-display text-base font-semibold text-slate-900">${escapeHtml(s.title)}</span>
          <span class="mt-1 block text-sm leading-relaxed text-slate-500">${escapeHtml(s.lead)}</span>
        </span>
        <svg class="mt-1 h-5 w-5 shrink-0 text-slate-400 transition group-open:rotate-180" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m6 9 6 6 6-6"/></svg>
      </summary>
      <div class="sm:pl-[72px]">
        ${s.points?.length ? `
          <ul class="mt-4 space-y-2 text-sm leading-relaxed text-slate-700">
            ${s.points.map((p) => `<li class="relative pl-4 before:absolute before:left-0 before:top-[0.6em] before:h-1.5 before:w-1.5 before:rounded-full before:bg-brand-400">${escapeHtml(p)}</li>`).join('')}
          </ul>` : ''}
        ${s.table ? topicTable(s.table) : ''}
        ${s.tip ? `
          <div class="mt-4 flex gap-2.5 rounded-xl bg-brand-50 p-3 text-sm leading-relaxed text-brand-700 ring-1 ring-brand-100">
            ${emoji('bulb', 20, 'mt-0.5 shrink-0')}<p>${escapeHtml(s.tip)}</p>
          </div>` : ''}
        ${s.links?.length ? `
          <div class="mt-4 flex flex-wrap gap-2">
            ${s.links.map((l) => `<a href="${escapeHtml(safeUrl(l.url))}" target="_blank" rel="noopener" class="inline-flex items-center gap-1 rounded-lg bg-slate-100 px-2.5 py-1.5 text-xs font-bold text-slate-700 transition hover:bg-slate-200">${escapeHtml(l.label)} ↗</a>`).join('')}
          </div>` : ''}
      </div>
    </details>`;
}

function topicTable({ head = [], rows = [] }) {
  return `
    <div class="mt-4 overflow-x-auto rounded-xl ring-1 ring-slate-100">
      <table class="w-full text-left text-sm">
        <thead class="bg-slate-50 text-xs font-bold uppercase tracking-wider text-slate-400">
          <tr>${head.map((h) => `<th class="px-3 py-2">${escapeHtml(h)}</th>`).join('')}</tr>
        </thead>
        <tbody>
          ${rows.map((row) => `
            <tr class="border-t border-slate-100">
              ${row.map((cell, i) => `<td class="px-3 py-2 ${i === 0 ? 'font-semibold text-slate-800' : 'whitespace-nowrap text-slate-600'}">${escapeHtml(cell)}</td>`).join('')}
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

const GRADE_COLORS = { A: 'bg-emerald-100 text-emerald-700', B: 'bg-brand-100 text-brand-700', C: 'bg-amber-100 text-amber-800', D: 'bg-orange-100 text-orange-700', F: 'bg-red-100 text-red-700' };

function gradeRow(g) {
  const color = GRADE_COLORS[g.letter[0]] ?? 'bg-slate-100 text-slate-600';
  return `
    <tr class="border-t border-slate-100">
      <td class="py-2.5 pr-3"><span class="inline-grid h-8 w-10 place-items-center rounded-lg text-sm font-extrabold ${color}">${escapeHtml(g.letter)}</span></td>
      <td class="whitespace-nowrap py-2.5 pr-3 font-semibold text-slate-800">${escapeHtml(g.from)}–${escapeHtml(g.to)}</td>
      <td class="py-2.5 pr-3 font-mono text-slate-600">${Number(g.points).toFixed(2)}</td>
      <td class="py-2.5 text-slate-500">${escapeHtml(g.meaning)}</td>
    </tr>`;
}

function renderGlossary() {
  const query = el['glossary-search'].value.trim().toLowerCase();
  const items = glossary.filter((g) => !query || `${g.term} ${g.definition}`.toLowerCase().includes(query));
  el.glossary.innerHTML = items.length
    ? items.map((g) => `
        <div class="rounded-xl bg-slate-50 p-3">
          <dt class="text-sm font-bold text-slate-900">${escapeHtml(g.term)}</dt>
          <dd class="mt-0.5 text-sm text-slate-500">${escapeHtml(g.definition)}</dd>
        </div>`).join('')
    : '<p class="text-sm text-slate-400">Такого термина пока нет.</p>';
}
