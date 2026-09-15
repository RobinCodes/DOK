// Reusable view pieces: form fields, messages and the superadmin value control.

import { randomUUID } from 'node:crypto';
import { html } from '../http/html.js';
import { isoToBudapestLocal } from '../domain/time.js';

export const csrfField = (ctx) => html`<input type="hidden" name="csrf" value="${ctx.csrf ?? ''}">`;

/** A fresh random id per rendered form: submitting it twice can't record twice. */
export const nonceField = (value = randomUUID()) => html`<input type="hidden" name="nonce" value="${value}">`;

export const hidden = (name, value) => html`<input type="hidden" name="${name}" value="${value ?? ''}">`;

/** Success message passed through the redirect as ?ok=<key>; unknown keys show nothing. */
export function flash(ctx) {
  const key = ctx.url.searchParams.get('ok');
  if (!key || !ctx.t.has(`flash.${key}`)) return '';
  const n = ctx.url.searchParams.get('n');
  return html`<p class="notice ok" role="status">${ctx.t(`flash.${key}`, { n: /^-?\d+$/.test(n ?? '') ? n : '' })}</p>`;
}

export function errorBox(ctx, error) {
  if (!error) return '';
  return html`<p class="notice error" role="alert">${ctx.t(error.messageKey, error.vars)}</p>`;
}

/** Soft rule warnings plus the explicit "record anyway" confirmation (which gets logged). */
export function warningBox(ctx, warnings) {
  if (!warnings?.length) return '';
  return html`
    <div class="notice warn" role="alert">
      <ul>${warnings.map((w) => html`<li>${ctx.t(w.key, w.vars)}</li>`)}</ul>
      <label class="check"><input type="checkbox" name="confirmed" value="1" required> ${ctx.t('form.confirmAnyway')}</label>
    </div>`;
}

export function field({ label, name, value = '', type = 'text', required = false, attrs = '', hint = '' }) {
  return html`
    <label class="field">
      <span>${label}</span>
      <input type="${type}" name="${name}" value="${value}" ${required ? html`required` : ''} ${attrs}>
      ${hint ? html`<small>${hint}</small>` : ''}
    </label>`;
}

/** Whole-number input that also shows the minus key on phones. */
export const numberAttrs = (min, max) => html`inputmode="numeric" step="1" ${min !== undefined ? html`min="${min}"` : ''} ${max !== undefined ? html`max="${max}"` : ''}`;

export function selectField({ label, name, options, value = '', required = false, placeholder = null }) {
  return html`
    <label class="field">
      <span>${label}</span>
      <select name="${name}" ${required ? html`required` : ''}>
        ${placeholder !== null ? html`<option value="">${placeholder}</option>` : ''}
        ${options.map((o) => html`<option value="${o.value}" ${String(o.value) === String(value) ? html`selected` : ''}>${o.label}</option>`)}
      </select>
    </label>`;
}

export const classOptions = (classes) => classes.map((c) => ({ value: c.id, label: c.name }));

export function postButton(ctx, action, label, { fields = {}, className = 'secondary', reasonPrompt = null } = {}) {
  return html`
    <form method="post" action="${action}" class="inline-form">
      ${csrfField(ctx)}
      ${Object.entries(fields).map(([name, value]) => hidden(name, value))}
      ${reasonPrompt ? html`<input type="text" name="reason" required maxlength="200" placeholder="${reasonPrompt}" aria-label="${reasonPrompt}">` : ''}
      <button type="submit" class="${className}">${label}</button>
    </form>`;
}

export const badge = (text, kind = '') => html`<span class="badge ${kind}">${text}</span>`;

export const emptyState = (text) => html`<p class="empty">${text}</p>`;

function displayValue(ctx, spec, value, options) {
  if (spec.type === 'bool') return value ? ctx.t('value.on') : ctx.t('value.off');
  if (value === null || value === undefined || value === '') return ctx.t('value.empty');
  if (options) return options.find((o) => String(o.value) === String(value))?.label ?? String(value);
  return String(value);
}

/**
 * The superadmin's control for one value: shows the current value, lets it be
 * set (or toggled), and numbers can also be changed by a positive or negative step.
 */
export function valueControl(ctx, { target, label, value, spec, options = null, back }) {
  const { t } = ctx;
  const base = html`${csrfField(ctx)}${hidden('target', target)}${hidden('back', back)}`;
  const current = displayValue(ctx, spec, value, options);
  let controls;
  if (spec.type === 'bool') {
    controls = html`
      <form method="post" action="/admin/super/change" class="control-form">
        ${base}${hidden('op', 'toggle')}
        <button type="submit" class="${value ? 'secondary' : ''}">${value ? t('value.turnOff') : t('value.turnOn')}</button>
      </form>`;
  } else {
    let input;
    if (options) {
      input = html`<select name="value" aria-label="${label}">${options.map((o) => html`<option value="${o.value}" ${String(o.value) === String(value) ? html`selected` : ''}>${o.label}</option>`)}</select>`;
    } else if (spec.type === 'datetime') {
      input = html`<input type="datetime-local" name="value" value="${isoToBudapestLocal(value)}" aria-label="${label}">`;
    } else if (spec.type === 'text' && spec.max > 200) {
      input = html`<textarea name="value" rows="4" maxlength="${spec.max}" aria-label="${label}">${value ?? ''}</textarea>`;
    } else if (spec.type === 'int' || spec.type === 'decimal') {
      input = html`<input type="number" name="value" step="${spec.type === 'int' ? '1' : 'any'}" required aria-label="${label}" placeholder="${value ?? ''}">`;
    } else {
      input = html`<input type="text" name="value" value="${value ?? ''}" maxlength="${spec.max ?? 200}" aria-label="${label}">`;
    }
    const numeric = spec.type === 'int' || spec.type === 'decimal';
    controls = html`
      <form method="post" action="/admin/super/change" class="control-form">
        ${base}${hidden('op', 'set')}${input}
        <button type="submit">${t('value.set')}</button>
      </form>
      ${numeric
        ? html`<form method="post" action="/admin/super/change" class="control-form">
            ${base}${hidden('op', 'adjust')}
            <input type="number" name="value" step="${spec.type === 'int' ? '1' : 'any'}" required placeholder="±" aria-label="${t('value.changeBy')}">
            <button type="submit" class="secondary">${t('value.changeBy')}</button>
          </form>`
        : ''}`;
  }
  return html`
    <div class="control" id="${target.replace(/[^a-z0-9]/gi, '-')}">
      <div class="control-head"><span class="control-label">${label}</span><strong class="control-value">${current}</strong></div>
      <div class="control-actions">${controls}</div>
    </div>`;
}

export function formatNumber(value, lang) {
  return new Intl.NumberFormat(lang === 'hu' ? 'hu-HU' : 'en-GB').format(value);
}
