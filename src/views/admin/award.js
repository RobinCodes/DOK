// Awarding points: choosing a reason, the award form for each reason kind, and the entry list.

import { featureOn, isSuperadmin } from '../../auth/roles.js';
import { formulaInputs } from '../../domain/awards.js';
import { localized } from '../../domain/catalog.js';
import { formatDateTime } from '../../domain/time.js';
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

export const POOL_ROWS = 10;

const inputLabel = (t, name) => (t.has(`input.${name}`) ? t(`input.${name}`) : name);

export function reasonPickerPage(ctx, { groups }) {
  const { t, lang } = ctx;
  return html`
    <h1>${t('award.title')}</h1>
    ${flash(ctx)}
    ${groups.length === 0 ? emptyState(t('dashboard.noOpenProgram')) : ''}
    ${groups.map(
      ({ program, reasons, budget }) => html`
        <section class="section">
          <h2>${localized(program, 'name', lang)} ${program.status !== 'open' ? badge(t(`status.${program.status}`), 'muted') : ''}</h2>
          ${budget ? html`<p class="muted">${t('award.budgetLeft', { remaining: budget.remaining, allotted: budget.allotted })}</p>` : ''}
          <ul class="reason-list">
            ${reasons.map(
              (r) => html`
                <li><a class="reason" href="/admin/award/${r.id}">
                  <span>${localized(r, 'name', lang)}</span>
                  <small>${t(`kind.${r.kind}`)}</small>
                </a></li>`,
            )}
          </ul>
        </section>`,
    )}`;
}

function kindFields(ctx, { reason, classes, values }) {
  const { t, user, settings } = ctx;
  const classSelect = (name = 'classId', value = values.classId) =>
    selectField({ label: t('form.class'), name, options: classOptions(classes), value, required: true, placeholder: t('form.choose') });
  const nameField = () =>
    field({ label: reason.needs_person ? t('form.person') : t('form.personOptional'), name: 'name', value: values.name, required: Boolean(reason.needs_person), attrs: html`maxlength="80" autocomplete="off"` });

  if (reason.kind === 'pool') {
    return html`
      <p class="hint">${t('award.poolHint', { formula: reason.formula })}</p>
      <div class="pool-rows">
        ${Array.from({ length: POOL_ROWS }, (_, i) => {
          const row = values.rows?.[i] ?? {};
          return html`
            <fieldset class="pool-row">
              <legend>${t('award.performer', { n: i + 1 })}</legend>
              ${field({ label: t('form.person'), name: `rows[${i}][name]`, value: row.name, attrs: html`maxlength="80" autocomplete="off"` })}
              ${classSelect(`rows[${i}][classId]`, row.classId)}
              ${field({ label: t('form.points'), name: `rows[${i}][amount]`, value: row.amount, type: 'number', attrs: numberAttrs(reason.min_points, reason.max_points) })}
            </fieldset>`;
        })}
      </div>`;
  }

  const common = html`${classSelect()}${nameField()}`;
  if (reason.kind === 'manual' || reason.kind === 'style') {
    return html`${common}
      ${field({ label: t('form.points'), name: 'amount', value: values.amount, type: 'number', required: true, attrs: numberAttrs(reason.min_points, reason.max_points), hint: t('award.range', { min: reason.min_points, max: reason.max_points }) })}`;
  }
  if (reason.kind === 'minutes' && !featureOn(settings, user, 'features.manual_minutes')) {
    return html`<p class="notice">${t('award.manualMinutesOff')} <a href="/admin/timers">${t('nav.timers')}</a></p>`;
  }
  const inputs = formulaInputs(reason);
  return html`${common}
    ${inputs.map((name) => field({ label: inputLabel(t, name), name: `inputs[${name}]`, value: values.inputs?.[name], type: 'number', required: true, attrs: numberAttrs(0, reason.params[`max_${name}`]) }))}
    <p class="hint">${t('award.formulaHint', { formula: reason.formula })}</p>`;
}

export function awardFormPage(ctx, { reason, program, classes, budget, values = {}, error = null, warnings = null, nonce, correcting = null }) {
  const { t, lang } = ctx;
  const action = `/admin/award/${reason.id}${correcting ? `?corrects=${correcting.id}` : ''}`;
  const blocked = reason.kind === 'minutes' && !featureOn(ctx.settings, ctx.user, 'features.manual_minutes');
  return html`
    <p class="crumbs"><a href="/admin/award">← ${t('award.title')}</a></p>
    <h1>${localized(reason, 'name', lang)}</h1>
    <p class="muted">${localized(program, 'name', lang)} · ${t(`kind.${reason.kind}`)}</p>
    ${flash(ctx)}
    ${budget ? html`<p class="stat-inline">${t('award.budgetLeft', { remaining: budget.remaining, allotted: budget.allotted })}</p>` : ''}
    ${correcting ? html`<p class="notice">${t('award.correcting', { id: correcting.id, amount: correcting.amount, name: correcting.person_name || '–' })}</p>` : ''}
    ${errorBox(ctx, error)}
    <form method="post" action="${action}" class="stack" autocomplete="off">
      ${csrfField(ctx)}${nonceField(nonce)}
      ${kindFields(ctx, { reason, classes, values })}
      ${blocked
        ? ''
        : html`
          ${field({ label: t('form.note'), name: 'note', value: values.note, attrs: html`maxlength="200"` })}
          ${correcting ? field({ label: t('form.correctionReason'), name: 'correctionReason', value: values.correctionReason, required: true, attrs: html`maxlength="200"` }) : ''}
          ${warningBox(ctx, warnings)}
          <button type="submit">${correcting ? t('award.submitCorrection') : t('award.submit')}</button>`}
    </form>`;
}

function entryStatus(ctx, entry) {
  const { t } = ctx;
  if (entry.voided_at) return badge(t('entries.voided'), 'danger');
  if (entry.corrects_id) return badge(t('entries.correction', { id: entry.corrects_id }), 'muted');
  return '';
}

export function entriesPage(ctx, { entries, showAll, canSeeAll }) {
  const { t, lang, user, settings } = ctx;
  // These only decide which buttons to show; the server re-checks every action.
  const mayVoid = (e) => !e.voided_at && (isSuperadmin(user) || (e.created_by === user.id && settings.get('features.storno') && !['adjustment', 'casino'].includes(e.source)));
  const mayCorrect = (e) => !e.voided_at && e.reason_id && !e.batch && (isSuperadmin(user) || (e.created_by === user.id && settings.get('features.corrections') && e.source !== 'casino'));
  return html`
    <h1>${showAll ? t('entries.allTitle') : t('entries.title')}</h1>
    ${flash(ctx)}
    ${canSeeAll ? html`<p><a href="/admin/entries${showAll ? '' : '?all=1'}">${showAll ? t('entries.showMine') : t('entries.showAll')}</a></p>` : ''}
    ${entries.length === 0 ? emptyState(t('entries.none')) : ''}
    <ul class="records">
      ${entries.map(
        (e) => html`
          <li class="record ${e.voided_at ? 'voided' : ''}">
            <div class="record-main">
              <strong class="amount">${e.amount > 0 ? '+' : ''}${e.amount}</strong>
              <span>${e.class_name}${e.person_name ? html` · ${e.person_name}` : ''}</span>
              ${entryStatus(ctx, e)}
            </div>
            <div class="record-meta muted">
              #${e.id} · ${formatDateTime(e.created_at, lang)} · ${e.reason_id ? localized({ name_hu: e.reason_hu, name_en: e.reason_en }, 'name', lang) : t(`source.${e.source}`)}
              ${showAll ? html` · ${e.creator}` : ''}${e.note ? html` · „${e.note}”` : ''}
              ${e.voided_at ? html` · ${t('entries.voidReason', { reason: e.void_reason })}` : ''}
            </div>
            <div class="record-actions">
              ${mayCorrect(e) ? html`<a class="button secondary small" href="/admin/award/${e.reason_id}?corrects=${e.id}">${t('entries.correct')}</a>` : ''}
              ${mayVoid(e) ? postButton(ctx, `/admin/entries/${e.id}/void`, t('entries.void'), { className: 'danger small', reasonPrompt: t('entries.voidPrompt'), fields: { back: ctx.url.pathname + ctx.url.search } }) : ''}
            </div>
          </li>`,
      )}
    </ul>`;
}

export function timersPage(ctx, { reasons, classes, running, values = {}, error = null, warnings = null }) {
  const { t, lang, user, settings } = ctx;
  const usable = settings.get('features.timer') && (user.use_timer || isSuperadmin(user));
  return html`
    <h1>${t('timers.title')}</h1>
    ${flash(ctx)}
    ${!usable ? html`<p class="notice">${t('timers.off')}</p>` : ''}
    ${usable && reasons.length
      ? html`
        <section class="section">
          <h2>${t('timers.start')}</h2>
          ${errorBox(ctx, error)}
          <form method="post" action="/admin/timers" class="stack" autocomplete="off">
            ${csrfField(ctx)}
            ${selectField({ label: t('timers.station'), name: 'reasonId', options: reasons.map((r) => ({ value: r.id, label: localized(r, 'name', lang) })), value: values.reasonId, required: true })}
            ${selectField({ label: t('form.class'), name: 'classId', options: classOptions(classes), value: values.classId, required: true, placeholder: t('form.choose') })}
            ${field({ label: t('form.person'), name: 'name', value: values.name, required: true, attrs: html`maxlength="80"` })}
            ${warningBox(ctx, warnings)}
            <button type="submit">${t('timers.startButton')}</button>
          </form>
        </section>`
      : ''}
    <section class="section">
      <h2>${t('timers.running', { n: running.length })}</h2>
      ${running.length === 0 ? emptyState(t('timers.none')) : ''}
      <ul class="records">
        ${running.map(
          (r) => html`
            <li class="record">
              <div class="record-main">
                <strong class="elapsed" data-since="${r.started_at}">–</strong>
                <span>${r.person_name} · ${r.class_name}</span>
              </div>
              <div class="record-meta muted">${localized({ name_hu: r.reason_hu, name_en: r.reason_en }, 'name', lang)} · ${t('timers.startedBy', { user: r.starter, time: formatDateTime(r.started_at, lang) })}</div>
              <div class="record-actions">
                ${postButton(ctx, `/admin/timers/${r.id}/stop`, t('timers.stop'), { className: 'small' })}
                ${r.started_by === user.id || isSuperadmin(user) ? postButton(ctx, `/admin/timers/${r.id}/cancel`, t('timers.cancel'), { className: 'secondary small' }) : ''}
              </div>
            </li>`,
        )}
      </ul>
    </section>`;
}
