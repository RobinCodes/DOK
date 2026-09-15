// Casino staff screens (Rulebook §5). What is shown depends on the modes the
// superadmin switched on: light (cash-outs only), visits, and detailed games.

import { isSuperadmin } from '../../auth/roles.js';
import { localized } from '../../domain/catalog.js';
import { formatTime } from '../../domain/time.js';
import { html } from '../../http/html.js';
import {
  badge,
  classOptions,
  csrfField,
  emptyState,
  errorBox,
  field,
  flash,
  hidden,
  nonceField,
  numberAttrs,
  postButton,
  selectField,
  warningBox,
} from '../components.js';

export const ROUND_ROWS = 8;

function modeSummary(ctx) {
  const { t, settings } = ctx;
  const mode = settings.get('casino.record_games') ? 'games' : settings.get('casino.record_visits') ? 'visits' : 'light';
  return html`<p class="muted">${t(`casino.mode.${mode}`)} · ${t('casino.startChips', { n: settings.get('casino.start_chips') })}</p>`;
}

function visitForm(ctx, { program, classes, form }) {
  const { t } = ctx;
  return html`
    <section class="section">
      <h2>${t('casino.newPlayer')}</h2>
      ${form.kind === 'visit' ? errorBox(ctx, form.error) : ''}
      <form method="post" action="/admin/casino/${program.id}/visit" class="stack" autocomplete="off">
        ${csrfField(ctx)}${nonceField(form.kind === 'visit' ? form.nonce : undefined)}
        ${selectField({ label: t('form.class'), name: 'classId', options: classOptions(classes), value: form.kind === 'visit' ? form.values.classId : '', required: true, placeholder: t('form.choose') })}
        ${field({ label: t('form.person'), name: 'name', value: form.kind === 'visit' ? form.values.name : '', required: true, attrs: html`maxlength="80"` })}
        ${form.kind === 'visit' ? warningBox(ctx, form.warnings) : ''}
        <button type="submit">${t('casino.giveStartChips', { n: ctx.settings.get('casino.start_chips') })}</button>
      </form>
    </section>`;
}

function lightCashoutForm(ctx, { program, classes, form }) {
  const { t } = ctx;
  const mine = form.kind === 'cashout';
  return html`
    <section class="section">
      <h2>${t('casino.cashout')}</h2>
      <p class="hint">${t('casino.cashoutHint')}</p>
      ${mine ? errorBox(ctx, form.error) : ''}
      <form method="post" action="/admin/casino/${program.id}/cashout" class="stack" autocomplete="off">
        ${csrfField(ctx)}${nonceField(mine ? form.nonce : undefined)}
        ${selectField({ label: t('form.class'), name: 'classId', options: classOptions(classes), value: mine ? form.values.classId : '', required: true, placeholder: t('form.choose') })}
        ${field({ label: t('form.person'), name: 'name', value: mine ? form.values.name : '', required: true, attrs: html`maxlength="80"` })}
        ${field({ label: t('casino.chips'), name: 'chips', value: mine ? form.values.chips : '', type: 'number', required: true, attrs: numberAttrs(0) })}
        ${mine ? warningBox(ctx, form.warnings) : ''}
        <button type="submit">${t('casino.recordCashout')}</button>
      </form>
    </section>`;
}

function openVisits(ctx, { program, visits, form }) {
  const { t, lang, settings } = ctx;
  const detailed = settings.get('casino.record_games');
  return html`
    <section class="section">
      <h2>${t('casino.openVisits', { n: visits.length })}</h2>
      ${form.kind === 'cashout' ? errorBox(ctx, form.error) : ''}
      ${visits.length === 0 ? emptyState(t('casino.noOpenVisits')) : ''}
      <ul class="records">
        ${visits.map(
          (v) => html`
            <li class="record">
              <div class="record-main">
                <span>${v.person_name} · ${v.class_name}</span>
                ${detailed ? badge(t('casino.balance', { n: v.balance }), 'accent') : ''}
              </div>
              <div class="record-meta muted">#${v.id} · ${formatTime(v.created_at, lang)} · ${v.creator}</div>
              <form method="post" action="/admin/casino/${program.id}/cashout" class="inline-form">
                ${csrfField(ctx)}${nonceField()}${hidden('visitId', v.id)}
                <input type="number" name="chips" ${numberAttrs(0)} required value="${detailed ? v.balance : ''}" aria-label="${t('casino.chips')}" placeholder="${t('casino.chips')}">
                <button type="submit">${t('casino.recordCashout')}</button>
              </form>
            </li>`,
        )}
      </ul>
    </section>`;
}

function roundForm(ctx, { program, visits, games, form }) {
  const { t, lang } = ctx;
  const mine = form.kind === 'round';
  const visitOptions = visits.map((v) => ({ value: v.id, label: `${v.person_name} (${v.class_name}) · ${v.balance}` }));
  return html`
    <section class="section">
      <h2>${t('casino.recordGame')}</h2>
      <p class="hint">${t('casino.gameHint')}</p>
      ${mine ? errorBox(ctx, form.error) : ''}
      <form method="post" action="/admin/casino/${program.id}/round" class="stack">
        ${csrfField(ctx)}${nonceField(mine ? form.nonce : undefined)}
        ${selectField({ label: t('casino.game'), name: 'gameId', options: games.map((g) => ({ value: g.id, label: `${localized(g, 'name', lang)} · ${t(`casino.gameKind.${g.kind}`)}` })), value: mine ? form.values.gameId : '', required: true })}
        <div class="round-rows">
          ${Array.from({ length: ROUND_ROWS }, (_, i) => {
            const row = mine ? (form.values.results?.[i] ?? {}) : {};
            return html`
              <div class="round-row">
                ${selectField({ label: t('casino.player', { n: i + 1 }), name: `results[${i}][visitId]`, options: visitOptions, value: row.visitId, placeholder: '–' })}
                ${field({ label: t('casino.delta'), name: `results[${i}][delta]`, value: row.delta, type: 'number', attrs: html`step="1"` })}
              </div>`;
          })}
        </div>
        <button type="submit">${t('casino.saveGame')}</button>
      </form>
    </section>`;
}

function myRecords(ctx, { records }) {
  const { t, lang, user } = ctx;
  if (records.length === 0) return '';
  return html`
    <section class="section">
      <h2>${t('casino.myRecords')}</h2>
      <ul class="records">
        ${records.map(
          (r) => html`
            <li class="record ${r.voided_at ? 'voided' : ''}">
              <div class="record-main">
                <span>${t(`casino.record.${r.kind}`, r)}</span>
                ${r.voided_at ? badge(t('entries.voided'), 'danger') : ''}
              </div>
              <div class="record-meta muted">#${r.id} · ${formatTime(r.created_at, lang)}</div>
              ${!r.voided_at && (r.created_by === user.id || isSuperadmin(user))
                ? html`<div class="record-actions">${postButton(ctx, `/admin/casino/void/${r.kind}/${r.id}`, t('entries.void'), { className: 'danger small', reasonPrompt: t('entries.voidPrompt') })}</div>`
                : ''}
            </li>`,
        )}
      </ul>
    </section>`;
}

export function casinoPage(ctx, { programs, program, classes, visits, games, records, form = { kind: null } }) {
  const { t, lang, settings } = ctx;
  if (!program) {
    return html`<h1>${t('nav.casino')}</h1>${emptyState(t('casino.noProgram'))}`;
  }
  return html`
    <h1>${t('nav.casino')}</h1>
    ${programs.length > 1
      ? html`<p class="tabs">${programs.map((p) => html`<a href="/admin/casino?program=${p.id}" ${p.id === program.id ? html`aria-current="page"` : ''}>${localized(p, 'name', lang)}</a>`)}</p>`
      : html`<p class="muted">${localized(program, 'name', lang)}</p>`}
    ${program.status !== 'open' ? html`<p class="notice warn">${t('error.programNotOpen')}</p>` : ''}
    ${modeSummary(ctx)}
    ${flash(ctx)}
    ${settings.get('casino.record_visits')
      ? html`${visitForm(ctx, { program, classes, form })}${settings.get('casino.record_games') ? roundForm(ctx, { program, visits, games, form }) : ''}${openVisits(ctx, { program, visits, form })}`
      : lightCashoutForm(ctx, { program, classes, form })}
    ${myRecords(ctx, { records })}`;
}
