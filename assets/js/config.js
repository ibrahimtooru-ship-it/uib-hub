export const CONFIG = {
  DATA_PATH: 'data/',

  // Время в .ics без суффикса Z считаем временем UIB (с 2024 года весь Казахстан живёт в UTC+5)
  DEFAULT_UTC_OFFSET: '+05:00',

  TELEGRAM: {
    botUsername: 'uib_hub_mod_bot',   // бот модерации (работает через Worker)
    ordersUsername: 'kuruta06',       // куда уходят заявки маркетплейса «Ищу исполнителя»
    moderatorUsername: 'kuruta06',    // кому уходят работы, пока SUBMIT_ENDPOINT не задан
  },

  // Адрес Worker из папки worker/ (см. worker/README.md), например
  // 'https://uib-hub-submit.<аккаунт>.workers.dev/submit'.
  // Пока null — форма собирает готовое сообщение и открывает Telegram модератора.
  SUBMIT_ENDPOINT: null,

  MARKETPLACE: {
    currency: 'KZT',
    paymentMode: 'p2p',      // 'p2p' сейчас, 'escrow' после этапа 7
    serviceFeePercent: 0,    // 10–15 после включения модели гаранта
  },
};
