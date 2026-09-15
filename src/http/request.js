// Request parsing helpers: cookies, form bodies and the client IP.

import { HttpError } from './errors.js';

export const MAX_BODY_BYTES = 64 * 1024;

export function parseCookies(header = '') {
  const cookies = {};
  for (const raw of header.split(';')) {
    const part = raw.trim();
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }
  return cookies;
}

/** Reads an application/x-www-form-urlencoded body into URLSearchParams. */
export async function readForm(req, limit = MAX_BODY_BYTES) {
  const type = (req.headers['content-type'] || '').split(';')[0].trim();
  if (type !== 'application/x-www-form-urlencoded') throw new HttpError(415);
  const declared = Number(req.headers['content-length']);
  if (declared > limit) throw new HttpError(413);

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413);
    chunks.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

/** Client IP; X-Forwarded-For is only trusted when the app sits behind our own nginx. */
export function clientIp(req, trustProxy) {
  if (trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress || '';
}

/** CSRF defense layer 1: a POST must come from a page of this same site. */
export function isSameOrigin(req) {
  const source = req.headers.origin || req.headers.referer;
  if (!source) return false;
  try {
    return new URL(source).host === req.headers.host;
  } catch {
    return false;
  }
}
