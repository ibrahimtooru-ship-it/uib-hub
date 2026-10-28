// 3D-эмодзи Microsoft Fluent (MIT). Если картинка не загрузилась, остаётся обычный символ из alt.
const BASE = 'https://cdn.jsdelivr.net/gh/microsoft/fluentui-emoji@main/assets/';

export const EMOJI = {
  books: ['Books', '📚'],
  search: ['Magnifying glass tilted left', '🔍'],
  alarm: ['Alarm clock', '⏰'],
  calendar: ['Spiral calendar', '🗓️'],
  shopping: ['Shopping bags', '🛍️'],
  open_book: ['Open book', '📖'],
  tools: ['Hammer and wrench', '🛠️'],
  shush: ['Shushing face', '🤫'],
  skull: ['Skull', '💀'],
  sparkles: ['Sparkles', '✨'],
  rocket: ['Rocket', '🚀'],
  trophy: ['Trophy', '🏆'],
  bulb: ['Light bulb', '💡'],
  cap: ['Graduation cap', '🎓'],
  memo: ['Memo', '📝'],
  paperclip: ['Paperclip', '📎'],
  disguise: ['Disguised face', '🥸'],
  bust: ['Bust in silhouette', '👤'],
  police_light: ['Police car light', '🚨'],
  fire: ['Fire', '🔥'],
  seedling: ['Seedling', '🌱'],
  party: ['Party popper', '🎉'],
  laptop: ['Laptop', '💻'],
  money_bag: ['Money bag', '💰'],
  megaphone: ['Megaphone', '📣'],
  briefcase: ['Briefcase', '💼'],
  abacus: ['Abacus', '🧮'],
  snake: ['Snake', '🐍'],
  satellite: ['Satellite antenna', '📡'],
  palette: ['Artist palette', '🎨'],
  bar_chart: ['Bar chart', '📊'],
  globe: ['Globe with meridians', '🌐'],
  scales: ['Balance scale', '⚖️'],
  gem: ['Gem stone', '💎'],
  inbox: ['Inbox tray', '📥'],
  plane: ['Airplane', '✈️'],
  newspaper: ['Newspaper', '📰'],
  brain: ['Brain', '🧠'],
  busts: ['Busts in silhouette', '👥'],
  classical: ['Classical building', '🏛️'],
  office: ['Office building', '🏢'],
  chart_up: ['Chart increasing', '📈'],
  arts: ['Performing arts', '🎭'],
  package: ['Package', '📦'],
  truck: ['Delivery truck', '🚚'],
  bank: ['Bank', '🏦'],
  phone: ['Mobile phone', '📱'],
  backpack: ['Backpack', '🎒'],
  compass: ['Compass', '🧭'],
  open_book: ['Open book', '📖'],
  question: ['Red question mark', '❓'],
  school: ['School', '🏫'],
  hundred: ['Hundred points', '💯'],
  scroll: ['Scroll', '📜'],
  clipboard: ['Clipboard', '📋'],
  notepad: ['Spiral notepad', '🗒️'],
  repeat: ['Repeat button', '🔁'],
  stopwatch: ['Stopwatch', '⏱️'],
  speech: ['Speech balloon', '💬'],
  envelope: ['Envelope', '✉️'],
  puzzle: ['Puzzle piece', '🧩'],
  locked: ['Locked', '🔒'],
  key: ['Key', '🔑'],
  check: ['Check mark button', '✅'],
  robot: ['Robot', '🤖'],
  gear: ['Gear', '⚙️'],
  floppy: ['Floppy disk', '💾'],
  hotel: ['Hotel', '🏨'],
  hospital: ['Hospital', '🏥'],
  phone_call: ['Telephone receiver', '📞'],
  bell: ['Bell', '🔔'],
  wifi: ['Wireless', '🛜'],
  food: ['Fork and knife with plate', '🍽️'],
  coffee: ['Hot beverage', '☕'],
  luggage: ['Luggage', '🧳'],
  bellhop: ['Bellhop bell', '🛎️'],
  tree: ['Deciduous tree', '🌳'],
};

export function emoji(name, size = 24, className = '') {
  const [folder, char] = EMOJI[name] ?? EMOJI.books;
  const file = `${folder}/3D/${folder.toLowerCase().replaceAll(' ', '_')}_3d.png`;
  // Явный размер в style: preflight Tailwind ставит img { height: auto }, и во flex-строке картинка растягивается
  return `<img src="${BASE}${encodeURI(file)}" alt="${char}" width="${size}" height="${size}" style="width:${size}px;height:${size}px" loading="lazy" decoding="async" draggable="false" class="inline-block flex-none select-none object-contain ${className}" onerror="this.replaceWith(this.alt)">`;
}

// Статичная разметка: <span data-emoji="books" data-size="22"></span>
export function hydrateEmoji(root = document) {
  root.querySelectorAll('[data-emoji]').forEach((node) => {
    node.innerHTML = emoji(node.dataset.emoji, Number(node.dataset.size) || 24);
    node.removeAttribute('data-emoji');
  });
}

// Порядок важен: побеждает первое совпадение
const SUBJECT_EMOJI = [
  [/журналист|медиа|сми/i, 'newspaper'],
  [/реклам|pr\b|коммуникац/i, 'megaphone'],
  [/психолог|личност/i, 'brain'],
  [/право|юрид|юрис/i, 'scales'],
  [/логист|цепоч|склад/i, 'package'],
  [/учёт|учет|аудит|acca|бухг/i, 'abacus'],
  [/финанс|банк|инвест|рынк/i, 'money_bag'],
  [/маркет/i, 'bar_chart'],
  [/эконом/i, 'chart_up'],
  [/искусств|арт|культур/i, 'arts'],
  [/международ|дипломат|геополит/i, 'globe'],
  [/менедж|управл|бизнес/i, 'briefcase'],
  [/аналит|статист|данн/i, 'bar_chart'],
  [/интеллект|machine|нейрон|\bai\b|\bии\b/i, 'robot'],
  [/облач|aws|cloud|big data|баз[аы] данных/i, 'floppy'],
  [/python|java|программ|информ|алгоритм/i, 'laptop'],
  [/англ|язык|english/i, 'speech'],
];

export function subjectEmoji(subject = '') {
  return SUBJECT_EMOJI.find(([pattern]) => pattern.test(subject))?.[1] ?? 'books';
}
