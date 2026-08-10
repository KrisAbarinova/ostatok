/**
 * Проверка подписи Telegram WebApp initData (HMAC по bot token).
 *
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 *
 * Алгоритм:
 *   dataCheckString = все полученные поля КРОМЕ hash, отсортированные по имени
 *                     ключа, в виде "key=value", склеенные через "\n"
 *   secretKey       = HMAC_SHA256(key="WebAppData", data=<bot_token>)  → RAW bytes
 *   calculatedHash  = hex_lower(HMAC_SHA256(key=secretKey, data=dataCheckString))
 *   calculatedHash сравнивается с полученным hash за постоянное время
 *
 * Важно про `signature`: с Bot API 7.10 Telegram добавляет в initData поле
 * signature (Ed25519-подпись для проверки третьей стороной). Из dataCheckString
 * оно исключается ТОЛЬКО при Ed25519-проверке. Для HMAC по bot token Telegram
 * считает хеш по всем полям кроме hash, поэтому signature обязано остаться —
 * иначе подпись не сойдётся на любом свежем клиенте.
 *
 * Декодирование выполняется ровно один раз — внутри URLSearchParams. Строка
 * initData целиком через decodeURIComponent не прогоняется: это испортило бы
 * значения, содержащие %, / и + (JSON в user, photo_url).
 *
 * Никакие поля initData не считаются доверенными, пока hash не сошёлся.
 */

export interface TelegramUser {
  id: number;
  username: string | null;
  first_name: string | null;
}

export class InitDataError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

/** Максимальный возраст initData. Telegram рекомендует отклонять устаревшие данные. */
const MAX_AGE_SECONDS = 24 * 60 * 60;

const encoder = new TextEncoder();

async function hmacSha256(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(data));
}

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Сравнение за постоянное время — не даёт подбирать hash по времени ответа. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Собирает dataCheckString и считает HMAC.
 * Единственное удаляемое поле — hash. Все прочие параметры, включая signature
 * и любые новые поля Telegram, остаются как есть.
 */
async function computeHash(
  initData: string,
  botToken: string,
): Promise<{ given: string | null; calculated: string }> {
  // URLSearchParams разбирает строку и декодирует каждое значение ровно один раз
  const params = new URLSearchParams(initData);
  const given = params.get("hash");
  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  // secretKey используется как сырые байты, не как hex или base64
  const secretKey = await hmacSha256(encoder.encode("WebAppData"), botToken);
  const calculated = toHex(await hmacSha256(new Uint8Array(secretKey), dataCheckString));

  return { given, calculated };
}

export async function verifyInitData(
  initData: string,
  botToken: string,
): Promise<TelegramUser> {
  if (!initData) {
    throw new InitDataError("no_init_data", "initData не передан");
  }

  const { given, calculated } = await computeHash(initData, botToken);
  if (!given) {
    throw new InitDataError("no_hash", "В initData нет поля hash");
  }
  if (!timingSafeEqual(calculated, given.toLowerCase())) {
    throw new InitDataError("bad_signature", "Подпись initData не совпала");
  }

  const params = new URLSearchParams(initData);

  const authDate = Number(params.get("auth_date") ?? 0);
  if (!Number.isFinite(authDate) || authDate <= 0) {
    throw new InitDataError("bad_auth_date", "Некорректный auth_date");
  }
  const age = Math.floor(Date.now() / 1000) - authDate;
  if (age > MAX_AGE_SECONDS) {
    throw new InitDataError("expired", "initData устарел, переоткройте приложение");
  }

  const rawUser = params.get("user");
  if (!rawUser) {
    throw new InitDataError("no_user", "В initData нет данных пользователя");
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawUser);
  } catch {
    throw new InitDataError("bad_user", "Не удалось разобрать данные пользователя");
  }

  const id = Number(parsed.id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new InitDataError("bad_user", "Некорректный Telegram user id");
  }

  const str = (v: unknown): string | null => {
    if (typeof v !== "string") return null;
    const t = v.trim();
    return t ? t.slice(0, 100) : null;
  };

  return { id, username: str(parsed.username), first_name: str(parsed.first_name) };
}
