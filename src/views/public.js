// Public pages: the event homepage, the privacy notice and error pages.

import { localized } from '../domain/catalog.js';
import { formatDateTime } from '../domain/time.js';
import { html } from '../http/html.js';
import { formatNumber } from './components.js';

function facts(t) {
  const items = [
    ['home.start', 'home.startValue'],
    ['home.end', 'home.endValue'],
    ['home.grades', 'home.gradesValue'],
    ['home.prize', 'home.prizeValue'],
  ];
  return html`
    <dl class="facts">
      ${items.map(([label, value]) => html`<div class="fact"><dt>${t(label)}</dt><dd>${t(value)}</dd></div>`)}
    </dl>`;
}

function standings(ctx, snapshot) {
  const { t, lang } = ctx;
  if (!snapshot || snapshot.rows.length === 0) return '';
  return html`
    <section class="section" aria-labelledby="standings-title">
      <h2 id="standings-title">${t('home.standingsTitle', { n: snapshot.rows.length })}</h2>
      <p class="muted">${snapshot.label ? html`${snapshot.label} · ` : ''}${t('home.publishedAt', { time: formatDateTime(snapshot.created_at, lang) })}</p>
      <ol class="standings">
        ${snapshot.rows.map(
          (row) => html`
            <li class="${row.rank === 1 ? 'first' : ''}">
              <span class="rank">${row.rank}.</span>
              <span class="class-name">${row.name}</span>
              <span class="points">${formatNumber(row.points, lang)} ${t('home.pointsShort')}</span>
            </li>`,
        )}
      </ol>
    </section>`;
}

export function homePage(ctx, { programs, snapshot }) {
  const { t, lang, settings } = ctx;
  return html`
    <section class="hero">
      <p class="eyebrow">${t('home.eyebrow')}</p>
      <h1>${t('home.title')}</h1>
      <p class="lead">${t('home.lead')}</p>
      ${facts(t)}
    </section>

    ${settings.get('site.show_standings') ? standings(ctx, snapshot) : ''}

    ${settings.get('site.show_programs')
      ? html`
        <section class="section" aria-labelledby="programs-title">
          <h2 id="programs-title">${t('home.programsTitle')}</h2>
          <div class="programs">
            ${programs.map(
              (p) => html`
                <article class="program">
                  <header>
                    <h3>${localized(p, 'name', lang)}</h3>
                    <p class="when">${localized(p, 'when', lang) || t('home.whenTba')}</p>
                  </header>
                  <p>${localized(p, 'description', lang)}</p>
                </article>`,
            )}
          </div>
        </section>`
      : ''}

    <section class="section notes">
      <ul>
        <li>${t('home.noteInfo')}</li>
        <li>${t('home.noteTop', { n: settings.get('site.standings_top') })}</li>
        <li>${t('home.noteFun')}</li>
      </ul>
    </section>`;
}

export function privacyPage(ctx) {
  const { t } = ctx;
  const sections = ['who', 'what', 'why', 'visibility', 'where', 'retention', 'rights'];
  return html`
    <article class="prose">
      <h1>${t('privacy.title')}</h1>
      ${sections.map((s) => html`<h2>${t(`privacy.${s}.title`)}</h2><p>${t(`privacy.${s}.text`)}</p>`)}
    </article>`;
}

export function errorPage(ctx, error) {
  const { t } = ctx;
  const key = t.has(error.messageKey) ? error.messageKey : `error.${error.status}`;
  return html`
    <section class="error-page">
      <p class="eyebrow">${error.status}</p>
      <h1>${t(t.has(key) ? key : 'error.500', error.vars)}</h1>
      <p><a href="${ctx.url.pathname.startsWith('/admin') ? '/admin' : '/'}">${t('error.back')}</a></p>
    </section>`;
}
