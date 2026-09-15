// Loads everything the detectors need, in one pass, for one program (or all).

import { nameKey } from '../names.js';

export function loadData(db, settings, programId = null) {
  const scope = programId === null ? '1 = 1' : 'e.program_id = $program';
  const entries = db
    .prepare(`
      SELECT e.*, r.kind, r.min_points, r.max_points, r.formula, r.name_hu AS reason_hu, r.name_en AS reason_en,
             c.name AS class_name, u.username AS creator, u.display_name AS creator_name,
             u.class_id AS creator_class, u.is_casino AS creator_casino, u.role AS creator_role
      FROM entries e
      JOIN classes c ON c.id = e.class_id
      JOIN users u ON u.id = e.created_by
      LEFT JOIN reasons r ON r.id = e.reason_id
      WHERE ${scope}
      ORDER BY e.id`)
    .all(programId === null ? {} : { program: programId });

  const params = new Map();
  for (const p of db.prepare('SELECT reason_id, name, value FROM reason_params').all()) {
    if (!params.has(p.reason_id)) params.set(p.reason_id, {});
    params.get(p.reason_id)[p.name] = p.value;
  }

  // Every ledger entry must have been written by the app, which always logs it.
  const audited = new Set();
  for (const row of db.prepare(`SELECT subject FROM audit_log WHERE action IN ('entry.create', 'entry.correct', 'entry.adjust')`).all()) {
    for (const id of row.subject.replace(/^entry:/, '').split(',')) audited.add(Number(id));
  }
  const conversionBatches = new Set(
    db.prepare(`SELECT details FROM audit_log WHERE action = 'casino.convert'`).all().map((r) => JSON.parse(r.details).batch),
  );

  const statusChanges = db
    .prepare(`SELECT subject, created_at, details FROM audit_log WHERE action = 'value.set' AND subject LIKE 'program:%:status' ORDER BY id`)
    .all()
    .map((r) => ({ programId: Number(r.subject.split(':')[1]), at: r.created_at, status: JSON.parse(r.details).after }));

  const casinoScope = programId === null ? '1 = 1' : 'v.program_id = $program';
  const bind = programId === null ? {} : { program: programId };
  const cashouts = db
    .prepare(`
      SELECT co.*, v.program_id, v.class_id, v.person_name, v.person_key, v.start_chips, v.recorded,
             v.created_at AS visit_at, c.name AS class_name, u.username AS creator, u.class_id AS creator_class
      FROM casino_cashouts co JOIN casino_visits v ON v.id = co.visit_id
      JOIN classes c ON c.id = v.class_id JOIN users u ON u.id = co.created_by
      WHERE ${casinoScope} AND co.voided_at IS NULL AND v.voided_at IS NULL`)
    .all(bind);
  const visits = db.prepare(`SELECT v.* FROM casino_visits v WHERE ${casinoScope} AND v.voided_at IS NULL`).all(bind);
  const rounds = db
    .prepare(`
      SELECT r.*, g.kind AS game_kind, g.name_hu AS game_hu, g.name_en AS game_en, u.username AS creator, u.class_id AS creator_class
      FROM casino_rounds r JOIN casino_games g ON g.id = r.game_id JOIN users u ON u.id = r.created_by
      WHERE ${programId === null ? '1 = 1' : 'r.program_id = $program'} AND r.voided_at IS NULL`)
    .all(bind);
  const results = db
    .prepare(`
      SELECT res.*, v.class_id, v.person_key FROM casino_results res
      JOIN casino_rounds r ON r.id = res.round_id JOIN casino_visits v ON v.id = res.visit_id
      WHERE ${programId === null ? '1 = 1' : 'r.program_id = $program'} AND r.voided_at IS NULL`)
    .all(bind);
  const counts = db
    .prepare(`
      SELECT cc.* FROM casino_counts cc
      WHERE cc.id IN (SELECT MAX(id) FROM casino_counts GROUP BY program_id, staff_id)
      ${programId === null ? '' : 'AND cc.program_id = $program'}`)
    .all(bind);

  const users = db.prepare('SELECT id, username, display_name, class_id, is_casino FROM users').all();

  return {
    programId,
    entries,
    active: entries.filter((e) => !e.voided_at),
    params,
    audited,
    conversionBatches,
    statusChanges,
    programs: new Map(db.prepare('SELECT * FROM programs').all().map((p) => [p.id, p])),
    budgets: db.prepare('SELECT * FROM budgets').all(),
    largestLimit: db.prepare('SELECT COALESCE(MAX(ABS(max_points)), 0) AS n FROM reasons').get().n,
    snapshots: db.prepare('SELECT created_at FROM snapshots ORDER BY id').all().map((s) => s.created_at),
    users,
    organizerKeys: new Map(users.map((u) => [nameKey(u.display_name), u])),
    cashouts,
    visits,
    rounds,
    results,
    counts,
    timerFeatureOn: settings.get('features.timer'),
    ownClassMode: settings.get('rules.own_class'),
  };
}
