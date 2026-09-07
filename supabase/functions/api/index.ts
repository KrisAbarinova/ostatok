/**
 * «Остаток» — единственная Edge Function приложения.
 *
 * Архитектура: Telegram Mini App → Edge Function → Supabase Database.
 * Клиент никогда не ходит в таблицы напрямую: RLS включён и политик нет,
 * поэтому anon-ключ не даёт доступа к строкам. Внутри функции используется
 * service role, но только после успешной проверки подписи Telegram initData.
 *
 * Авторизация: заголовок X-Telegram-Init-Data с сырым initData.
 * user_id из тела запроса не принимается ни в одном маршруте.
 */

import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { InitDataError, type TelegramUser, verifyInitData } from "./telegram.ts";
import {
  asDate,
  asId,
  asMoney,
  asOptionalText,
  asTxType,
  BadRequest,
  dayCount,
} from "./validate.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-telegram-init-data",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

interface DbUser {
  id: number;
  telegram_id: number;
  username: string | null;
  first_name: string | null;
}

interface Period {
  id: number;
  user_id: number;
  start_date: string;
  end_date: string;
  income: number;
  fixed_expenses: number;
  daily_budget: number;
}

const PERIOD_COLS = "id,user_id,start_date,end_date,income,fixed_expenses,daily_budget";
const TX_COLS = "id,period_id,type,amount,description,transaction_date,created_at";

/** Сегодняшняя дата по UTC — запасной вариант, если клиент не прислал свою локальную. */
function serverToday(): string {
  return new Date().toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------ */
/*  Пользователь                                                       */
/* ------------------------------------------------------------------ */

/**
 * Находит пользователя по telegram_id, создаёт при отсутствии,
 * обновляет username / first_name, если Telegram прислал новые значения.
 */
async function resolveUser(db: SupabaseClient, tg: TelegramUser): Promise<DbUser> {
  const { data: found, error: selErr } = await db
    .from("users")
    .select("id,telegram_id,username,first_name")
    .eq("telegram_id", tg.id)
    .maybeSingle();
  if (selErr) throw selErr;

  if (found) {
    const patch: Record<string, string | null> = {};
    if (tg.username !== null && tg.username !== found.username) patch.username = tg.username;
    if (tg.first_name !== null && tg.first_name !== found.first_name) {
      patch.first_name = tg.first_name;
    }
    if (Object.keys(patch).length === 0) return found as DbUser;

    const { data: updated, error: updErr } = await db
      .from("users")
      .update(patch)
      .eq("id", found.id)
      .select("id,telegram_id,username,first_name")
      .single();
    if (updErr) throw updErr;
    return updated as DbUser;
  }

  const { data: created, error: insErr } = await db
    .from("users")
    .insert({ telegram_id: tg.id, username: tg.username, first_name: tg.first_name })
    .select("id,telegram_id,username,first_name")
    .single();

  if (insErr) {
    // 23505: параллельный запрос успел создать запись — берём существующую
    if ((insErr as { code?: string }).code === "23505") {
      const { data: again, error } = await db
        .from("users")
        .select("id,telegram_id,username,first_name")
        .eq("telegram_id", tg.id)
        .single();
      if (error) throw error;
      return again as DbUser;
    }
    throw insErr;
  }
  return created as DbUser;
}

/* ------------------------------------------------------------------ */
/*  Периоды                                                            */
/* ------------------------------------------------------------------ */

/** Период, в который попадает дата. */
async function periodOn(
  db: SupabaseClient,
  userId: number,
  day: string,
): Promise<Period | null> {
  const { data, error } = await db
    .from("periods")
    .select(PERIOD_COLS)
    .eq("user_id", userId)
    .lte("start_date", day)
    .gte("end_date", day)
    .order("start_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as Period) ?? null;
}

/** Период пользователя по id — с проверкой владельца. */
async function ownedPeriod(
  db: SupabaseClient,
  userId: number,
  periodId: number,
): Promise<Period> {
  const { data, error } = await db
    .from("periods")
    .select(PERIOD_COLS)
    .eq("id", periodId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new BadRequest("Период не найден");
  return data as Period;
}

/* ------------------------------------------------------------------ */
/*  Маршруты                                                           */
/* ------------------------------------------------------------------ */

type Body = Record<string, unknown>;

interface Ctx {
  db: SupabaseClient;
  user: DbUser;
  body: Body;
  today: string;
}

const routes: Record<string, (ctx: Ctx) => Promise<unknown>> = {
  /* 1. Инициализация: пользователь + активный период (или null) */
  "init": async ({ db, user, today }) => {
    const period = await periodOn(db, user.id, today);
    return {
      user: { id: user.id, username: user.username, first_name: user.first_name },
      period,
    };
  },

  /* 2. Текущий финансовый период */
  "period/current": async ({ db, user, today }) => ({
    period: await periodOn(db, user.id, today),
  }),

  /* 3. Создание периода после онбординга, либо правка периода из «Настр.»,
        либо продление после «Период закончился».
        Если клиент явно называет period_id (правит конкретный период —
        текущий активный) — обновляем только его, без угадывания по датам.
        Иначе (первый онбординг или продление disjoint-датами) ищем период,
        пересекающийся с новым диапазоном, и обновляем его — это на случай
        повторной отправки тех же дат, не более того. */
  "period/create": async ({ db, user, body }) => {
    const start_date = asDate(body.start_date, "start_date");
    const end_date = asDate(body.end_date, "end_date");
    if (end_date <= start_date) {
      throw new BadRequest("Дата конца должна быть позже начала");
    }
    const days = dayCount(start_date, end_date);
    if (days > 366) throw new BadRequest("Период не может быть длиннее года");

    const income = asMoney(body.income, "income");
    const fixed_expenses = asMoney(body.fixed_expenses, "fixed_expenses");
    const savings = asMoney(body.savings ?? 0, "savings");

    // daily_budget считает сервер — клиент не может записать произвольное значение
    const free = Math.max(0, income - fixed_expenses - savings);
    const daily_budget = Math.round(free / days);
    const values = { start_date, end_date, income, fixed_expenses, daily_budget };

    let target: Period | null = null;
    if (body.period_id !== undefined && body.period_id !== null) {
      target = await ownedPeriod(db, user.id, asId(body.period_id, "period_id"));
    } else {
      const { data: overlap, error: ovErr } = await db
        .from("periods")
        .select(PERIOD_COLS)
        .eq("user_id", user.id)
        .lte("start_date", end_date)
        .gte("end_date", start_date)
        .order("start_date", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (ovErr) throw ovErr;
      target = (overlap as Period) ?? null;
    }

    if (target) {
      // Блокируем только те правки, что НОВОСТЬЮ отрывают траты — то есть
      // дата была внутри СТАРОГО диапазона периода, а после этой правки
      // выпадает из НОВОГО. Траты, уже осиротевшие раньше (например, из-за
      // более ранней правки до этой защиты), при этом не должны блокировать
      // все последующие сохранения периода намертво.
      const { data: newlyOrphaned, error: rangeErr } = await db
        .from("transactions")
        .select("transaction_date")
        .eq("period_id", target.id)
        .gte("transaction_date", target.start_date)
        .lte("transaction_date", target.end_date)
        .or(`transaction_date.lt.${start_date},transaction_date.gt.${end_date}`)
        .order("transaction_date", { ascending: true })
        .limit(1);
      if (rangeErr) throw rangeErr;
      if (newlyOrphaned && newlyOrphaned.length > 0) {
        throw new BadRequest(
          `В периоде есть траты за пределами новых дат (например, ${newlyOrphaned[0].transaction_date}). ` +
            `Сначала удалите их или не сужайте период так сильно.`,
        );
      }

      const { data, error } = await db
        .from("periods")
        .update(values)
        .eq("id", target.id)
        .eq("user_id", user.id)
        .select(PERIOD_COLS)
        .single();
      if (error) throw error;
      return { period: data, created: false };
    }

    const { data, error } = await db
      .from("periods")
      .insert({ user_id: user.id, ...values })
      .select(PERIOD_COLS)
      .single();
    if (error) throw error;
    return { period: data, created: true };
  },

  /* 4. Данные периода вместе с его транзакциями */
  "period/get": async ({ db, user, body, today }) => {
    const period = body.period_id === undefined || body.period_id === null
      ? await periodOn(db, user.id, today)
      : await ownedPeriod(db, user.id, asId(body.period_id, "period_id"));
    if (!period) return { period: null, transactions: [] };

    const { data, error } = await db
      .from("transactions")
      .select(TX_COLS)
      .eq("user_id", user.id)
      .eq("period_id", period.id)
      .order("transaction_date", { ascending: true })
      .order("id", { ascending: true });
    if (error) throw error;
    return { period, transactions: data ?? [] };
  },

  /* Все периоды пользователя с суммой трат — для экрана «История».
     Агрегируем в функции: новых объектов в БД не создаём. */
  "period/list": async ({ db, user }) => {
    const { data: periods, error } = await db
      .from("periods")
      .select(PERIOD_COLS)
      .eq("user_id", user.id)
      .order("start_date", { ascending: false });
    if (error) throw error;

    const { data: sums, error: sumErr } = await db
      .from("transactions")
      .select("period_id,amount,type,transaction_date")
      .eq("user_id", user.id);
    if (sumErr) throw sumErr;

    const periodsById = new Map((periods ?? []).map((p: Period) => [p.id, p]));
    const spent = new Map<number, number>();
    for (const t of sums ?? []) {
      // при переносе дат периода через period/create старые траты могут
      // остаться привязаны к period_id, но вне нового диапазона дат —
      // такие в общую сумму периода не считаем
      const p = periodsById.get(t.period_id);
      if (!p || t.transaction_date < p.start_date || t.transaction_date > p.end_date) continue;
      const sign = t.type === "income" ? -1 : 1;
      spent.set(t.period_id, (spent.get(t.period_id) ?? 0) + sign * Number(t.amount));
    }

    return {
      periods: (periods ?? []).map((p: Period) => ({
        ...p,
        total_spent: spent.get(p.id) ?? 0,
      })),
    };
  },

  /* 5. Создание транзакции */
  "transaction/create": async ({ db, user, body, today }) => {
    const amount = asMoney(body.amount, "amount", { min: 0.01 });
    const description = asOptionalText(body.description, "description");
    const type = asTxType(body.type);
    const transaction_date = body.transaction_date === undefined
      ? today
      : asDate(body.transaction_date, "transaction_date");

    // период определяет сервер: по переданному id (с проверкой владельца)
    // либо по дате транзакции
    const period = body.period_id
      ? await ownedPeriod(db, user.id, asId(body.period_id, "period_id"))
      : await periodOn(db, user.id, transaction_date);
    if (!period) throw new BadRequest("Нет периода, в который попадает эта дата");

    const { data, error } = await db
      .from("transactions")
      .insert({
        user_id: user.id,
        period_id: period.id,
        type,
        amount,
        description,
        transaction_date,
      })
      .select(TX_COLS)
      .single();
    if (error) throw error;
    return { transaction: data };
  },

  /* 6. Транзакции текущего (или указанного) периода */
  "transaction/list": async ({ db, user, body, today }) => {
    const period = body.period_id === undefined || body.period_id === null
      ? await periodOn(db, user.id, today)
      : await ownedPeriod(db, user.id, asId(body.period_id, "period_id"));
    if (!period) return { period: null, transactions: [] };

    const { data, error } = await db
      .from("transactions")
      .select(TX_COLS)
      .eq("user_id", user.id)
      .eq("period_id", period.id)
      .order("transaction_date", { ascending: true })
      .order("id", { ascending: true });
    if (error) throw error;
    return { period, transactions: data ?? [] };
  },

  /* 7. Редактирование транзакции */
  "transaction/update": async ({ db, user, body }) => {
    const id = asId(body.id, "id");
    const patch: Record<string, unknown> = {};

    if (body.amount !== undefined) patch.amount = asMoney(body.amount, "amount", { min: 0.01 });
    if (body.description !== undefined) {
      patch.description = asOptionalText(body.description, "description");
    }
    if (body.type !== undefined) patch.type = asTxType(body.type);
    if (body.transaction_date !== undefined) {
      const transaction_date = asDate(body.transaction_date, "transaction_date");
      patch.transaction_date = transaction_date;
      // дата могла уехать в другой период — пересчитываем принадлежность
      const period = await periodOn(db, user.id, transaction_date);
      if (!period) throw new BadRequest("Нет периода, в который попадает эта дата");
      patch.period_id = period.id;
    }
    if (Object.keys(patch).length === 0) throw new BadRequest("Нечего обновлять");

    const { data, error } = await db
      .from("transactions")
      .update(patch)
      .eq("id", id)
      .eq("user_id", user.id) // чужую запись изменить нельзя
      .select(TX_COLS)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new BadRequest("Транзакция не найдена");
    return { transaction: data };
  },

  /* 8. Удаление транзакции */
  "transaction/delete": async ({ db, user, body }) => {
    const id = asId(body.id, "id");
    const { data, error } = await db
      .from("transactions")
      .delete()
      .eq("id", id)
      .eq("user_id", user.id)
      .select("id")
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new BadRequest("Транзакция не найдена");
    return { ok: true, id: data.id };
  },
};

/* ------------------------------------------------------------------ */
/*  Точка входа                                                        */
/* ------------------------------------------------------------------ */

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") {
    return json({ error: "Метод не поддерживается", code: "method_not_allowed" }, 405);
  }

  const path = new URL(req.url).pathname
    .replace(/^\/+/, "")
    .replace(/^functions\/v1\//, "")
    .replace(/^api\/?/, "")
    .replace(/\/+$/, "");

  const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN");
  if (!botToken) {
    console.error("TELEGRAM_BOT_TOKEN не задан в секретах проекта");
    return json({ error: "Сервер не настроен", code: "not_configured" }, 500);
  }

  const handler = routes[path];
  if (!handler) {
    return json({ error: `Неизвестный маршрут: ${path || "/"}`, code: "not_found" }, 404);
  }

  let tg: TelegramUser;
  try {
    tg = await verifyInitData(req.headers.get("X-Telegram-Init-Data") ?? "", botToken);
  } catch (e) {
    if (e instanceof InitDataError) {
      return json({ error: e.message, code: e.code }, 401);
    }
    console.error("Ошибка проверки initData:", e);
    return json({ error: "Не удалось проверить Telegram-данные", code: "auth_failed" }, 401);
  }

  let body: Body = {};
  if (req.headers.get("content-length") !== "0") {
    try {
      const raw = await req.text();
      if (raw) body = JSON.parse(raw);
    } catch {
      return json({ error: "Тело запроса не является JSON", code: "bad_json" }, 400);
    }
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return json({ error: "Тело запроса должно быть объектом", code: "bad_json" }, 400);
  }

  const db = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SB_SECRET_KEY")!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  try {
    const today = body.today === undefined ? serverToday() : asDate(body.today, "today");
    const user = await resolveUser(db, tg);
    const result = await handler({ db, user, body, today });
    return json(result);
  } catch (e) {
    if (e instanceof BadRequest) {
      return json({ error: e.message, code: "bad_request" }, 400);
    }
    console.error(`Ошибка в маршруте ${path}:`, e);
    return json({ error: "Внутренняя ошибка сервера", code: "server_error" }, 500);
  }
});
