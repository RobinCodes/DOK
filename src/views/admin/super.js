// The superadmin hub (Rulebook §2.4): every value on the site, grouped in tabs,
// each with the same control (current value · set/toggle · change by ±n).

import { formulaInputs } from '../../domain/awards.js';
import { localized, REASON_KINDS, SYSTEM_VARIABLES } from '../../domain/catalog.js';
import { TABLES } from '../../domain/manage.js';
import { SETTINGS } from '../../domain/settings.js';
import { formatDateTime } from '../../domain/time.js';
import { html } from '../../http/html.js';
import { badge, csrfField, emptyState, errorBox, field, flash, hidden, postButton, selectField, valueControl } from '../components.js';

export const TABS = ['settings', 'programs', 'reasons', 'classes', 'users', 'casino', 'snapshots'];

const anchorOf = (target) => target.replace(/[^a-z0-9]/gi, '-');

/** Renders controls for columns of one database row, using the field specs from domain/manage.js. */
function rowControls(ctx, kind, row, fields, back, options = {}) {
  return fields.map((column) => {
    const target = `${kind}:${row.id}:${column}`;
    const spec = TABLES[kind].fields[column];
    return valueControl(ctx, {
      target,
      label: ctx.t(`field.${column}`),
      value: row[column],
      spec,
      options: options[column] ?? (spec.type === 'choice' ? spec.options.map((o) => ({ value: o, label: ctx.t(`choice.${o}`) })) : null),
      back: `${back}#${anchorOf(target)}`,
    });
  });
}

function settingsTab(ctx) {
  const { t } = ctx;
  const groups = Map.groupBy(Object.keys(SETTINGS), (key) => key.split('.')[0]);
  return [...groups].map(
    ([group, keys]) => html`
      <section class="section">
        <h2>${t(`settingGroup.${group}`)}</h2>
        <div class="controls">
          ${keys.map((key) => {
            const def = SETTINGS[key];
            const target = `setting:${key}`;
            const spec = def.type === 'choice' ? { type: 'choice' } : def.type === 'int' ? { type: 'int', min: def.min, max: def.max } : { type: 'bool' };
            return valueControl(ctx, {
              target,
              label: t(`setting.${key}`),
              value: def.type === 'bool' ? (ctx.settings.get(key) ? 1 : 0) : ctx.settings.get(key),
              spec,
              options: def.type === 'choice' ? def.options.map((o) => ({ value: o, label: t(`choice.${o}`) })) : null,
              back: `/admin/super?tab=settings#${anchorOf(target)}`,
            });
          })}
        </div>
      </section>`,
  );
}

function programsTab(ctx, { programs }) {
  const { t, lang } = ctx;
  const back = '/admin/super?tab=programs';
  return html`
    <section class="section">
      <h2>${t('super.newProgram')}</h2>
      <form method="post" action="/admin/super/programs" class="stack">
        ${csrfField(ctx)}
        ${field({ label: t('field.name_hu'), name: 'nameHu', required: true, attrs: html`maxlength="80"` })}
        ${field({ label: t('field.name_en'), name: 'nameEn', attrs: html`maxlength="80"` })}
        <button type="submit">${t('super.create')}</button>
      </form>
    </section>
    ${programs.map(
      (p) => html`
        <details class="panel" id="program-${p.id}">
          <summary>${localized(p, 'name', lang)} ${badge(t(`status.${p.status}`), p.status === 'open' ? 'ok' : 'muted')}</summary>
          <div class="controls">
            ${rowControls(ctx, 'program', p, ['status', 'style_budget', 'starts_at', 'ends_at', 'public', 'name_hu', 'name_en', 'when_hu', 'when_en', 'description_hu', 'description_en', 'sort'], back)}
          </div>
        </details>`,
    )}`;
}

function reasonsTab(ctx, { programs, program, reasons }) {
  const { t, lang } = ctx;
  if (!program) return emptyState(t('super.noPrograms'));
  const back = `/admin/super?tab=reasons&program=${program.id}`;
  return html`
    <p class="tabs">${programs.map((p) => html`<a href="/admin/super?tab=reasons&program=${p.id}" ${p.id === program.id ? html`aria-current="page"` : ''}>${localized(p, 'name', lang)}</a>`)}</p>
    <section class="section">
      <h2>${t('super.newReason')}</h2>
      <form method="post" action="/admin/super/reasons" class="stack">
        ${csrfField(ctx)}${hidden('programId', program.id)}
        ${field({ label: t('field.name_hu'), name: 'nameHu', required: true, attrs: html`maxlength="120"` })}
        ${field({ label: t('field.name_en'), name: 'nameEn', attrs: html`maxlength="120"` })}
        ${selectField({ label: t('field.kind'), name: 'kind', options: REASON_KINDS.map((k) => ({ value: k, label: t(`kind.${k}`) })), required: true })}
        <button type="submit">${t('super.create')}</button>
      </form>
      <p class="hint">${t('super.paramHint')}</p>
    </section>
    ${reasons.map((r) => {
      const system = SYSTEM_VARIABLES[r.kind];
      const inputs = formulaInputs(r);
      return html`
        <details class="panel" id="reason-${r.id}">
          <summary>${localized(r, 'name', lang)} ${badge(t(`kind.${r.kind}`), 'muted')} ${r.active ? '' : badge(t('value.off'), 'danger')}</summary>
          <div class="controls">
            ${rowControls(ctx, 'reason', r, ['active', 'kind', 'min_points', 'max_points', 'formula', 'needs_person', 'name_hu', 'name_en', 'sort'], back)}
          </div>
          ${system ? html`<p class="hint">${t('super.systemVariables', { names: system.join(', ') })}</p>` : ''}
          ${inputs.length ? html`<p class="hint">${t('super.inputVariables', { names: inputs.join(', ') })}</p>` : ''}
          <h3>${t('super.params')}</h3>
          <div class="controls">
            ${Object.entries(r.params).map(([name, value]) => {
              const target = `param:${r.id}:${name}`;
              return html`
                ${valueControl(ctx, { target, label: name, value, spec: { type: 'decimal' }, back: `${back}#${anchorOf(target)}` })}
                ${postButton(ctx, '/admin/super/params/remove', t('super.removeParam', { name }), { className: 'danger small', fields: { reasonId: r.id, name, back } })}`;
            })}
          </div>
          <form method="post" action="/admin/super/params" class="inline-form">
            ${csrfField(ctx)}${hidden('reasonId', r.id)}${hidden('back', back)}
            <input name="name" required pattern="[a-z][a-z0-9_]*" maxlength="40" placeholder="${t('super.paramName')}" aria-label="${t('super.paramName')}">
            <input type="number" name="value" step="any" required placeholder="${t('super.paramValue')}" aria-label="${t('super.paramValue')}">
            <button type="submit" class="secondary">${t('super.addParam')}</button>
          </form>
        </details>`;
    })}`;
}

function classesTab(ctx, { classes, totals }) {
  const { t, lang } = ctx;
  const back = '/admin/super?tab=classes';
  return html`
    <section class="section">
      <h2>${t('super.addClasses')}</h2>
      <form method="post" action="/admin/super/classes" class="stack">
        ${csrfField(ctx)}
        <label class="field"><span>${t('super.classNames')}</span><textarea name="names" rows="4" placeholder="7.A&#10;9.B&#10;10.C"></textarea></label>
        <button type="submit">${t('super.create')}</button>
      </form>
    </section>
    ${classes.length === 0 ? emptyState(t('dashboard.noClasses')) : ''}
    ${classes.map((c) => {
      const target = `class_points:${c.id}`;
      return html`
        <details class="panel" id="class-${c.id}">
          <summary>${c.name} · ${totals.get(c.id) ?? 0} ${t('home.pointsShort')} ${c.active ? '' : badge(t('value.off'), 'danger')}</summary>
          <div class="controls">
            ${valueControl(ctx, { target, label: t('super.classPoints'), value: totals.get(c.id) ?? 0, spec: { type: 'int' }, back: `${back}#${anchorOf(target)}` })}
            ${rowControls(ctx, 'class', c, ['name', 'active', 'sort'], back)}
          </div>
          <p class="hint">${t('super.classPointsHint')}</p>
        </details>`;
    })}`;
}

function usersTab(ctx, { users, classes, budgetPrograms, budgets }) {
  const { t, lang } = ctx;
  const back = '/admin/super?tab=users';
  const classChoices = [{ value: '', label: t('value.empty') }, ...classes.map((c) => ({ value: c.id, label: c.name }))];
  return html`
    <p class="notice">${t('super.usersHint')} <code>npm run users -- create &lt;username&gt; --role admin</code></p>
    ${users.map(
      (u) => html`
        <details class="panel" id="user-${u.id}">
          <summary>${u.username} · ${u.display_name} ${badge(t(`role.${u.role}`), 'muted')} ${u.is_casino ? badge(t('role.casino'), 'accent') : ''} ${u.active ? '' : badge(t('value.off'), 'danger')}</summary>
          <div class="controls">
            ${rowControls(ctx, 'user', u, ['active', 'role', 'is_casino', 'class_id', 'use_timer', 'display_name'], back, { class_id: classChoices })}
            ${budgetPrograms.map((p) => {
              const target = `budget:${u.id}:${p.id}`;
              const b = budgets.get(`${u.id}:${p.id}`);
              return valueControl(ctx, { target, label: t('super.budget', { program: localized(p, 'name', lang), allotted: b.allotted, spent: b.spent }), value: b.remaining, spec: { type: 'int', min: 0 }, back: `${back}#${anchorOf(target)}` });
            })}
          </div>
        </details>`,
    )}`;
}

function casinoTab(ctx, { games, casinoPrograms, staff }) {
  const { t, lang } = ctx;
  const back = '/admin/super?tab=casino';
  return html`
    <section class="section">
      <h2>${t('super.games')}</h2>
      <form method="post" action="/admin/super/games" class="stack">
        ${csrfField(ctx)}
        ${field({ label: t('field.name_hu'), name: 'nameHu', required: true, attrs: html`maxlength="80"` })}
        ${field({ label: t('field.name_en'), name: 'nameEn', attrs: html`maxlength="80"` })}
        ${selectField({ label: t('field.kind'), name: 'kind', options: ['house', 'pvp'].map((k) => ({ value: k, label: t(`choice.${k}`) })), required: true })}
        <button type="submit">${t('super.create')}</button>
      </form>
      ${games.map(
        (g) => html`
          <details class="panel" id="game-${g.id}">
            <summary>${localized(g, 'name', lang)} ${badge(t(`choice.${g.kind}`), 'muted')} ${g.active ? '' : badge(t('value.off'), 'danger')}</summary>
            <div class="controls">${rowControls(ctx, 'game', g, ['active', 'kind', 'name_hu', 'name_en', 'sort'], back)}</div>
          </details>`,
      )}
    </section>
    ${casinoPrograms.map(
      ({ program, reconciliation, preview }) => html`
        <section class="section" id="casino-${program.id}">
          <h2>${localized(program, 'name', lang)}</h2>
          <h3>${t('super.reconciliation')}</h3>
          <p class="hint">${t('super.reconciliationHint')}</p>
          <div class="table-wrap"><table>
            <thead><tr><th>${t('super.staff')}</th><th>${t('super.recorded')}</th><th>${t('super.counted')}</th><th>${t('super.difference')}</th></tr></thead>
            <tbody>${reconciliation.map((r) => html`<tr class="${r.difference < 0 ? 'bad' : ''}"><td>${r.username}</td><td>${r.recorded}</td><td>${r.counted ?? '–'}</td><td>${r.difference ?? '–'}</td></tr>`)}</tbody>
          </table></div>
          <form method="post" action="/admin/super/casino/${program.id}/count" class="inline-form">
            ${csrfField(ctx)}
            <select name="staffId" required aria-label="${t('super.staff')}">${staff.map((s) => html`<option value="${s.id}">${s.username}</option>`)}</select>
            <input type="number" name="chips" min="0" step="1" required placeholder="${t('super.counted')}" aria-label="${t('super.counted')}">
            <button type="submit" class="secondary">${t('super.saveCount')}</button>
          </form>

          <h3>${t('super.conversion')}</h3>
          ${preview.reason ? html`<p class="hint">${t('super.conversionFormula', { formula: preview.reason.formula })}</p>` : ''}
          ${preview.openVisits ? html`<p class="notice warn">${t('super.openVisitsWarning', { n: preview.openVisits })}</p>` : ''}
          ${preview.rows.length === 0
            ? emptyState(t('super.nothingToConvert'))
            : html`
              <div class="table-wrap"><table>
                <thead><tr><th>${t('form.person')}</th><th>${t('form.class')}</th><th>${t('casino.chips')}</th><th>${t('form.points')}</th></tr></thead>
                <tbody>${preview.rows.map((r) => html`<tr class="${r.error ? 'bad' : ''}"><td>${r.person_name}</td><td>${r.class_name}</td><td>${r.chips}</td><td>${r.error ? t(r.error, { min: preview.reason.min_points, max: preview.reason.max_points, amount: r.points ?? '?' , message: '' }) : r.points}</td></tr>`)}</tbody>
              </table></div>
              ${postButton(ctx, `/admin/super/casino/${program.id}/convert`, t('super.convert', { n: preview.rows.length }), { className: '' })}`}
        </section>`,
    )}`;
}

function snapshotsTab(ctx, { snapshots }) {
  const { t, lang } = ctx;
  const back = '/admin/super?tab=snapshots';
  return html`
    <section class="section">
      <h2>${t('standings.publish')}</h2>
      <p class="hint">${t('standings.publishHint')}</p>
      <form method="post" action="/admin/super/snapshots" class="stack">
        ${csrfField(ctx)}
        ${field({ label: t('standings.label'), name: 'label', attrs: html`maxlength="80"` })}
        <button type="submit">${t('standings.publishButton')}</button>
      </form>
    </section>
    ${snapshots.map(
      (s) => html`
        <details class="panel" id="snapshot-${s.id}">
          <summary>#${s.id} · ${s.label || '–'} · ${formatDateTime(s.created_at, lang)} ${s.hidden ? badge(t('super.hidden'), 'danger') : ''}</summary>
          <div class="controls">${rowControls(ctx, 'snapshot', s, ['hidden', 'label'], back)}</div>
        </details>`,
    )}`;
}

const RENDERERS = { settings: settingsTab, programs: programsTab, reasons: reasonsTab, classes: classesTab, users: usersTab, casino: casinoTab, snapshots: snapshotsTab };

export function superPage(ctx, { tab, error = null, ...data }) {
  const { t } = ctx;
  return html`
    <h1>${t('nav.super')}</h1>
    <nav class="tabs" aria-label="${t('nav.super')}">
      ${TABS.map((name) => html`<a href="/admin/super?tab=${name}" ${name === tab ? html`aria-current="page"` : ''}>${t(`super.tab.${name}`)}</a>`)}
    </nav>
    ${flash(ctx)}
    ${errorBox(ctx, error)}
    ${RENDERERS[tab](ctx, data)}`;
}
