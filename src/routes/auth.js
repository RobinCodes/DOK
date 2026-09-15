// Login and logout (Rulebook §2.1).

import { verifyAgainstDummy, verifyPassword } from '../auth/passwords.js';
import { createSession, destroySession, SESSION_COOKIE } from '../auth/sessions.js';
import { ANONYMOUS, audit } from '../domain/audit.js';
import { ValidationError } from '../http/errors.js';
import { redirect, safeLocalPath, setCookie } from '../http/response.js';
import { loginPage } from '../views/admin/home.js';
import { render } from './helpers.js';

function nextPath(value) {
  const path = safeLocalPath(value, '/admin');
  return path.startsWith('/admin') && !path.startsWith('/admin/login') ? path : '/admin';
}

export function registerAuthRoutes(router) {
  router.get('/admin/login', (ctx) => {
    if (ctx.user) return redirect(ctx.res, '/admin');
    render(ctx, loginPage(ctx, { next: nextPath(ctx.url.searchParams.get('next')) }), { title: ctx.t('login.title'), admin: false });
  });

  router.post('/admin/login', async (ctx) => {
    const { db, settings, throttle, form } = ctx;
    const username = String(form.get('username') ?? '').trim().slice(0, 64);
    const password = String(form.get('password') ?? '').slice(0, 256);
    const next = nextPath(form.get('next'));
    const fail = (key, status) =>
      render(ctx, loginPage(ctx, { error: new ValidationError(key), username, next }), { title: ctx.t('login.title'), status, admin: false });

    const userKey = `user:${username.toLowerCase()}`;
    const ipKey = `ip:${ctx.ip}`;
    const maxFailures = settings.get('auth.max_failures');
    // Organizers on the same school Wi-Fi share one IP address, so it may fail five times as often.
    const limits = [
      { key: userKey, max: maxFailures },
      { key: ipKey, max: maxFailures * 5 },
    ];
    const window = { windowMs: settings.get('auth.lockout_minutes') * 60_000, now: ctx.nowMs };
    if (throttle.isBlocked(limits, ctx.nowMs)) {
      audit(db, { actor: ANONYMOUS, action: 'auth.blocked', details: { username }, ip: ctx.ip, at: ctx.now });
      return fail('error.tooManyAttempts', 429);
    }

    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    const valid = user ? await verifyPassword(password, user.password_hash) : await verifyAgainstDummy(password);
    if (!valid || !user.active) {
      throttle.recordFailure([userKey, ipKey], window);
      audit(db, { actor: ANONYMOUS, action: 'auth.failed', details: { username }, ip: ctx.ip, at: ctx.now });
      return fail('error.badLogin', 401);
    }
    if (user.role !== 'superadmin' && !settings.get('features.logins')) return fail('error.loginsDisabled', 403);

    throttle.reset(userKey);
    const session = createSession(db, user.id, { hours: settings.get('auth.session_hours'), now: ctx.nowMs });
    setCookie(ctx.res, SESSION_COOKIE, session.token, { maxAge: session.maxAge, secure: ctx.config.cookieSecure });
    audit(db, { actor: user, action: 'auth.login', ip: ctx.ip, at: ctx.now });
    redirect(ctx.res, next);
  });

  router.post('/admin/logout', (ctx) => {
    if (ctx.user) {
      destroySession(ctx.db, ctx.cookies[SESSION_COOKIE]);
      audit(ctx.db, { actor: ctx.user, action: 'auth.logout', ip: ctx.ip, at: ctx.now });
    }
    setCookie(ctx.res, SESSION_COOKIE, '', { maxAge: 0, secure: ctx.config.cookieSecure });
    redirect(ctx.res, '/');
  });
}
