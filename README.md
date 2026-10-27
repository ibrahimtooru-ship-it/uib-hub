# UIB Hub

Бесплатный студенческий хаб для студентов UIB. Статический сайт на GitHub Pages:
Vanilla JS (ES-модули) + Tailwind CDN, данные лежат в `data/*.json`, контент приходит через Telegram-бота с модерацией.

## Запуск локально

ES-модули и `fetch()` не работают по `file://`, поэтому нужен любой статический сервер:

```bash
python -m http.server 8080
```

Затем откройте http://localhost:8080.

## Структура репозитория

```
uib-hub/
├── index.html                 # SPA-оболочка, хэш-роутинг (#/dashboard, #/materials, ...)
├── assets/js/
│   ├── app.js                 # роутер, сайдбар, инициализация модулей
│   ├── config.js              # Telegram-юзернеймы, режим оплаты, комиссия, часовой пояс
│   ├── utils.js               # escapeHtml, safeUrl, fetchJson, localStorage, форматирование
│   ├── emoji.js               # 3D-эмодзи Fluent (jsDelivr) с фолбэком на обычный символ
│   ├── ics-parser.js          # парсер iCal (RFC 5545) на клиенте
│   ├── academo-parser.js      # разбор текста, скопированного со «Шкалы времени» Academo
│   ├── submit.js              # форма «Добавить работу» → SUBMIT_ENDPOINT или Telegram модератора
│   ├── deadlines.js           # приоритеты, слияние общих и личных дедлайнов, виджет в сайдбаре
│   ├── materials.js           # база знаний (главная): направление → ОП, курс, предмет, инструменты
│   ├── guide.js               # памятка первокурсника: темы, чеклист, шкала оценок, словарик
│   └── marketplace.js         # ядро заказа: суммы, комиссия, платёжные адаптеры (p2p → escrow)
├── data/
│   ├── programs.json          # 18 образовательных программ UIB, сгруппированных по направлениям
│   ├── guide.json             # памятка первокурсника
│   ├── deadlines.json         # общие дедлайны по группам
│   ├── materials.json         # база знаний и баллов
│   ├── marketplace.json       # объявления «Ищу / Предлагаю»
│   ├── teachers.json          # «Препод-Конфиденциально»
│   └── memes.json             # «Биржа мемов и фейлов»
├── .github/workflows/
│   ├── pages.yml              # (этап 0) деплой на GitHub Pages
│   └── validate-data.yml      # (этап 6) проверка data/*.json по JSON Schema на каждый PR
└── README.md
```

## Roadmap MVP

| Этап | Что делаем | Статус |
|---|---|---|
| 0. Подготовка | Репозиторий, GitHub Pages, Telegram-бот и закрытый чат модераторов | — |
| 1. Каркас + дедлайны | Оболочка, роутер, `deadlines.json`, загрузка `.ics`, 4 уровня приоритета, кнопка «Заказать помощь» | ✅ стартовый код |
| 2. База знаний | Карточки, фильтры по предмету, специальности и инструментам, поиск | ✅ стартовый код |
| 3. Маркетплейс (P2P) | Лента `marketplace.json`, вкладки «Ищу исполнителя» и «Предлагаю услуги», заказ → Telegram с шаблоном ТЗ | 🟡 есть ядро и форма заявки |
| 4. Утилиты | Генератор титульного листа (.docx через `docx.js`, PDF через печать), «Препод-Конфиденциально» | — |
| 5. Биржа мемов | Лента, реакции «Жизненно 💀» / «W в чат» | — |
| 6. Бот-модерация | Бот принимает материалы, мемы и советы → модератор жмёт ✅ → бот коммитит в `data/*.json` через GitHub API; проверка JSON Schema в CI | — |
| 7. Монетизация | Escrow + комиссия 10–15 %: включается в `config.js`, добавляется адаптер `escrow` | после MVP |

**Ограничение статики.** Без сервера глобальные счётчики реакций и лайков хранить негде. В MVP реакции сохраняются в `localStorage`. Для общих счётчиков на этапе 6 понадобится бесплатный бэкенд, например тот же Worker, на котором крутится бот.

## Схемы данных

Все даты хранятся в ISO 8601 со смещением (UIB: `+05:00`). Деньги указываются в целых тенге (`KZT`).

### `data/deadlines.json`

```jsonc
{
  "version": 1,
  "updated_at": "2026-10-27T09:00:00+05:00",
  "deadlines": [
    {
      "id": "dl-001",                       // уникальный, стабильный
      "title": "Лабораторная №3: VLAN",
      "course": "Компьютерные сети",
      "type": "lab",                        // lab | homework | project | quiz | exam | other
      "groups": ["ИС-23-1"],                // [] = для всех групп
      "due_at": "2026-10-28T23:59:00+05:00",
      "url": "https://uib.academo.kz/...",  // необязательно
      "source": "manual"                    // manual | academo-ics
    }
  ]
}
```

Приоритет **не хранится**, он вычисляется на клиенте от `due_at`:
`< 24 ч` → critical, `< 72 ч` → high, `< 7 дн` → medium, иначе low.

### `data/programs.json`: справочник образовательных программ

```jsonc
{
  "version": 2,
  "directions": [
    { "id": "finance", "name": "Финансы и учёт", "emoji": "money_bag" }   // группа для фильтра
  ],
  "programs": [
    {
      "code": "corp-finance",               // сейчас slug; заменить на официальный шифр 6B…
      "name": "Корпоративные финансы",
      "short": "Корп. финансы",             // короткая подпись для чипов на карточках
      "direction": "finance",               // id из directions
      "emoji": "money_bag"                  // ключ из assets/js/emoji.js
    }
  ]
}
```

### `data/guide.json`: памятка первокурсника

`checklist[]` (`id`, `text`) — чеклист первой недели, отметки хранятся в `localStorage`.
`sections[]` (`id`, `emoji`, `title`, `lead`, `points[]`, `tip?`) — раскрывающиеся темы.
`grade_scale[]` (`letter`, `points`, `from`, `to`, `meaning`) и `glossary[]` (`term`, `definition`).
Текст можно править без знания JS.

### `data/materials.json`

```jsonc
{
  "version": 1,
  "materials": [
    {
      "id": "mat-001",
      "subject": "Программирование на Python",
      "work": "Курсовой проект: Telegram-бот",
      "programs": ["6B06101"],              // коды ОП из programs.json
      "course_year": 2,
      "semester": "2026-осень",
      "teacher": "Фамилия И.О.",            // преподаватель, необязательно; по нему работает фильтр
      "score": { "got": 95, "max": 100 },
      "stack": ["Python", "aiogram", "SQLite"],
      "tip": "Преподаватель смотрит на README и тесты.",
      "links": [{ "label": "GitHub", "url": "https://github.com/..." }],
      "author": { "display": "Аноним", "anonymous": true },
      "created_at": "2026-10-20T12:00:00+05:00"
    }
  ]
}
```

### `data/marketplace.json`

```jsonc
{
  "version": 1,
  "listings": [
    {
      "id": "lst-001",
      "kind": "offer",                      // offer = «Предлагаю», request = «Ищу исполнителя»
      "category": "presentation",           // notes | homework | presentation | tutoring | other
      "title": "Презентации в Figma/PowerPoint",
      "description": "…",
      "subjects": ["Маркетинг"],
      "pricing": {
        "currency": "KZT",
        "price": 5000,                      // цена исполнителя
        "price_type": "fixed",              // fixed | from | per_hour
        "service_fee_percent": 0,           // сейчас 0; сайт берёт значение из config.js
        "total_amount": 5000                // price + fee; на клиенте всегда пересчитывается
      },
      "contact": { "telegram": "username" },
      "payment_mode": "p2p",                // p2p | escrow
      "status": "active",                   // active | paused | closed
      "created_at": "2026-10-25T10:00:00+05:00"
    }
  ]
}
```

### Заказ (`Order`): живёт в браузере, позже в бэкенде escrow

```jsonc
{
  "id": "ord-…",
  "listing_id": "lst-001",                  // null, если это открытая заявка
  "category": "homework",
  "subject": "…", "task": "…", "deadline_at": "…", "comment": "…",
  "currency": "KZT",
  "price": 5000,
  "service_fee_percent": 0,
  "service_fee_amount": 0,
  "total_amount": 5000,
  "payment_mode": "p2p",
  "status": "draft",
  "created_at": "…"
}
```

Жизненный цикл в escrow (этап 7):
`draft → pending_payment → in_escrow → delivered → released`, плюс ветки `disputed → refunded | released` и `cancelled`.
В P2P-режиме заказ доходит только до `draft`: его ТЗ уходит в Telegram.

**Как включить монетизацию без переписывания:** все суммы считает `calcAmounts()`, а ссылку или действие для оплаты выбирает адаптер по `order.payment_mode`.
Достаточно поменять в `config.js` `paymentMode: 'escrow'` и `serviceFeePercent: 10`, а затем реализовать `PAYMENT_ADAPTERS.escrow`.

### `data/teachers.json`

```jsonc
{
  "version": 1,
  "teachers": [
    {
      "id": "t-001",
      "display_name": "Преподаватель по сетям",   // как подписать решает модерация
      "subjects": ["Компьютерные сети"],
      "tips": [
        { "id": "tip-001", "text": "Принимает лабы только с отчётом в PDF.", "tags": ["сдача"], "created_at": "…" }
      ]
    }
  ]
}
```

### `data/memes.json`

```jsonc
{
  "version": 1,
  "memes": [
    {
      "id": "meme-001",
      "kind": "image",                      // image | text
      "image_url": "assets/memes/meme-001.webp",
      "text": "Когда дедлайн в 23:59, а Academo упал в 23:58",
      "author": { "display": "Аноним", "anonymous": true },
      "reactions": { "relatable": 0, "w": 0 },  // общие счётчики появятся с бэкендом
      "created_at": "…"
    }
  ]
}
```

## Поток модерации

Работы добавляются через форму на сайте («Добавить работу»). Сайт статический и сам писать в `data/*.json` не может, поэтому:

- **сейчас** (`SUBMIT_ENDPOINT: null`): форма собирает готовое сообщение (текст + JSON) и открывает Telegram модератора — студенту остаётся нажать «Отправить»;
- **потом**: укажи в `config.js` адрес бесплатного Cloudflare Worker. Форма отправит работу туда, Worker перешлёт её модераторам с кнопками ✅ / ❌ и после одобрения закоммитит в `materials.json` через GitHub API. Студент вообще не уходит с сайта.

Старый вариант через бота:

1. Студент открывает `t.me/<бот>?start=material|meme|teacher` и заполняет пошаговую форму.
2. Бот пересылает карточку в закрытый чат модераторов с кнопками ✅ / ❌.
3. После ✅ бот добавляет запись в нужный `data/*.json` через GitHub Contents API (или модератор делает это вручную на старте).
4. GitHub Pages пересобирается, и запись появляется на сайте. Telegram-ID автора в репозиторий не попадает.
