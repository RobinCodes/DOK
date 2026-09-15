// Superadmin routes (Rulebook §2.4): the control hub and every "create" action.

import { classTotal } from '../domain/awards.js';
import { styleBudget } from '../domain/budget.js';
import { conversionPreview, convertCashouts, casinoPrograms, reconciliation, recordCount } from '../domain/casino.js';
import { getProgram, listClasses, listGames, listPrograms, listReasons, listUsers } from '../domain/catalog.js';
import { addParam, applyChange, createClasses, createGame, createProgram, createReason, removeParam } from '../domain/manage.js';
import { listSnapshots, publishSnapshot } from '../domain/standings.js';
import { HttpError, ValidationError } from '../http/errors.js';
import { safeLocalPath } from '../http/response.js';
import { superPage, TABS } from '../views/admin/super.js';
import { idParam, redirectWithFlash, render, requireRole } from './helpers.js';

function tabData(ctx, tab, url) {
  const { db } = ctx;
  if (tab === 'programs') return { programs: listPrograms(db) };
  if (tab === 'reasons') {
    const programs = listPrograms(db);
    const requested = url.searchParams.get('program');
    const program = (requested && programs.find((p) => p.id === Number(requested))) || programs[0] || null;
    return { programs, program, reasons: program ? listReasons(db, program.id) : [] };
  }
  if (tab === 'classes') {
    const classes = listClasses(db);
    return { classes, totals: new Map(classes.map((c) => [c.id, classTotal(db, c.id)])) };
  }
  if (tab === 'users') {
    const users = listUsers(db);
    // Budgets only matter for programs that hand out style points.
    const budgetPrograms = listPrograms(db).filter((p) => p.style_budget > 0 || listReasons(db, p.id).some((r) => r.kind === 'style'));
    const budgets = new Map();
    for (const u of users) for (const p of budgetPrograms) budgets.set(`${u.id}:${p.id}`, styleBudget(db, u.id, p.id));
    return { users, classes: listClasses(db), budgetPrograms, budgets };
  }
  if (tab === 'casino') {
    return {
      games: listGames(db),
      staff: listUsers(db).filter((u) => u.is_casino),
      casinoPrograms: casinoPrograms(db).map((program) => ({ program, reconciliation: reconciliation(db, program.id), preview: conversionPreview(db, program.id) })),
    };
  }
  if (tab === 'snapshots') return { snapshots: listSnapshots(db) };
  return {};
}

function showSuper(ctx, pathWithQuery, { error = null, status = 200 } = {}) {
  const url = new URL(pathWithQuery, 'http://localhost');
  const requested = url.searchParams.get('tab');
  const tab = TABS.includes(requested) ? requested : 'settings';
  render(ctx, superPage(ctx, { tab, error, ...tabData(ctx, tab, url) }), { title: ctx.t('nav.super'), status });
}

/** Superadmin writes: success returns to where the form was; a rule problem re-renders that tab. */
function superWrite(ctx, fallback, action, flashKey = 'changed') {
  const back = safeLocalPath(ctx.form.get('back'), fallback);
  const target = back.startsWith('/admin/super') ? back : fallback;
  try {
    action();
  } catch (err) {
    if (err instanceof ValidationError) return showSuper(ctx, target, { error: err, status: 400 });
    throw err;
  }
  redirectWithFlash(ctx, target, flashKey);
}

export function registerSuperRoutes(router) {
  const superadmin = requireRole('superadmin');
  const base = (ctx) => ({ actor: ctx.user, now: ctx.now, ip: ctx.ip });

  router.get('/admin/super', superadmin, (ctx) => showSuper(ctx, ctx.url.pathname + ctx.url.search));

  router.post('/admin/super/change', superadmin, (ctx) =>
    superWrite(ctx, '/admin/super', () =>
      applyChange(ctx.db, { ...base(ctx), target: ctx.form.get('target') ?? '', op: ctx.form.get('op') ?? '', value: ctx.form.get('value') ?? '', note: ctx.form.get('note') ?? '' }),
    ),
  );

  router.post('/admin/super/classes', superadmin, (ctx) =>
    superWrite(ctx, '/admin/super?tab=classes', () => createClasses(ctx.db, { ...base(ctx), names: ctx.form.get('names') }), 'created'),
  );

  router.post('/admin/super/programs', superadmin, (ctx) =>
    superWrite(ctx, '/admin/super?tab=programs', () => createProgram(ctx.db, { ...base(ctx), nameHu: ctx.form.get('nameHu'), nameEn: ctx.form.get('nameEn') }), 'created'),
  );

  router.post('/admin/super/reasons', superadmin, (ctx) => {
    const programId = idParam(ctx.form.get('programId'));
    superWrite(
      ctx,
      `/admin/super?tab=reasons&program=${programId}`,
      () => createReason(ctx.db, { ...base(ctx), programId, nameHu: ctx.form.get('nameHu'), nameEn: ctx.form.get('nameEn'), kind: ctx.form.get('kind') }),
      'created',
    );
  });

  router.post('/admin/super/params', superadmin, (ctx) =>
    superWrite(ctx, '/admin/super?tab=reasons', () =>
      addParam(ctx.db, { ...base(ctx), reasonId: idParam(ctx.form.get('reasonId')), name: ctx.form.get('name'), value: ctx.form.get('value') }),
    ),
  );

  router.post('/admin/super/params/remove', superadmin, (ctx) =>
    superWrite(ctx, '/admin/super?tab=reasons', () =>
      removeParam(ctx.db, { ...base(ctx), reasonId: idParam(ctx.form.get('reasonId')), name: ctx.form.get('name') ?? '' }),
    ),
  );

  router.post('/admin/super/games', superadmin, (ctx) =>
    superWrite(ctx, '/admin/super?tab=casino', () => createGame(ctx.db, { ...base(ctx), nameHu: ctx.form.get('nameHu'), nameEn: ctx.form.get('nameEn'), kind: ctx.form.get('kind') }), 'created'),
  );

  router.post('/admin/super/snapshots', superadmin, (ctx) =>
    superWrite(ctx, '/admin/super?tab=snapshots', () => publishSnapshot(ctx.db, { ...base(ctx), label: ctx.form.get('label') }), 'published'),
  );

  router.post('/admin/super/casino/:programId/count', superadmin, (ctx) => {
    const programId = idParam(ctx.params.programId);
    if (!getProgram(ctx.db, programId)) throw new HttpError(404);
    superWrite(ctx, `/admin/super?tab=casino#casino-${programId}`, () =>
      recordCount(ctx.db, ctx.settings, { ...base(ctx), programId, staffId: ctx.form.get('staffId'), chips: ctx.form.get('chips') }),
    );
  });

  router.post('/admin/super/casino/:programId/convert', superadmin, (ctx) => {
    const programId = idParam(ctx.params.programId);
    superWrite(ctx, `/admin/super?tab=casino#casino-${programId}`, () => convertCashouts(ctx.db, { ...base(ctx), programId }), 'converted');
  });
}
