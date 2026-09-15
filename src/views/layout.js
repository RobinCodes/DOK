// Page shell shared by the public site and the admin panel.

import { canAwardPoints, featureOn, hasRole, isCasinoStaff, isSuperadmin } from '../auth/roles.js';
import { html } from '../http/html.js';
import { assetUrl } from '../http/static.js';

function backParam(ctx) {
  return encodeURIComponent(ctx.url.pathname + ctx.url.search);
}

function preferences(ctx) {
  const { t, lang } = ctx;
  const other = lang === 'hu' ? 'en' : 'hu';
  const nextTheme = ctx.theme === 'dark' ? 'light' : 'dark';
  return html`
    <nav class="prefs" aria-label="${t('nav.preferences')}">
      <a href="/lang/${other}?back=${backParam(ctx)}" lang="${other}" hreflang="${other}">${t('nav.otherLanguage')}</a>
      <a href="/theme/${nextTheme}?back=${backParam(ctx)}" aria-label="${t('nav.theme')}" title="${t('nav.theme')}">◐</a>
    </nav>`;
}

function adminNav(ctx) {
  const { t, user, settings } = ctx;
  const link = (href, key) => {
    const current = ctx.url.pathname === href || (href !== '/admin' && ctx.url.pathname.startsWith(`${href}/`));
    return html`<a href="${href}" ${current ? html`aria-current="page"` : ''}>${t(key)}</a>`;
  };
  const casinoOn = featureOn(settings, user, 'casino.enabled');
  return html`
    <nav class="admin-nav" aria-label="${t('nav.admin')}">
      ${link('/admin', 'nav.dashboard')}
      ${canAwardPoints(user) ? link('/admin/award', 'nav.award') : ''}
      ${canAwardPoints(user) && featureOn(settings, user, 'features.timer') ? link('/admin/timers', 'nav.timers') : ''}
      ${canAwardPoints(user) ? link('/admin/entries', 'nav.entries') : ''}
      ${(isCasinoStaff(user) || isSuperadmin(user)) && casinoOn ? link('/admin/casino', 'nav.casino') : ''}
      ${hasRole(user, 'logadmin') || featureOn(settings, user, 'features.live_standings') ? link('/admin/standings', 'nav.standings') : ''}
      ${hasRole(user, 'logadmin') && featureOn(settings, user, 'features.log') ? link('/admin/log', 'nav.log') : ''}
      ${hasRole(user, 'logadmin') && featureOn(settings, user, 'features.suspicion') ? link('/admin/suspicion', 'nav.suspicion') : ''}
      ${isSuperadmin(user) ? link('/admin/super', 'nav.super') : ''}
      <form method="post" action="/admin/logout" class="inline">
        <input type="hidden" name="csrf" value="${ctx.csrf}">
        <button type="submit" class="link">${t('nav.logout')}</button>
      </form>
    </nav>`;
}

export function layout(ctx, { title, body, admin = false }) {
  const { t, lang } = ctx;
  return html`<!doctype html>
<html lang="${lang}"${ctx.theme ? html` data-theme="${ctx.theme}"` : ''}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${title ? `${title} · ` : ''}${t('site.name')}</title>
<meta name="description" content="${t('site.description')}">
<link rel="icon" href="${assetUrl(ctx.staticFiles, 'favicon.svg')}" type="image/svg+xml">
<link rel="stylesheet" href="${assetUrl(ctx.staticFiles, 'style.css')}">
<script src="${assetUrl(ctx.staticFiles, 'app.js')}" defer></script>
</head>
<body class="${admin ? 'admin' : 'public'}">
<a class="skip" href="#main">${t('nav.skip')}</a>
<header class="topbar">
  <div class="wrap topbar-inner">
    <a class="brand" href="${admin ? '/admin' : '/'}">szigzug<span class="brand-mark">125</span></a>
    ${preferences(ctx)}
  </div>
  ${admin && ctx.user ? html`<div class="wrap">${adminNav(ctx)}</div>` : ''}
</header>
<main id="main" class="wrap">
${body}
</main>
<footer class="wrap footer">
  <span>${t('footer.organizer')}</span>
  ${!admin && ctx.settings.get('site.show_privacy') ? html`<a href="/privacy">${t('footer.privacy')}</a>` : ''}
  ${admin ? html`<a href="/">${t('footer.publicSite')}</a>` : html`<a href="/admin">${t('footer.admin')}</a>`}
</footer>
</body>
</html>`;
}
