import { randomBytes, randomInt, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";

const SCRYPT_N = 32_768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;
const MAX_MEMORY = 128 * 1024 * 1024;
const MAX_PASSWORD_LENGTH = 128;
export const MIN_PASSWORD_LENGTH = 10;

const COMMON_PASSWORDS = new Set([
  "password",
  "password1",
  "password123",
  "1234567890",
  "12345678",
  "qwerty123",
  "admin12345",
  "batawil123",
  "batawil2025",
  "welcome123",
  "letmein123",
  "iloveyou123",
]);

function derive(password: string, salt: Buffer, keyLength: number, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keyLength, { N: n, r, p, maxmem: MAX_MEMORY }, (error, derived) => {
      if (error) reject(error);
      else resolve(derived);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await derive(password, salt, KEY_LENGTH, SCRYPT_N, SCRYPT_R, SCRYPT_P);
  return ["scrypt", SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString("base64"), derived.toString("base64")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  if (n < 4096 || n > 131_072 || r < 1 || r > 16 || p < 1 || p > 4) return false;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4] ?? "", "base64");
    expected = Buffer.from(parts[5] ?? "", "base64");
  } catch {
    return false;
  }
  if (salt.length < 8 || expected.length < 32 || expected.length > 128) return false;
  try {
    const actual = await derive(password, salt, expected.length, n, r, p);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

let dummyHashPromise: Promise<string> | null = null;

export async function verifyAgainstDummyHash(password: string): Promise<void> {
  dummyHashPromise ??= hashPassword(randomBytes(24).toString("base64"));
  const hash = await dummyHashPromise;
  await verifyPassword(password, hash);
}

export interface PasswordCheck {
  ok: boolean;
  message?: string;
}

export function validatePasswordStrength(password: string, username: string): PasswordCheck {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, message: `كلمة المرور يجب أن تتكون من ${MIN_PASSWORD_LENGTH} أحرف على الأقل.` };
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return { ok: false, message: `كلمة المرور يجب ألا تتجاوز ${MAX_PASSWORD_LENGTH} حرفاً.` };
  }
  if (!/\p{L}/u.test(password)) {
    return { ok: false, message: "كلمة المرور يجب أن تحتوي على حرف واحد على الأقل." };
  }
  if (!/\d/.test(password)) {
    return { ok: false, message: "كلمة المرور يجب أن تحتوي على رقم واحد على الأقل." };
  }
  const normalized = password.toLowerCase();
  if (username && normalized.includes(username.toLowerCase())) {
    return { ok: false, message: "لا يمكن أن تحتوي كلمة المرور على اسم المستخدم." };
  }
  if (normalized.includes("batawil")) {
    return { ok: false, message: "لا يمكن استخدام اسم النظام داخل كلمة المرور." };
  }
  if (COMMON_PASSWORDS.has(normalized)) {
    return { ok: false, message: "كلمة المرور شائعة وسهلة التخمين. اختر كلمة مرور أقوى." };
  }
  return { ok: true };
}

const TEMP_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

export function generateTemporaryPassword(length = 14): string {
  for (;;) {
    let value = "";
    for (let i = 0; i < length; i += 1) {
      value += TEMP_ALPHABET[randomInt(TEMP_ALPHABET.length)];
    }
    if (/\p{L}/u.test(value) && /\d/.test(value)) return value;
  }
}
