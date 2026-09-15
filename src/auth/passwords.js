// Password hashing with scrypt (memory-hard, built into Node).
// Stored format: scrypt$N$r$p$salt$hash (base64), so the cost can be raised
// later without breaking existing accounts.

import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

export const MIN_PASSWORD_LENGTH = 10;
export const DEFAULT_COST = 32768;
const MAX_MEM = 64 * 1024 * 1024;

function derive(password, salt, length, N, r, p) {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFC'), salt, length, { N, r, p, maxmem: MAX_MEM }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function hashPassword(password, N = DEFAULT_COST) {
  const salt = randomBytes(16);
  const key = await derive(password, salt, 64, N, 8, 1);
  return ['scrypt', N, 8, 1, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password, stored) {
  const [scheme, N, r, p, salt, hash] = String(stored).split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  try {
    const expected = Buffer.from(hash, 'base64');
    // A corrupted hash could decode to 0 bytes, and two empty buffers compare as equal.
    if (expected.length < 32) return false;
    const key = await derive(password, Buffer.from(salt, 'base64'), expected.length, Number(N), Number(r), Number(p));
    return timingSafeEqual(expected, key);
  } catch {
    return false;
  }
}

let dummyHash;
/** Spends the same time as a real check, so a missing username can't be detected by timing. */
export async function verifyAgainstDummy(password) {
  dummyHash ??= await hashPassword('dummy-password-for-timing');
  await verifyPassword(password, dummyHash);
  return false;
}
