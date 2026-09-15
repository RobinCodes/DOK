// Login page and the admin dashboard.

import { canAwardPoints, featureOn, hasRole, isSuperadmin } from '../../auth/roles.js';
import { localized } from '../../domain/catalog.js';
import { html } from '../../http/html.js';
import { csrfField, errorBox, flash, hidden } from '../components.js';

export function loginPage(ctx, { error = null, username = '', next = '/admin' } = {}) {
  const { t } = ctx;
  return html`
    <section class="narrow">
      <h1>${t('login.title')}</h1>
      ${errorBox(ctx, error)}
      <form method="post" action="/admin/login" class="stack">
        ${hidden('next', next)}
        <label class="field"><span>${t('login.username')}</span>
          <input name="username" value="${username}" autocomplete="username" autocapitalize="none" spellcheck="false" required maxlength="64"></label>
        <label class="field"><span>${t('login.password')}</span>
          <input type="password" name="password" autocomplete="current-password" required maxlength="256"></label>
        <button type="submit">${t('login.submit')}</button>
      </form>
    </section>`;
}

export function dashboardPage(ctx, { openPrograms, budgets, runningTimers, classCount }) {
  const { t, user, settings, lang } = ctx;
  const roleKey = `role.${user.role}`;
  return html`
    <h1>${t('dashboard.hello', { name: user.display_name })}</h1>
    <p class="muted">${t(roleKey)}${user.is_casino ? html` · ${t('role.casino')}` : ''}</p>
    ${flash(ctx)}
    ${isSuperadmin(user) && classCount === 0 ? html`<p class="notice warn">${t('dashboard.noClasses')} <a href="/admin/super?tab=classes">${t('dashboard.addClasses')}</a></p>` : ''}
    ${openPrograms.length === 0 ? html`<p class="notice">${t('dashboard.noOpenProgram')}</p>` : ''}

    ${canAwardPoints(user) && budgets.length
      ? html`
        <section class="section">
          <h2>${t('dashboard.budgets')}</h2>
          <div class="cards">
            ${budgets.map(
              (b) => html`
                <div class="card stat">
                  <span class="stat-label">${localized(b.program, 'name', lang)}</span>
                  <strong class="stat-value">${b.remaining}</strong>
                  <span class="muted">${t('dashboard.budgetOf', { allotted: b.allotted, spent: b.spent })}</span>
                </div>`,
            )}
          </div>
        </section>`
      : ''}

    <section class="section">
      <h2>${t('dashboard.quick')}</h2>
      <div class="actions">
        ${canAwardPoints(user) ? html`<a class="button" href="/admin/award">${t('nav.award')}</a>` : ''}
        ${canAwardPoints(user) && featureOn(settings, user, 'features.timer')
          ? html`<a class="button secondary" href="/admin/timers">${t('nav.timers')}${runningTimers ? html` (${runningTimers})` : ''}</a>`
          : ''}
        ${user.is_casino || isSuperadmin(user) ? html`<a class="button secondary" href="/admin/casino">${t('nav.casino')}</a>` : ''}
        ${hasRole(user, 'logadmin') ? html`<a class="button secondary" href="/admin/suspicion">${t('nav.suspicion')}</a>` : ''}
      </div>
    </section>

    ${canAwardPoints(user) && settings.get('features.timer')
      ? html`
        <section class="section">
          <h2>${t('account.title')}</h2>
          <form method="post" action="/admin/account/timer" class="inline-form">
            ${csrfField(ctx)}
            <span>${t('account.timer', { state: user.use_timer ? t('value.on') : t('value.off') })}</span>
            <button type="submit" class="secondary">${user.use_timer ? t('value.turnOff') : t('value.turnOn')}</button>
          </form>
        </section>`
      : ''}`;
}
