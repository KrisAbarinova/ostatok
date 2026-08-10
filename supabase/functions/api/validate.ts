/** Валидация входных данных. Всё, что приходит от клиента, считается недоверенным. */

export class BadRequest extends Error {
  constructor(message: string) {
    super(message);
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function asDate(value: unknown, field: string): string {
  if (typeof value !== "string" || !DATE_RE.test(value)) {
    throw new BadRequest(`Поле ${field} должно быть датой в формате ГГГГ-ММ-ДД`);
  }
  const [y, m, d] = value.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (
    dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d
  ) {
    throw new BadRequest(`Поле ${field} содержит несуществующую дату`);
  }
  return value;
}

export function asMoney(value: unknown, field: string, { min = 0 } = {}): number {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) {
    throw new BadRequest(`Поле ${field} должно быть числом`);
  }
  if (n < min) {
    throw new BadRequest(`Поле ${field} не может быть меньше ${min}`);
  }
  if (n > 1e12) {
    throw new BadRequest(`Поле ${field} слишком большое`);
  }
  // до копеек — numeric в БД, но UI работает целыми рублями
  return Math.round(n * 100) / 100;
}

export function asId(value: unknown, field: string): number {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n <= 0) {
    throw new BadRequest(`Поле ${field} должно быть идентификатором записи`);
  }
  return n;
}

export function asOptionalText(
  value: unknown,
  field: string,
  maxLen = 200,
): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") {
    throw new BadRequest(`Поле ${field} должно быть строкой`);
  }
  const t = value.trim();
  if (!t) return null;
  if (t.length > maxLen) {
    throw new BadRequest(`Поле ${field} длиннее ${maxLen} символов`);
  }
  return t;
}

const TX_TYPES = new Set(["expense", "income"]);

export function asTxType(value: unknown): string {
  if (value === null || value === undefined || value === "") return "expense";
  if (typeof value !== "string" || !TX_TYPES.has(value)) {
    throw new BadRequest("Поле type должно быть expense или income");
  }
  return value;
}

/** Число дней в периоде включительно. Считаем в UTC, чтобы не зависеть от часового пояса. */
export function dayCount(start: string, end: string): number {
  const [ys, ms, ds] = start.split("-").map(Number);
  const [ye, me, de] = end.split("-").map(Number);
  const a = Date.UTC(ys, ms - 1, ds);
  const b = Date.UTC(ye, me - 1, de);
  return Math.round((b - a) / 86400000) + 1;
}
