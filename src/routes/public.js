// Public routes: homepage, privacy notice, preferences, static files, health check.

import { HttpError } from '../http/errors.js';
import { redirect, safeLocalPath, send, setCookie } from '../http/response.js';
import { serveStatic } from '../http/static.js';
import { LANGUAGES } from '../i18n/index.js';
import { latestPublicSnapshot } from '../domain/standings.js';
import { homePage, privacyPage } from '../views/public.js';
import { render } from './helpers.js';

const ONE_YEAR = 365 * 24 * 3600;

export function registerPublicRoutes(router) {
  router.get('/', (ctx) => {
    const programs = ctx.db.prepare('SELECT * FROM programs WHERE public = 1 ORDER BY sort, id').all();
    const snapshot = latestPublicSnapshot(ctx.db, ctx.settings.get('site.standings_top'));
    render(ctx, homePage(ctx, { programs, snapshot }), { admin: false });
  });

  router.get('/privacy', (ctx) => {
    if (!ctx.settings.get('site.show_privacy')) throw new HttpError(404);
    render(ctx, privacyPage(ctx), { title: ctx.t('privacy.title'), admin: false });
  });

  router.get('/lang/:code', (ctx) => {
    if (!LANGUAGES.includes(ctx.params.code)) throw new HttpError(404);
    setCookie(ctx.res, 'lang', ctx.params.code, { maxAge: ONE_YEAR, secure: ctx.config.cookieSecure });
    redirect(ctx.res, safeLocalPath(ctx.url.searchParams.get('back')));
  });

  router.get('/theme/:mode', (ctx) => {
    if (!['light', 'dark'].includes(ctx.params.mode)) throw new HttpError(404);
    setCookie(ctx.res, 'theme', ctx.params.mode, { maxAge: ONE_YEAR, secure: ctx.config.cookieSecure });
    redirect(ctx.res, safeLocalPath(ctx.url.searchParams.get('back')));
  });

  router.get('/static/:file', (ctx) => {
    if (!serveStatic(ctx.staticFiles, ctx.params.file, ctx.res)) throw new HttpError(404);
  });

  router.get('/robots.txt', (ctx) => {
    send(ctx.res, 200, 'User-agent: *\nDisallow: /admin\n', 'text/plain; charset=utf-8');
  });

  router.get('/healthz', (ctx) => {
    ctx.db.prepare('SELECT 1').get();
    send(ctx.res, 200, 'ok', 'text/plain; charset=utf-8');
  });
}
