// Organizer routes: dashboard, awarding points, own entries, timers, live standings.

import { canAwardPoints, featureOn, hasRole, isCasinoStaff, isSuperadmin } from '../auth/roles.js';
import { audit } from '../domain/audit.js';
import { correctEntry, createAward, listEntries, voidEntry } from '../domain/awards.js';
import { styleBudget } from '../domain/budget.js';
import { getProgram, getReason, listClasses, listReasons } from '../domain/catalog.js';
import { listSnapshots, liveStandings } from '../domain/standings.js';
import { cancelTimer, listRunningTimers, startTimer, stopTimer } from '../domain/timers.js';
import { HttpError, ValidationError } from '../http/errors.js';
import { redirect, safeLocalPath } from '../http/response.js';
import { awardFormPage, entriesPage, POOL_ROWS, reasonPickerPage, timersPage } from '../views/admin/award.js';
import { dashboardPage } from '../views/admin/home.js';
import { standingsPage } from '../views/admin/review.js';
import { attempt, formMap, formRows, idParam, nonceOf, redirectWithFlash, render, requireAwarder, requireUser } from './helpers.js';

/** Programs an actor can record for right now: open ones, plus not-yet-closed ones for the superadmin. */
function workablePrograms(ctx) {
  const statuses = isSuperadmin(ctx.user) ? ['open', 'upcoming'] : ['open'];
  return ctx.db.prepare(`SELECT * FROM programs WHERE status IN (${statuses.map(() => '?').join(', ')}) ORDER BY sort, id`).all(...statuses);
}

function budgetFor(ctx, program, reasons) {
  return reasons.some((r) => r.kind === 'style') ? styleBudget(ctx.db, ctx.user.id, program.id) : null;
}

function showAward(ctx, { reason, values = {}, error = null, warnings = null, nonce, correcting = null, status = 200 }) {
  const program = getProgram(ctx.db, reason.program_id);
  const budget = reason.kind === 'style' ? styleBudget(ctx.db, ctx.user.id, program.id) : null;
  const notOpen = !isSuperadmin(ctx.user) && program.status !== 'open' ? new ValidationError('error.programNotOpen') : null;
  const body = awardFormPage(ctx, { reason, program, classes: listClasses(ctx.db, { activeOnly: true }), budget, values, error: error ?? notOpen, warnings, nonce, correcting });
  render(ctx, body, { title: ctx.t('award.title'), status });
}

function loadAwardableReason(ctx) {
  const reason = getReason(ctx.db, idParam(ctx.params.reasonId));
  if (!reason || reason.kind === 'casino') throw new HttpError(404);
  return reason;
}

function correctingEntry(ctx, reason) {
  const id = ctx.url.searchParams.get('corrects');
  if (!id) return null;
  const entry = ctx.db.prepare('SELECT * FROM entries WHERE id = ?').get(idParam(id));
  if (!entry || entry.reason_id !== reason.id) throw new HttpError(404);
  if (entry.created_by !== ctx.user.id && !isSuperadmin(ctx.user)) throw new HttpError(403, 'error.notYourEntry');
  return entry;
}

function showTimers(ctx, extra = {}, status = 200) {
  const reasons = workablePrograms(ctx).flatMap((p) => listReasons(ctx.db, p.id, { activeOnly: true }).filter((r) => r.kind === 'minutes'));
  const body = timersPage(ctx, { reasons, classes: listClasses(ctx.db, { activeOnly: true }), running: listRunningTimers(ctx.db), ...extra });
  render(ctx, body, { title: ctx.t('timers.title'), status });
}

export function registerAdminRoutes(router) {
  router.get('/admin', requireUser, (ctx) => {
    if (isCasinoStaff(ctx.user) && !isSuperadmin(ctx.user)) return redirect(ctx.res, '/admin/casino');
    const openPrograms = workablePrograms(ctx);
    const budgets = openPrograms
      .filter((p) => listReasons(ctx.db, p.id, { activeOnly: true }).some((r) => r.kind === 'style'))
      .map((program) => ({ program, ...styleBudget(ctx.db, ctx.user.id, program.id) }));
    const body = dashboardPage(ctx, {
      openPrograms,
      budgets,
      runningTimers: listRunningTimers(ctx.db).length,
      classCount: listClasses(ctx.db).length,
    });
    render(ctx, body, { title: ctx.t('nav.dashboard') });
  });

  router.get('/admin/award', requireAwarder, (ctx) => {
    const groups = workablePrograms(ctx)
      .map((program) => {
        const reasons = listReasons(ctx.db, program.id, { activeOnly: true }).filter((r) => r.kind !== 'casino');
        return { program, reasons, budget: budgetFor(ctx, program, reasons) };
      })
      .filter((g) => g.reasons.length > 0);
    render(ctx, reasonPickerPage(ctx, { groups }), { title: ctx.t('award.title') });
  });

  router.get('/admin/award/:reasonId', requireAwarder, (ctx) => {
    const reason = loadAwardableReason(ctx);
    const correcting = correctingEntry(ctx, reason);
    const values = correcting
      ? { classId: correcting.class_id, name: correcting.person_name, amount: correcting.amount, inputs: JSON.parse(correcting.inputs), note: correcting.note }
      : {};
    showAward(ctx, { reason, values, correcting });
  });

  router.post('/admin/award/:reasonId', requireAwarder, (ctx) => {
    const reason = loadAwardableReason(ctx);
    const correcting = correctingEntry(ctx, reason);
    const { form } = ctx;
    const input = {
      classId: form.get('classId') ?? '',
      name: form.get('name') ?? '',
      amount: form.get('amount') ?? '',
      note: form.get('note') ?? '',
      correctionReason: form.get('correctionReason') ?? '',
      inputs: formMap(form, 'inputs'),
      rows: formRows(form, 'rows', ['name', 'classId', 'amount'], POOL_ROWS),
    };
    const args = { actor: ctx.user, input, confirmed: form.get('confirmed') === '1', nonce: nonceOf(form), now: ctx.now, ip: ctx.ip };
    const outcome = attempt(
      () => (correcting ? correctEntry(ctx.db, ctx.settings, { ...args, entryId: correcting.id }) : createAward(ctx.db, ctx.settings, { ...args, reasonId: reason.id })),
      (problem, status) => showAward(ctx, { reason, values: input, nonce: args.nonce ?? undefined, correcting, status, ...problem }),
    );
    if (!outcome.ok) return;
    if (correcting) return redirectWithFlash(ctx, '/admin/entries', 'corrected');
    const { result } = outcome;
    redirectWithFlash(ctx, `/admin/award/${reason.id}`, result.replayed ? 'replayed' : 'saved', result.total);
  });

  router.get('/admin/entries', requireAwarder, (ctx) => {
    const canSeeAll = hasRole(ctx.user, 'logadmin');
    const showAll = canSeeAll && ctx.url.searchParams.get('all') === '1';
    const entries = listEntries(ctx.db, { createdBy: showAll ? null : ctx.user.id, limit: 300 });
    render(ctx, entriesPage(ctx, { entries, showAll, canSeeAll }), { title: ctx.t('entries.title') });
  });

  router.post('/admin/entries/:id/void', requireAwarder, (ctx) => {
    voidEntry(ctx.db, ctx.settings, { actor: ctx.user, entryId: idParam(ctx.params.id), reason: ctx.form.get('reason'), now: ctx.now, ip: ctx.ip });
    const back = safeLocalPath(ctx.form.get('back'), '/admin/entries');
    redirectWithFlash(ctx, back.startsWith('/admin') ? back : '/admin/entries', 'voided');
  });

  router.get('/admin/timers', requireAwarder, (ctx) => showTimers(ctx));

  router.post('/admin/timers', requireAwarder, (ctx) => {
    const values = { reasonId: ctx.form.get('reasonId') ?? '', classId: ctx.form.get('classId') ?? '', name: ctx.form.get('name') ?? '' };
    const outcome = attempt(
      () =>
        startTimer(ctx.db, ctx.settings, {
          actor: ctx.user,
          reasonId: idParam(values.reasonId),
          classId: values.classId,
          name: values.name,
          confirmed: ctx.form.get('confirmed') === '1',
          now: ctx.now,
          ip: ctx.ip,
        }),
      (problem, status) => showTimers(ctx, { values, ...problem }, status),
    );
    if (outcome.ok) redirectWithFlash(ctx, '/admin/timers', 'timerStarted');
  });

  router.post('/admin/timers/:id/stop', requireAwarder, (ctx) => {
    const outcome = attempt(
      () => stopTimer(ctx.db, ctx.settings, { actor: ctx.user, timerId: idParam(ctx.params.id), now: ctx.now, ip: ctx.ip }),
      (problem, status) => showTimers(ctx, problem, status),
    );
    if (outcome.ok) redirectWithFlash(ctx, '/admin/timers', 'timerStopped', outcome.result.minutes);
  });

  router.post('/admin/timers/:id/cancel', requireAwarder, (ctx) => {
    cancelTimer(ctx.db, { actor: ctx.user, timerId: idParam(ctx.params.id), now: ctx.now, ip: ctx.ip });
    redirectWithFlash(ctx, '/admin/timers', 'timerCancelled');
  });

  // Each organizer may switch the timer off for themselves while the module is on.
  router.post('/admin/account/timer', requireAwarder, (ctx) => {
    if (!ctx.settings.get('features.timer')) throw new HttpError(403, 'error.featureOff');
    const next = ctx.user.use_timer ? 0 : 1;
    ctx.db.prepare('UPDATE users SET use_timer = ? WHERE id = ?').run(next, ctx.user.id);
    audit(ctx.db, { actor: ctx.user, action: 'account.timer', subject: `user:${ctx.user.id}`, details: { use_timer: next }, ip: ctx.ip, at: ctx.now });
    redirectWithFlash(ctx, '/admin', 'preferenceSaved');
  });

  router.get('/admin/standings', requireUser, (ctx) => {
    if (!hasRole(ctx.user, 'logadmin') && !(canAwardPoints(ctx.user) && featureOn(ctx.settings, ctx.user, 'features.live_standings'))) {
      throw new HttpError(403);
    }
    render(ctx, standingsPage(ctx, { rows: liveStandings(ctx.db), snapshots: listSnapshots(ctx.db) }), { title: ctx.t('standings.title') });
  });
}
