// The request handler: builds a context for each request, enforces the
// cross-site request forgery (CSRF) checks, runs the matching route and renders errors.

import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { findSession, SESSION_COOKIE } from './auth/sessions.js';
import { createThrottle } from './auth/throttle.js';
import { createSettings } from './domain/settings.js';
import { HttpError } from './http/errors.js';
import { clientIp, isSameOrigin, parseCookies, readForm } from './http/request.js';
import { applySecurityHeaders, redirect, send } from './http/response.js';
import { createRouter } from './http/router.js';
import { loadStaticFiles } from './http/static.js';
import { detectLanguage, translator } from './i18n/index.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerCasinoRoutes } from './routes/casino.js';
import { registerPublicRoutes } from './routes/public.js';
import { registerReviewRoutes } from './routes/review.js';
import { registerSuperRoutes } from './routes/super.js';
import { layout } from './views/layout.js';
import { errorPage } from './views/public.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));

function sameToken(a, b) {
  const left = Buffer.from(String(a ?? ''));
  const right = Buffer.from(String(b ?? ''));
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

export function createApp({ db, config, clock = Date.now }) {
  const services = { db, config, clock, settings: createSettings(db), throttle: createThrottle(), staticFiles: loadStaticFiles(PUBLIC_DIR) };
  const router = createRouter();
  for (const register of [registerPublicRoutes, registerAuthRoutes, registerAdminRoutes, registerCasinoRoutes, registerReviewRoutes, registerSuperRoutes]) {
    register(router);
  }

  function renderError(ctx, err) {
    if (ctx.res.headersSent) {
      ctx.res.end();
      return;
    }
    let error = err;
    if (!(err instanceof HttpError)) {
      console.error(err);
      error = new HttpError(500);
    }
    if (error.status === 401) {
      redirect(ctx.res, `/admin/login?next=${encodeURIComponent(ctx.url.pathname + ctx.url.search)}`);
      return;
    }
    const admin = ctx.url.pathname.startsWith('/admin') && Boolean(ctx.user);
    send(ctx.res, error.status, layout(ctx, { title: ctx.t(`error.${error.status}`), body: errorPage(ctx, error), admin }));
  }

  return async function handle(req, res) {
    applySecurityHeaders(res);
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      url = new URL('http://localhost/');
    }
    const cookies = parseCookies(req.headers.cookie);
    const lang = detectLanguage(cookies.lang, req.headers['accept-language']);
    const nowMs = clock();
    const ctx = {
      ...services,
      req,
      res,
      url,
      cookies,
      lang,
      t: translator(lang),
      theme: ['light', 'dark'].includes(cookies.theme) ? cookies.theme : null,
      ip: clientIp(req, config.trustProxy),
      nowMs,
      now: new Date(nowMs).toISOString(),
      user: null,
      csrf: null,
      params: {},
      form: new URLSearchParams(),
    };

    try {
      const session = findSession(db, cookies[SESSION_COOKIE], nowMs);
      ctx.user = session?.user ?? null;
      ctx.csrf = session?.csrf ?? null;

      const match = router.match(req.method, url.pathname);
      if (!match) throw new HttpError(404);
      if (match.methodNotAllowed) throw new HttpError(405);
      ctx.params = match.params;

      if (req.method === 'POST') {
        // Layer 1: the form must be posted from this site. Layer 2: a logged-in
        // user's form must carry their session's secret token.
        if (!isSameOrigin(req)) throw new HttpError(403, 'error.csrf');
        ctx.form = await readForm(req);
        if (ctx.user && !sameToken(ctx.form.get('csrf'), ctx.csrf)) throw new HttpError(403, 'error.csrf');
      }

      for (const handler of match.handlers) {
        await handler(ctx);
        if (res.writableEnded) return;
      }
      throw new Error(`No response for ${req.method} ${url.pathname}`);
    } catch (err) {
      renderError(ctx, err);
    }
  };
}
