/**
 * Клиент Edge Function.
 *
 * Каждый запрос несёт сырой Telegram initData в заголовке X-Telegram-Init-Data.
 * Пользователь на сервере определяется только из него — user_id отсюда не уходит.
 */
window.API = (function () {
  const BASE = window.APP_CONFIG.SUPABASE_URL + '/functions/v1/api';
  const KEY = window.APP_CONFIG.SUPABASE_ANON_KEY;

  /** Локальная дата пользователя: на сервере UTC, и под утро он отстаёт на день. */
  function localToday() {
    const x = new Date();
    const p = n => String(n).padStart(2, '0');
    return x.getFullYear() + '-' + p(x.getMonth() + 1) + '-' + p(x.getDate());
  }

  async function call(path, body) {
    const initData = window.TG.initData;
    if (!initData) {
      const e = new Error('Откройте приложение через Telegram');
      e.code = 'no_init_data';
      throw e;
    }

    let res;
    try {
      res = await fetch(BASE + path, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Telegram-Init-Data': initData,
          'apikey': KEY,
          'Authorization': 'Bearer ' + KEY,
        },
        body: JSON.stringify(Object.assign({ today: localToday() }, body || {})),
      });
    } catch (netErr) {
      const e = new Error('Нет связи с сервером');
      e.code = 'network';
      throw e;
    }

    let data = {};
    try { data = await res.json(); } catch (e) { /* пустой или битый ответ */ }

    if (!res.ok) {
      const e = new Error(data.error || ('Ошибка ' + res.status));
      e.code = data.code || 'http_' + res.status;
      e.status = res.status;
      throw e;
    }
    return data;
  }

  return {
    localToday: localToday,

    init: () => call('/init'),
    currentPeriod: () => call('/period/current'),
    createPeriod: p => call('/period/create', p),
    getPeriod: periodId => call('/period/get', { period_id: periodId }),
    listPeriods: () => call('/period/list'),

    createTransaction: t => call('/transaction/create', t),
    listTransactions: periodId => call('/transaction/list', { period_id: periodId }),
    updateTransaction: t => call('/transaction/update', t),
    deleteTransaction: id => call('/transaction/delete', { id: id }),
  };
})();
