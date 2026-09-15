// Shared route helpers: permission guards, page rendering and form parsing.

import { canAwardPoints, featureOn, hasRole, isCasinoStaff, isSuperadmin } from '../auth/roles.js';
import { NeedsConfirmation } from '../domain/rules/index.js';
import { HttpError, ValidationError } from '../http/errors.js';
import { redirect, safeLocalPath, send } from '../http/response.js';
import { layout } from '../views/layout.js';

export function requireUser(ctx) {
  if (!ctx.user) throw new HttpError(401);
}

export const requireRole = (role) => (ctx) => {
  requireUser(ctx);
  if (!hasRole(ctx.user, role)) throw new HttpError(403);
};

/** Module switches apply to everyone but the superadmin (see auth/roles.js). */
export const requireFeature = (key) => (ctx) => {
  if (!featureOn(ctx.settings, ctx.user, key)) throw new HttpError(403, 'error.featureOff');
};

export function requireAwarder(ctx) {
  requireUser(ctx);
  if (!canAwardPoints(ctx.user)) throw new HttpError(403, 'error.casinoCannotAward');
}

export function requireCasinoStaff(ctx) {
  requireUser(ctx);
  if (!isCasinoStaff(ctx.user) && !isSuperadmin(ctx.user)) throw new HttpError(403, 'error.casinoStaffOnly');
}

export function render(ctx, body, { title = '', status = 200, admin = true } = {}) {
  send(ctx.res, status, layout(ctx, { title, body, admin }));
}

/** Redirects to a local path, adding a success message key (and optional number) before any #anchor. */
export function redirectWithFlash(ctx, path, key, n = null) {
  const url = new URL(safeLocalPath(path, '/admin'), 'http://localhost');
  url.searchParams.set('ok', key);
  if (n !== null && n !== undefined) url.searchParams.set('n', String(n));
  redirect(ctx.res, url.pathname + url.search + url.hash);
}

/**
 * Runs a write. Rule problems are shown on the form again (with the typed
 * values kept) instead of an error page; anything else propagates.
 */
export function attempt(action, onProblem) {
  try {
    return { ok: true, result: action() };
  } catch (err) {
    if (err instanceof NeedsConfirmation) return { ok: false, response: onProblem({ warnings: err.warnings }, 200) };
    if (err instanceof ValidationError) return { ok: false, response: onProblem({ error: err }, 400) };
    throw err;
  }
}

/** Reads "prefix[name]" fields into { name: value }. */
export function formMap(form, prefix) {
  const values = {};
  for (const [key, value] of form) {
    const m = key.match(/^([a-z]+)\[([a-z][a-z0-9_]*)\]$/);
    if (m && m[1] === prefix) values[m[2]] = value;
  }
  return values;
}

/** Reads "prefix[i][field]" fields into an array of rows. */
export function formRows(form, prefix, fields, count) {
  return Array.from({ length: count }, (_, i) => Object.fromEntries(fields.map((f) => [f, form.get(`${prefix}[${i}][${f}]`) ?? ''])));
}

/** The form's idempotency key, if it has the expected shape. */
export function nonceOf(form) {
  const nonce = form.get('nonce');
  return /^[0-9a-f-]{36}$/.test(nonce ?? '') ? nonce : null;
}

export function idParam(value) {
  if (!/^\d{1,15}$/.test(String(value ?? ''))) throw new HttpError(404);
  return Number(value);
}
