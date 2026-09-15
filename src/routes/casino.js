// Casino staff routes (Rulebook §5).

import { isSuperadmin } from '../auth/roles.js';
import { casinoPrograms, listVisits, recordCashout, recordRound, recordVisit, voidCasinoRecord } from '../domain/casino.js';
import { listClasses, listGames } from '../domain/catalog.js';
import { HttpError } from '../http/errors.js';
import { casinoPage, ROUND_ROWS } from '../views/admin/casino.js';
import { attempt, formRows, idParam, nonceOf, redirectWithFlash, render, requireCasinoStaff, requireFeature } from './helpers.js';

function chooseProgram(ctx, programs, requested) {
  if (requested) return programs.find((p) => p.id === requested) ?? null;
  return programs.find((p) => p.status === 'open') ?? programs[0] ?? null;
}

/** The staff member's own records (all records for the superadmin), newest first. */
function recentRecords(ctx, programId) {
  const mine = isSuperadmin(ctx.user) ? '' : 'AND x.created_by = $user';
  const bind = isSuperadmin(ctx.user) ? { program: programId } : { program: programId, user: ctx.user.id };
  const { db, lang } = ctx;
  const nameCol = lang === 'en' ? 'g.name_en' : 'g.name_hu';
  return db
    .prepare(`
      SELECT 'visit' AS kind, x.id, x.created_at, x.created_by, x.voided_at, x.person_name AS name, c.name AS className, x.start_chips AS chips, NULL AS game, NULL AS players
        FROM casino_visits x JOIN classes c ON c.id = x.class_id
        WHERE x.program_id = $program AND x.recorded = 1 ${mine}
      UNION ALL
      SELECT 'cashout', x.id, x.created_at, x.created_by, x.voided_at, v.person_name, c.name, x.chips, NULL, NULL
        FROM casino_cashouts x JOIN casino_visits v ON v.id = x.visit_id JOIN classes c ON c.id = v.class_id
        WHERE v.program_id = $program ${mine}
      UNION ALL
      SELECT 'round', x.id, x.created_at, x.created_by, x.voided_at, NULL, NULL, NULL, ${nameCol},
             (SELECT COUNT(*) FROM casino_results r WHERE r.round_id = x.id)
        FROM casino_rounds x JOIN casino_games g ON g.id = x.game_id
        WHERE x.program_id = $program ${mine}
      ORDER BY created_at DESC LIMIT 40`)
    .all(bind);
}

function showCasino(ctx, programId, form = { kind: null }, status = 200) {
  const programs = casinoPrograms(ctx.db);
  const program = chooseProgram(ctx, programs, programId);
  const data = program
    ? {
        classes: listClasses(ctx.db, { activeOnly: true }),
        visits: listVisits(ctx.db, program.id, { openOnly: true }),
        games: listGames(ctx.db, { activeOnly: true }),
        records: recentRecords(ctx, program.id),
      }
    : { classes: [], visits: [], games: [], records: [] };
  render(ctx, casinoPage(ctx, { programs, program, form, ...data }), { title: ctx.t('nav.casino'), status });
}

const guards = [requireCasinoStaff, requireFeature('casino.enabled')];

export function registerCasinoRoutes(router) {
  router.get('/admin/casino', ...guards, (ctx) => {
    const requested = ctx.url.searchParams.get('program');
    showCasino(ctx, requested ? idParam(requested) : null);
  });

  /** Shared shape of the three casino writes: run, or re-render the form with the problem. */
  const write = (kind, readValues, action) => (ctx) => {
    const programId = idParam(ctx.params.programId);
    const values = readValues(ctx.form);
    const nonce = nonceOf(ctx.form);
    const outcome = attempt(
      () => action(ctx, { programId, values, nonce, confirmed: ctx.form.get('confirmed') === '1' }),
      (problem, status) => showCasino(ctx, programId, { kind, values, nonce: nonce ?? undefined, ...problem }, status),
    );
    if (outcome.ok) redirectWithFlash(ctx, `/admin/casino?program=${programId}`, `casino_${kind}`);
  };

  router.post(
    '/admin/casino/:programId/visit',
    ...guards,
    write(
      'visit',
      (form) => ({ classId: form.get('classId') ?? '', name: form.get('name') ?? '' }),
      (ctx, { programId, values, nonce, confirmed }) =>
        recordVisit(ctx.db, ctx.settings, { actor: ctx.user, programId, ...values, confirmed, nonce, now: ctx.now, ip: ctx.ip }),
    ),
  );

  router.post(
    '/admin/casino/:programId/cashout',
    ...guards,
    write(
      'cashout',
      (form) => ({ visitId: form.get('visitId') ?? '', classId: form.get('classId') ?? '', name: form.get('name') ?? '', chips: form.get('chips') ?? '' }),
      (ctx, { programId, values, nonce, confirmed }) =>
        recordCashout(ctx.db, ctx.settings, { actor: ctx.user, programId, ...values, confirmed, nonce, now: ctx.now, ip: ctx.ip }),
    ),
  );

  router.post(
    '/admin/casino/:programId/round',
    ...guards,
    write(
      'round',
      (form) => ({ gameId: form.get('gameId') ?? '', results: formRows(form, 'results', ['visitId', 'delta'], ROUND_ROWS) }),
      (ctx, { programId, values, nonce }) =>
        recordRound(ctx.db, ctx.settings, { actor: ctx.user, programId, gameId: values.gameId, results: values.results, nonce, now: ctx.now, ip: ctx.ip }),
    ),
  );

  router.post('/admin/casino/void/:kind/:id', ...guards, (ctx) => {
    if (!['visit', 'cashout', 'round'].includes(ctx.params.kind)) throw new HttpError(404);
    voidCasinoRecord(ctx.db, ctx.settings, { actor: ctx.user, kind: ctx.params.kind, id: idParam(ctx.params.id), reason: ctx.form.get('reason'), now: ctx.now, ip: ctx.ip });
    redirectWithFlash(ctx, '/admin/casino', 'voided');
  });
}
