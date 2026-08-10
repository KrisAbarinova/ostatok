/**
 * Обёртка над Telegram WebApp SDK.
 *
 * initDataUnsafe здесь не используется как источник личности: сырой initData
 * уходит в Edge Function, где проверяется подпись. Всё, что берётся отсюда, —
 * оформление и системная кнопка «Назад».
 */
window.TG = (function () {
  const wa = window.Telegram && window.Telegram.WebApp;

  // Приложение открыто вне Telegram (например, локально в браузере)
  if (!wa) {
    return {
      available: false,
      initData: '',
      setBack: function () {},
      close: function () {},
    };
  }

  try { wa.ready(); } catch (e) { /* старая версия клиента */ }
  try { wa.expand(); } catch (e) { /* окно уже развёрнуто */ }

  // Полноэкранный режим: макет-«телефон» распрямляется на всю высоту окна
  document.body.classList.add('tg');

  try {
    wa.setHeaderColor('#0A0A0B');
    wa.setBackgroundColor('#0A0A0B');
  } catch (e) { /* метод недоступен в этой версии */ }

  try { wa.disableVerticalSwipes(); } catch (e) { /* появилось в 7.7 */ }

  function applyViewport() {
    const h = wa.viewportStableHeight || wa.viewportHeight;
    if (h) document.documentElement.style.setProperty('--tg-vh', h + 'px');
  }
  applyViewport();
  try { wa.onEvent('viewportChanged', applyViewport); } catch (e) { /* нет события */ }

  let backHandler = null;
  try {
    wa.BackButton.onClick(function () {
      if (backHandler) backHandler();
    });
  } catch (e) { /* BackButton недоступен */ }

  return {
    available: true,
    initData: wa.initData || '',

    /** Показать системную «Назад» с обработчиком, либо скрыть её (fn === null). */
    setBack: function (fn) {
      backHandler = fn;
      try {
        if (fn) wa.BackButton.show();
        else wa.BackButton.hide();
      } catch (e) { /* BackButton недоступен */ }
    },

    close: function () {
      try { wa.close(); } catch (e) { /* нет метода */ }
    },
  };
})();
