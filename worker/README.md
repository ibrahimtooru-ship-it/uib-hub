# UIB Hub — Worker для приёма работ

Бесплатный Cloudflare Worker (до 100 000 запросов в день). Как он работает:

1. Студент заполняет форму «Добавить работу» на сайте → работа летит в Worker.
2. Worker проверяет данные, кладёт работу в очередь (Cloudflare KV) и присылает её в чат модераторов с кнопками **✅ Опубликовать** и **❌ Отклонить**.
3. ✅ → Worker сам делает коммит в `data/materials.json` → GitHub Pages обновляет сайт за 1–2 минуты.
4. ❌ → работа удаляется из очереди. Необработанные заявки сами удаляются через 30 дней.

Защита: принимаем запросы только с адреса сайта, не больше 5 заявок в час с одного IP, скрытое поле-ловушка для ботов, кнопки работают только в чате модераторов.

## Что понадобится

- аккаунт [Cloudflare](https://dash.cloudflare.com/sign-up) (бесплатный);
- [Node.js](https://nodejs.org/) LTS — чтобы запустить `npx wrangler`;
- Telegram-бот и закрытая группа модераторов;
- GitHub-токен с доступом к репозиторию сайта.

## Настройка (один раз, ~15 минут)

Все команды выполняются в папке `worker`.

### 1. Бот и чат модераторов

1. В [@BotFather](https://t.me/BotFather) отправь `/newbot` и сохрани токен.
2. Создай группу модераторов и добавь туда бота.
3. Узнай id группы: напиши в ней любое сообщение и открой в браузере
   `https://api.telegram.org/bot<ТОКЕН>/getUpdates` — нужное число в `"chat":{"id":-100…}`.
4. Впиши его в `MODERATOR_CHAT_ID` в `wrangler.toml`.

### 2. GitHub-токен

GitHub → Settings → Developer settings → **Fine-grained tokens** → Generate new token:

- Repository access: **Only select repositories** → репозиторий сайта;
- Permissions → Repository → **Contents: Read and write**.

Больше ничего не давай: токен должен уметь только менять файлы в одном репозитории.

### 3. Переменные в `wrangler.toml`

- `ALLOWED_ORIGIN` — адрес сайта, например `https://kuruta.github.io`;
- `GITHUB_REPO` — `логин/репозиторий`;
- `MATERIALS_PATH` — путь к `materials.json` внутри репозитория (если сайт лежит в корне репо — `data/materials.json`).

### 4. Деплой

```bash
npx wrangler login
```

```bash
npx wrangler kv namespace create SUBMISSIONS
```

Скопируй `id` из вывода в `wrangler.toml`, затем добавь секреты (каждая команда спросит значение):

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
```

```bash
npx wrangler secret put GITHUB_TOKEN
```

```bash
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
```

Для `TELEGRAM_WEBHOOK_SECRET` придумай длинную строку из латиницы, цифр, `_` и `-`.

```bash
npx wrangler deploy
```

Wrangler покажет адрес вида `https://uib-hub-submit.<аккаунт>.workers.dev`.

### 5. Подключи кнопки бота к Worker

Открой в браузере (подставь свои значения):

```
https://api.telegram.org/bot<ТОКЕН>/setWebhook?url=https://uib-hub-submit.<аккаунт>.workers.dev/telegram&secret_token=<TELEGRAM_WEBHOOK_SECRET>&allowed_updates=["callback_query"]
```

Должно ответить `"ok":true`.

### 6. Включи на сайте

В `assets/js/config.js`:

```js
SUBMIT_ENDPOINT: 'https://uib-hub-submit.<аккаунт>.workers.dev/submit',
```

Закоммить — и форма начнёт отправлять работы в Worker, без Telegram для студента.

## Проверка

1. Отправь работу через форму на сайте.
2. В чате модераторов появится карточка с кнопками.
3. Нажми ✅ — в репозитории появится коммит «Новая работа: …», через пару минут работа будет на сайте.

Логи Worker в реальном времени:

```bash
npx wrangler tail
```

## Ограничения

- При публикации Worker переписывает `materials.json` целиком с отступом в 2 пробела, поэтому первый коммит изменит форматирование файла.
- GitHub Contents API читает файлы до 1 МБ. Это примерно 2000 работ; дальше базу стоит разбить на файлы по предметам.
