// Server-side sessions. The browser only holds a random token; the database
// stores its SHA-256 hash, so a leaked database copy can't be used to log in.
// The user row is re-read on every request, so deactivating an account or
// changing a role takes effect immediately.

import { createHash, randomBytes } from 'node:crypto';

export const SESSION_COOKIE = 'sid';

const hashToken = (token) => createHash('sha256').update(token).digest('hex');

const USER_COLUMNS = 'u.id, u.username, u.display_name, u.role, u.is_casino, u.class_id, u.use_timer, u.active';

export function createSession(db, userId, { hours, now }) {
  const token = randomBytes(32).toString('base64url');
  const csrf = randomBytes(32).toString('base64url');
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
  db.prepare('INSERT INTO sessions (token_hash, user_id, csrf_token, expires_at) VALUES (?, ?, ?, ?)').run(
    hashToken(token),
    userId,
    csrf,
    now + hours * 3_600_000,
  );
  return { token, maxAge: hours * 3600 };
}

export function findSession(db, token, now) {
  if (!token || token.length > 100) return null;
  const row = db
    .prepare(`
      SELECT s.csrf_token, ${USER_COLUMNS}
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1`)
    .get(hashToken(token), now);
  if (!row) return null;
  const { csrf_token: csrf, ...user } = row;
  return { user, csrf };
}

export function destroySession(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
}

export function destroyUserSessions(db, userId) {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}
