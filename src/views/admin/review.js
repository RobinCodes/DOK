// Review screens for log admins: event log, suspicion report and live standings.

import { isSuperadmin } from '../../auth/roles.js';
import { localized } from '../../domain/catalog.js';
import { formatDateTime } from '../../domain/time.js';
import { html } from '../../http/html.js';
import { badge, csrfField, emptyState, field, flash, formatNumber, selectField } from '../components.js';

export function logPage(ctx, { rows, chain, actions, actors, filters, nextBefore }) {
  const { t, lang } = ctx;
  return html`
    <h1>${t('log.title')}</h1>
    <p class="notice ${chain.ok ? 'ok' : 'error'}">
      ${chain.ok ? t('log.chainOk', { n: chain.count }) : t('log.chainBroken', { id: chain.brokenAt })}
    </p>
    <form method="get" action="/admin/log" class="filters">
      ${selectField({ label: t('log.action'), name: 'action', options: actions.map((a) => ({ value: a, label: a })), value: filters.action, placeholder: t('log.any') })}
      ${selectField({ label: t('log.actor'), name: 'actor', options: actors.map((a) => ({ value: a, label: a })), value: filters.actor, placeholder: t('log.any') })}
      <button type="submit" class="secondary">${t('log.filter')}</button>
    </form>
    ${rows.length === 0 ? emptyState(t('log.none')) : ''}
    <ul class="records log">
      ${rows.map(
        (r) => html`
          <li class="record">
            <div class="record-main"><code>${r.action}</code> <span>${r.subject}</span></div>
            <div class="record-meta muted">#${r.id} · ${formatDateTime(r.created_at, lang)} · ${r.actor}${r.ip ? html` · ${r.ip}` : ''}</div>
            <pre class="details">${JSON.stringify(JSON.parse(r.details), null, 1)}</pre>
          </li>`,
      )}
    </ul>
    ${nextBefore ? html`<p><a class="button secondary" href="/admin/log?${new URLSearchParams({ ...filters, before: nextBefore })}">${t('log.older')}</a></p>` : ''}`;
}

function itemSummary(ctx, item) {
  const { t, lang } = ctx;
  const r = item.row;
  if (item.type === 'entry') {
    const reason = r.reason_id ? localized({ name_hu: r.reason_hu, name_en: r.reason_en }, 'name', lang) : t(`source.${r.source}`);
    return html`
      <div class="record-main">
        <strong class="amount">${r.amount > 0 ? '+' : ''}${r.amount}</strong>
        <span>${r.class_name}${r.person_name ? html` · ${r.person_name}` : ''}</span>
        ${r.voided_at ? badge(t('entries.voided'), 'danger') : ''}
      </div>
      <div class="record-meta muted">${t('suspicion.entry')} #${r.id} · ${reason} · ${r.creator} · ${formatDateTime(r.created_at, lang)}</div>`;
  }
  if (item.type === 'cashout') {
    return html`
      <div class="record-main"><strong class="amount">${r.chips}</strong><span>${r.person_name} · ${r.class_name}</span></div>
      <div class="record-meta muted">${t('suspicion.cashout')} #${r.id} · ${r.creator} · ${formatDateTime(r.created_at, lang)}</div>`;
  }
  return html`
    <div class="record-main"><span>${localized({ name_hu: r.game_hu, name_en: r.game_en }, 'name', lang)}</span></div>
    <div class="record-meta muted">${t('suspicion.round')} #${r.id} · ${r.creator} · ${formatDateTime(r.created_at, lang)}</div>`;
}

export function suspicionPage(ctx, { programs, programId, items, threshold }) {
  const { t, lang } = ctx;
  const flagged = items.filter((i) => i.score >= threshold).length;
  return html`
    <h1>${t('suspicion.title')}</h1>
    <p class="muted">${t('suspicion.intro')}</p>
    <form method="get" action="/admin/suspicion" class="filters">
      ${selectField({ label: t('suspicion.program'), name: 'program', options: programs.map((p) => ({ value: p.id, label: localized(p, 'name', lang) })), value: programId ?? '', placeholder: t('suspicion.allPrograms') })}
      <button type="submit" class="secondary">${t('log.filter')}</button>
    </form>
    <p class="notice ${flagged ? 'warn' : 'ok'}">${t('suspicion.summary', { n: items.length, flagged, threshold })}</p>
    ${items.length === 0 ? emptyState(t('suspicion.none')) : ''}
    <ul class="records">
      ${items.map(
        (item) => html`
          <li class="record ${item.score >= threshold ? 'flagged' : ''}">
            <div class="score" aria-label="${t('suspicion.score')}">${item.score}</div>
            ${itemSummary(ctx, item)}
            ${item.factors.length
              ? html`<ul class="factors">${item.factors.map((f) => html`<li>${t(f.key, f.vars)} <small>(${t(`detector.${f.detector}`)} · ${Math.round(f.strength * 100)}%)</small></li>`)}</ul>`
              : ''}
          </li>`,
      )}
    </ul>`;
}

export function standingsPage(ctx, { rows, snapshots }) {
  const { t, lang, user } = ctx;
  return html`
    <h1>${t('standings.title')}</h1>
    ${flash(ctx)}
    <ol class="standings">
      ${rows.map(
        (row) => html`
          <li class="${row.rank === 1 ? 'first' : ''}">
            <span class="rank">${row.rank}.</span><span class="class-name">${row.name}</span>
            <span class="points">${formatNumber(row.points, lang)} ${t('home.pointsShort')}</span>
          </li>`,
      )}
    </ol>
    ${rows.length === 0 ? emptyState(t('standings.noClasses')) : ''}
    ${isSuperadmin(user)
      ? html`
        <section class="section">
          <h2>${t('standings.publish')}</h2>
          <p class="hint">${t('standings.publishHint')}</p>
          <form method="post" action="/admin/super/snapshots" class="stack">
            ${csrfField(ctx)}
            ${field({ label: t('standings.label'), name: 'label', attrs: html`maxlength="80"` })}
            <button type="submit">${t('standings.publishButton')}</button>
          </form>
          ${snapshots.length ? html`<p class="muted">${t('standings.lastPublished', { time: formatDateTime(snapshots[0].created_at, lang) })} · <a href="/admin/super?tab=snapshots">${t('standings.manage')}</a></p>` : ''}
        </section>`
      : ''}`;
}
