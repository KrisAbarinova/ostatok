/**
 * «Остаток» — логика Mini App.
 *
 * Вёрстка, тексты и расчётная модель — как в прототипе. Отличие одно:
 * постоянные данные (период, доход, обязательные расходы, дневной бюджет,
 * транзакции) живут в Supabase и приходят через Edge Function, а не в памяти
 * страницы. При повторном открытии состояние восстанавливается с сервера.
 */
const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const rub = n => (n < 0 ? '−' : '') + Math.abs(Math.round(n)).toLocaleString('ru-RU') + ' ₽';
const sgn = n => (n >= 0 ? '+' : '−') + Math.abs(Math.round(n)).toLocaleString('ru-RU') + ' ₽';
const esc = s => String(s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const MON = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const MS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const MN = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const DW = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const NO_DESC = 'Без описания';

/* Даты — строго в локальном времени. toISOString() сдвигал бы день
   для часовых поясов восточнее UTC (в Москве — на сутки назад). */
const d = s => new Date(s + 'T00:00:00');
const pad = n => String(n).padStart(2, '0');
const iso = x => x.getFullYear() + '-' + pad(x.getMonth() + 1) + '-' + pad(x.getDate());
const addDays = (x, n) => new Date(x.getFullYear(), x.getMonth(), x.getDate() + n);
const utc = x => Date.UTC(x.getFullYear(), x.getMonth(), x.getDate());
const dCount = (a, b) => Math.round((utc(d(b)) - utc(d(a))) / 864e5) + 1;
const dayLabel = k => { const dt = d(k); return `${dt.getDate()} ${MON[dt.getMonth()]}`; };

/* ---- состояние ---- */
const S = {
  user: null,
  period: null,        // активный период из БД
  periods: [],         // все периоды пользователя, новые первыми
  spend: {},           // дата -> [{id, d, s, raw}] активного периода
  cache: {},           // period_id -> такая же карта
  today: API.localToday(),
  viewDate: API.localToday(), // какой день сейчас открыт на экране «Сегодня»
  // черновик онбординга и экрана настроек
  income: 0,
  mandatory: [],
  savePct: 20,
  start: '',
  end: '',
};

/* ---- расчёт ---- */
const mandT = () => S.mandatory.reduce((a, m) => a + m.sum, 0);
const freeInc = () => Math.max(0, S.income - mandT() - S.income * S.savePct / 100);
const pDays = () => Math.max(1, dCount(S.start, S.end));
const calcDaily = () => Math.round(freeInc() / pDays());

const dailyOf = p => Math.round(Number(p.daily_budget));
const daysOf = p => Math.max(1, dCount(p.start_date, p.end_date));
const daily = () => (S.period ? dailyOf(S.period) : calcDaily());

const spentIn = (spend, k) => (spend[k] || []).reduce((a, t) => a + t.s, 0);
const spentOn = k => spentIn(S.spend, k);

function balIn(p, spend, k) {
  let b = 0, c = d(p.start_date);
  const e = d(k), dly = dailyOf(p);
  while (c <= e) { b += dly - spentIn(spend, iso(c)); c = addDays(c, 1); }
  return b;
}
function carry(k) {
  if (!S.period) return 0;
  const y = iso(addDays(d(k), -1));
  return d(y) < d(S.period.start_date) ? 0 : balIn(S.period, S.spend, y);
}

/* ---- преобразование транзакций ---- */
const txItem = t => ({
  id: t.id,
  s: Number(t.amount),
  raw: t.description,
  d: t.description || NO_DESC,
});
function buildSpend(list) {
  const m = {};
  (list || []).forEach(t => { (m[t.transaction_date] = m[t.transaction_date] || []).push(txItem(t)); });
  return m;
}
function addLocal(k, tx) { (S.spend[k] = S.spend[k] || []).push(txItem(tx)); }
function dropLocal(k, id) {
  if (!S.spend[k]) return;
  S.spend[k] = S.spend[k].filter(t => t.id !== id);
  if (!S.spend[k].length) delete S.spend[k];
}

function errText(e) {
  if (!e) return 'Что-то пошло не так';
  if (e.code === 'no_init_data') return 'Откройте приложение через Telegram';
  if (e.code === 'network') return 'Нет связи. Попробуйте ещё раз';
  return e.message || 'Что-то пошло не так';
}

/* ---- router ---- */
const BACK = { setup: 'welcome', setup2: 'setup', setup3: 'setup2', add: 'today', archive: 'month' };

function go(id) {
  $$('.screen').forEach(s => s.classList.toggle('on', s.dataset.s === id));
  const back = BACK[id];
  window.TG.setBack(back ? () => go(resolveDest(back)) : null);
  ({
    today: renderToday, add: resetAdd, month: renderMonth,
    archive: renderArch, setup3: renderS3, setup2: renderMand,
  }[id] || (() => {}))();
}

/* У пользователя с активным периодом «Назад» на первом шаге настроек
   возвращает в приложение, а не на приветственный экран. */
const resolveDest = dest => (dest === 'welcome' && S.period ? 'today' : dest);

document.addEventListener('click', e => {
  const t = e.target.closest('[data-go]');
  if (!t) return;
  const dest = resolveDest(t.dataset.go);
  if (dest === 'month' && t.classList.contains('navb')) viewIdx = 0;
  if (dest === 'today' && t.classList.contains('navb')) S.viewDate = S.today;
  go(dest);
});

/* ---- toast with undo ---- */
let undoFn = null, toastT = null;
function toast(msg, fn) {
  $('#toastMsg').textContent = msg; undoFn = fn || null;
  $('#toastUndo').style.display = fn ? 'block' : 'none';
  $('#toast').classList.add('on');
  clearTimeout(toastT); toastT = setTimeout(() => $('#toast').classList.remove('on'), 4200);
}
$('#toastUndo').addEventListener('click', () => { if (undoFn) undoFn(); $('#toast').classList.remove('on'); });

/* ---- setup ---- */
function renderMand() {
  const b = $('#mand'); b.innerHTML = '';
  S.mandatory.forEach((m, i) => {
    const r = document.createElement('div'); r.className = 'row act';
    r.innerHTML = `<span>${esc(m.name)}</span><span class="mono">${rub(m.sum)}</span>`;
    r.title = 'Нажмите, чтобы удалить';
    r.addEventListener('click', () => {
      if (!confirm(`Удалить статью «${m.name}»?`)) return;
      const rm = S.mandatory.splice(i, 1)[0];
      renderMand(); paintSave();
      toast('Статья удалена', () => { S.mandatory.splice(i, 0, rm); renderMand(); paintSave(); });
    });
    b.appendChild(r);
  });
}
$('#addMand').addEventListener('click', () => {
  const n = (prompt('Название статьи') || '').trim(); if (!n) return;
  const v = parseFloat(prompt('Сумма, ₽'));
  if (!(v > 0)) { alert('Введите сумму больше нуля.'); return; }
  S.mandatory.push({ name: n, sum: v }); renderMand(); paintSave();
});
$('#inc').addEventListener('input', e => { S.income = Math.max(0, +e.target.value || 0); paintSave(); });
function paintSave() {
  const p = S.savePct;
  $('#save').value = p;
  $('#save').style.setProperty('--p', p / 95 * 100 + '%');
  $('#savePct').textContent = p;
  $('#saveSumLine').textContent = `Это ${rub(S.income * p / 100)} за период`;
}
$('#save').addEventListener('input', e => { S.savePct = +e.target.value; paintSave(); });
function checkDates() {
  const a = $('#pStart').value, b = $('#pEnd').value, bad = !a || !b || d(b) <= d(a);
  $('#dateErr').classList.toggle('on', bad);
  $('#s1Go').disabled = bad;
  if (!bad) { S.start = a; S.end = b; $('#daysOut').textContent = pDays(); }
  renderPeriodBtn();
  return !bad;
}
function renderPeriodBtn() {
  const a = $('#pStart').value, b = $('#pEnd').value;
  $('#periodBtnText').textContent = (a && b)
    ? `${d(a).getDate()} ${MS[d(a).getMonth()]} — ${d(b).getDate()} ${MS[d(b).getMonth()]}`
    : 'Выбрать даты';
}

/* ---- выбор периода одним календарём (как при выборе дат для поездки) ---- */
let rcView = null, pickA = null, pickB = null;

function openRangeCal() {
  pickA = $('#pStart').value || null;
  pickB = $('#pEnd').value || null;
  const base = d(pickA || iso(new Date()));
  rcView = new Date(base.getFullYear(), base.getMonth(), 1);
  $('#rangeCal').style.display = 'block';
  $('#periodBtn').setAttribute('aria-expanded', 'true');
  $('#periodBtnIco').textContent = '▴';
  renderRangeCal();
}
function closeRangeCal() {
  $('#rangeCal').style.display = 'none';
  $('#periodBtn').setAttribute('aria-expanded', 'false');
  $('#periodBtnIco').textContent = '▾';
}
$('#periodBtn').addEventListener('click', () => {
  if ($('#rangeCal').style.display === 'none') openRangeCal(); else closeRangeCal();
});
$('#rcPrev').addEventListener('click', () => {
  rcView = new Date(rcView.getFullYear(), rcView.getMonth() - 1, 1); renderRangeCal();
});
$('#rcNext').addEventListener('click', () => {
  rcView = new Date(rcView.getFullYear(), rcView.getMonth() + 1, 1); renderRangeCal();
});

function pickDay(k) {
  if (!pickA || (pickA && pickB)) { pickA = k; pickB = null; }
  else if (k < pickA) { pickA = k; pickB = null; }
  else if (k > pickA) { pickB = k; }
  renderRangeCal();
  if (pickA && pickB) {
    $('#pStart').value = pickA; $('#pEnd').value = pickB;
    checkDates();
    closeRangeCal();
  }
}

function renderRangeCal() {
  $('#rcMonth').textContent = `${MN[rcView.getMonth()]} ${rcView.getFullYear()}`;
  $('#rcHint').textContent = !pickA ? 'Выберите первый день периода'
    : !pickB ? 'Выберите последний день периода' : '';

  const grid = $('#rcGrid'); grid.innerHTML = '';
  ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'].forEach(x => {
    const s = document.createElement('span'); s.className = 'dow'; s.textContent = x; grid.appendChild(s);
  });
  const first = new Date(rcView.getFullYear(), rcView.getMonth(), 1);
  const last = new Date(rcView.getFullYear(), rcView.getMonth() + 1, 0);
  for (let i = 0; i < (first.getDay() + 6) % 7; i++) grid.appendChild(document.createElement('span'));
  for (let day = 1; day <= last.getDate(); day++) {
    const dt = new Date(rcView.getFullYear(), rcView.getMonth(), day), k = iso(dt);
    const s = document.createElement('span');
    s.textContent = day;
    s.setAttribute('role', 'button'); s.tabIndex = 0;
    if (pickA && pickB && k > pickA && k < pickB) s.classList.add('rin');
    if (pickA === k) s.classList.add('rs');
    if (pickB === k) s.classList.add('re');
    const pick = () => pickDay(k);
    s.addEventListener('click', pick);
    s.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
    grid.appendChild(s);
  }
}
function renderS3() {
  $('#dailyOut').textContent = rub(calcDaily());
  $('#freeOut').textContent = rub(freeInc());
  $('#daysOut2').textContent = pDays();
}

/* Завершение онбординга: период создаётся (или обновляется) на сервере,
   дневной бюджет считает Edge Function. */
$('#startPeriod').addEventListener('click', async () => {
  if (!checkDates()) { go('setup'); return; }
  const btn = $('#startPeriod'); btn.disabled = true;
  try {
    const r = await API.createPeriod({
      start_date: S.start,
      end_date: S.end,
      income: S.income,
      fixed_expenses: mandT(),
      savings: S.income * S.savePct / 100,
    });
    S.periods = []; S.cache = {};
    await enterApp(r.period);
  } catch (e) {
    toast(errText(e));
  } finally {
    btn.disabled = false;
  }
});

/* ---- today ---- */
function renderToday() {
  if (!S.period) return;
  const k = S.viewDate, c = carry(k), avail = c + daily(), sp = spentOn(k), list = S.spend[k] || [];
  $('#todayDate').textContent = dayLabel(k);
  $('#dayNo').textContent = `Дн. ${dCount(S.period.start_date, k)}/${daysOf(S.period)}`;
  $('#availOut').textContent = rub(avail - sp);
  $('#carryOut').textContent = rub(c);
  $('#dailyOut2').textContent = rub(daily());
  $('#spentOut').textContent = rub(sp);
  $('#tmwOut').textContent = rub(avail - sp + daily());

  const totalBudget = dailyOf(S.period) * daysOf(S.period);
  const totalSpent = Object.values(S.spend).reduce((sum, dayList) => sum + dayList.reduce((a, t) => a + t.s, 0), 0);
  $('#totalLeftOut').textContent = rub(totalBudget - totalSpent);

  const atStart = d(k) <= d(S.period.start_date), atToday = d(k) >= d(S.today);
  $('#dPrev').disabled = atStart; $('#dPrev').style.opacity = atStart ? .3 : 1;
  $('#dNext').disabled = atToday; $('#dNext').style.opacity = atToday ? .3 : 1;

  $('#txnCount').textContent = list.length;
  const box = $('#txnList'); box.innerHTML = '';
  if (!list.length) { box.innerHTML = '<p class="p" style="padding:14px 0">Пока пусто. Добавьте первую трату.</p>'; }
  list.forEach(t => {
    const el = document.createElement('div'); el.className = 'txn';
    el.setAttribute('role', 'button'); el.tabIndex = 0; el.title = 'Нажмите, чтобы удалить';
    el.innerHTML = `<div><p>${esc(t.d)}</p></div>
      <div style="display:flex;align-items:center;gap:8px">
        <b>${rub(t.s)}</b><span class="txn-x" aria-hidden="true">×</span>
      </div>`;
    const del = async () => {
      if (!confirm(`Удалить «${t.d}» на ${rub(t.s)}?`)) return;
      try { await API.deleteTransaction(t.id); } catch (e) { toast(errText(e)); return; }
      dropLocal(k, t.id); renderToday();
      toast('Трата удалена', async () => {
        try {
          const r = await API.createTransaction({ amount: t.s, description: t.raw, transaction_date: k });
          addLocal(k, r.transaction); renderToday();
        } catch (e) { toast(errText(e)); }
      });
    };
    el.addEventListener('click', del);
    el.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); del(); } });
    box.appendChild(el);
  });
}
$('#dPrev').addEventListener('click', () => {
  if (!S.period) return;
  const prev = iso(addDays(d(S.viewDate), -1));
  if (d(prev) < d(S.period.start_date)) return;
  S.viewDate = prev; renderToday();
});
$('#dNext').addEventListener('click', () => {
  if (!S.period) return;
  const next = iso(addDays(d(S.viewDate), 1));
  if (d(next) > d(S.today)) return;
  S.viewDate = next; renderToday();
});

/* ---- add ---- */
let amt = '';
function resetAdd() {
  amt = ''; $('#desc').value = '';
  $('#addTitle').textContent = S.viewDate === S.today ? 'Новая трата' : `Трата · ${dayLabel(S.viewDate)}`;
  paintAdd();
}
function paintAdd() {
  const v = parseFloat(amt || '0') || 0;
  const av = S.period ? carry(S.viewDate) + daily() - spentOn(S.viewDate) : 0;
  $('#amtOut').textContent = rub(v);
  $('#addHint').textContent = `Останется ${rub(av - v)} · завтра ${rub(av - v + daily())}`;
  $('#saveTxn').disabled = !(v > 0);
}
function press(ch) {
  if (ch === 'c') { amt = ''; }
  else if (ch === 'del') { amt = amt.slice(0, -1); }
  else if (ch === '.') { if (!amt.includes('.')) amt = (amt || '0') + '.'; }
  else if (/\d/.test(ch)) {
    if (amt === '0') amt = ch;
    else if (amt.replace('.', '').length < 8) amt += ch;
  }
  paintAdd();
}
$('#keys').addEventListener('click', e => {
  const b = e.target.closest('.key'); if (!b) return;
  press(b.dataset.k || b.textContent.trim());
});
$$('.chip').forEach(c => c.addEventListener('click', () => {
  amt = String((parseFloat(amt || '0') || 0) + +c.dataset.add); paintAdd();
}));
document.addEventListener('keydown', e => {
  if (!$('.screen[data-s=add]').classList.contains('on')) return;
  if (document.activeElement === $('#desc')) return;
  if (/^\d$/.test(e.key)) press(e.key);
  else if (e.key === 'Backspace') { e.preventDefault(); press('del'); }
  else if (e.key === 'Escape') go('today');
  else if (e.key === 'Enter' && !$('#saveTxn').disabled) $('#saveTxn').click();
});
$('#saveTxn').addEventListener('click', async () => {
  const v = parseFloat(amt) || 0; if (!(v > 0)) return;
  const k = S.viewDate, raw = $('#desc').value.trim() || null;
  const btn = $('#saveTxn'); btn.disabled = true;
  let tx;
  try {
    tx = (await API.createTransaction({ amount: v, description: raw, transaction_date: k })).transaction;
  } catch (e) {
    btn.disabled = false; toast(errText(e)); return;
  }
  addLocal(k, tx);
  resetAdd(); go('today');
  toast(`Добавлено ${rub(v)}`, async () => {
    try { await API.deleteTransaction(tx.id); dropLocal(k, tx.id); renderToday(); }
    catch (e) { toast(errText(e)); }
  });
});

/* ---- month ---- */
let viewIdx = 0;   // индекс в S.periods: 0 — текущий период

async function loadPeriods() {
  const r = await API.listPeriods();
  S.periods = r.periods || [];
  return S.periods;
}
async function loadSpend(p) {
  if (S.period && p.id === S.period.id) return S.spend;
  if (S.cache[p.id]) return S.cache[p.id];
  const r = await API.listTransactions(p.id);
  S.cache[p.id] = buildSpend(r.transactions);
  return S.cache[p.id];
}

async function renderMonth() {
  try {
    if (!S.periods.length) await loadPeriods();
  } catch (e) { toast(errText(e)); return; }

  const p = S.periods[viewIdx];
  if (!p) return;
  let spend;
  try { spend = await loadSpend(p); } catch (e) { toast(errText(e)); return; }

  const st = d(p.start_date), en = d(p.end_date), dly = dailyOf(p);
  const isCur = !!S.period && p.id === S.period.id;

  $('#mName').textContent = MN[en.getMonth()];
  $('#mRange').textContent = `${st.getDate()} ${MS[st.getMonth()]} — ${en.getDate()} ${MS[en.getMonth()]}`;
  $('#mNext').style.opacity = viewIdx <= 0 ? .3 : 1;
  $('#mNext').disabled = viewIdx <= 0;
  $('#mPrev').style.opacity = viewIdx >= S.periods.length - 1 ? .3 : 1;
  $('#mPrev').disabled = viewIdx >= S.periods.length - 1;

  let c = new Date(st), bal = 0, pts = [], tot = 0, n = 0, mx = 1, rows = [];
  const upto = isCur ? d(S.today) : en;
  while (c <= en) {
    const k = iso(c), sp = spentIn(spend, k);
    if (c <= upto) { bal += dly - sp; tot += sp; n++; pts.push(bal); if (sp > mx) mx = sp; }
    if (sp > 0) rows.push({ k, sp, bal, dt: new Date(c) });
    c = addDays(c, 1);
  }
  $('#mBal').textContent = sgn(bal);
  $('#mSpent').textContent = rub(tot);
  $('#mAvg').textContent = rub(n ? tot / n : 0);

  $('#spark').removeAttribute('points');
  if (pts.length > 1) {
    const lo = Math.min(...pts, 0), hi = Math.max(...pts, 0), rg = (hi - lo) || 1;
    const pl = pts.map((v, i) => `${(i * (268 / (pts.length - 1))).toFixed(1)},${(50 - ((v - lo) / rg) * 44).toFixed(1)}`);
    $('#spark').setAttribute('points', pl.join(' '));
    const [x, y] = pl[pl.length - 1].split(',');
    $('#sparkDot').setAttribute('cx', x); $('#sparkDot').setAttribute('cy', y);
    $('#sparkDot').style.display = '';
  } else {
    $('#sparkDot').style.display = 'none';
  }

  const cal = $('#cal'); cal.innerHTML = '';
  ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'].forEach(x => {
    const s = document.createElement('span'); s.className = 'dow'; s.textContent = x; cal.appendChild(s);
  });
  for (let i = 0; i < (st.getDay() + 6) % 7; i++) cal.appendChild(document.createElement('span'));
  c = new Date(st);
  while (c <= en) {
    const k = iso(c), sp = spentIn(spend, k), s = document.createElement('span');
    s.textContent = c.getDate();
    s.title = sp ? `${c.getDate()} ${MS[c.getMonth()]} — ${rub(sp)}` : `${c.getDate()} ${MS[c.getMonth()]} — трат нет`;
    if (isCur && k === S.today) s.className = 'now';
    else if (isCur && d(k) > d(S.today)) s.className = 'fut';
    else if (!sp) s.className = 'l0';
    else if (sp < mx * .33) s.className = 'l1';
    else if (sp < mx * .66) s.className = 'l2';
    else s.className = 'l3';
    cal.appendChild(s); c = addDays(c, 1);
  }

  const box = $('#mDays'); box.innerHTML = '';
  if (!rows.length) box.innerHTML = '<p class="p" style="padding:12px 0">В этом периоде трат не было.</p>';
  rows.slice(-7).reverse().forEach(r => {
    const names = (spend[r.k] || []).map(t => t.d).join(', ');
    const el = document.createElement('div'); el.className = 'txn'; el.style.cursor = 'default';
    el.innerHTML = `<div><p>${r.dt.getDate()} ${MS[r.dt.getMonth()]}, ${DW[r.dt.getDay()]}</p><small>${esc(names)}</small></div>
      <div style="text-align:right"><b>${rub(r.sp)}</b><br><small>${sgn(r.bal)}</small></div>`;
    box.appendChild(el);
  });
}
$('#mPrev').addEventListener('click', () => { if (viewIdx < S.periods.length - 1) { viewIdx++; renderMonth(); } });
$('#mNext').addEventListener('click', () => { if (viewIdx > 0) { viewIdx--; renderMonth(); } });

/* ---- archive ---- */
async function renderArch() {
  const box = $('#perList');
  try { await loadPeriods(); } catch (e) { toast(errText(e)); return; }
  box.innerHTML = '';
  if (!S.periods.length) {
    box.innerHTML = '<p class="p">Периодов пока нет.</p>';
    return;
  }
  S.periods.forEach((p, i) => {
    const st = d(p.start_date), en = d(p.end_date), cur = !!S.period && p.id === S.period.id;
    const dly = dailyOf(p);
    let sp = Number(p.total_spent) || 0;
    // у текущего периода берём локальное состояние — оно свежее, чем список
    let n = daysOf(p);
    if (cur) {
      sp = 0; n = 0;
      let c = new Date(st);
      const upto = d(S.today) < en ? d(S.today) : en;
      while (c <= upto) { sp += spentOn(iso(c)); n++; c = addDays(c, 1); }
    }
    const bal = dly * n - sp;

    const el = document.createElement('div'); el.className = 'per' + (cur ? ' cur' : '');
    el.setAttribute('role', 'button'); el.tabIndex = 0;
    el.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center">
        <h4>${MN[en.getMonth()]}</h4>${cur ? '<span class="tagn">Текущий</span>' : '<span style="color:var(--fg3)">→</span>'}
      </div>
      <p class="pm">${st.getDate()} ${MS[st.getMonth()]} — ${en.getDate()} ${MS[en.getMonth()]} · ${rub(dly)}/дн.</p>
      <div class="pf"><span>Потрачено ${rub(sp)}</span><b>${sgn(bal)}</b></div>`;
    const open = () => { viewIdx = i; go('month'); };
    el.addEventListener('click', open);
    el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    box.appendChild(el);
  });
}

/* ---- запуск ---- */
function monthBounds() {
  const x = new Date();
  return { s: iso(new Date(x.getFullYear(), x.getMonth(), 1)), e: iso(new Date(x.getFullYear(), x.getMonth() + 1, 0)) };
}

/** Черновик для нового пользователя: текущий календарный месяц, пустые статьи. */
function prepareOnboarding() {
  const b = monthBounds();
  S.start = b.s; S.end = b.e;
  S.income = 0; S.mandatory = []; S.savePct = 20;
  $('#pStart').value = S.start; $('#pEnd').value = S.end;
  $('#inc').value = '';
  renderMand(); checkDates(); paintSave();
}

/** Экран настроек для существующего периода: подставляем сохранённые значения. */
function fillSetup(p) {
  S.start = p.start_date; S.end = p.end_date;
  S.income = Number(p.income);
  const fixed = Number(p.fixed_expenses);
  // отдельные статьи расходов в схеме не хранятся — показываем одной строкой
  S.mandatory = fixed > 0 ? [{ name: 'Обязательные расходы', sum: fixed }] : [];
  const savings = Math.max(0, S.income - fixed - dailyOf(p) * daysOf(p));
  S.savePct = S.income > 0 ? Math.min(95, Math.max(0, Math.round(savings / S.income * 100))) : 0;
  $('#pStart').value = S.start; $('#pEnd').value = S.end;
  $('#inc').value = S.income;
  renderMand(); checkDates(); paintSave();
}

async function enterApp(period) {
  S.period = period;
  const r = await API.listTransactions(period.id);
  S.spend = buildSpend(r.transactions);
  S.cache[period.id] = S.spend;
  viewIdx = 0;
  S.viewDate = S.today;
  fillSetup(period);
  go('today');
}

async function boot() {
  try {
    const r = await API.init();
    S.user = r.user;
    if (r.period) { await enterApp(r.period); return; }
    prepareOnboarding();
    go('welcome');
  } catch (e) {
    prepareOnboarding();
    go('welcome');
    toast(errText(e));
  }
}

boot();
