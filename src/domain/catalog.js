// Read access to the configurable catalog: classes, programs, reasons and casino games.

export const REASON_KINDS = ['manual', 'style', 'formula', 'minutes', 'pool', 'casino'];

/** Variables that the system fills in for a kind (the admin never types them). */
export const SYSTEM_VARIABLES = {
  pool: ['participants'],
  casino: ['chips', 'start', 'net', 'minutes'],
};

/** Picks the Hungarian or English column, falling back to Hungarian. */
export const localized = (row, field, lang) => row?.[`${field}_${lang}`] || row?.[`${field}_hu`] || '';

export function listClasses(db, { activeOnly = false } = {}) {
  const where = activeOnly ? 'WHERE active = 1' : '';
  return db.prepare(`SELECT * FROM classes ${where} ORDER BY sort, name`).all();
}

export const getClass = (db, id) => db.prepare('SELECT * FROM classes WHERE id = ?').get(id);

export function listPrograms(db, { status } = {}) {
  if (status) return db.prepare('SELECT * FROM programs WHERE status = ? ORDER BY sort, id').all(status);
  return db.prepare('SELECT * FROM programs ORDER BY sort, id').all();
}

export const getProgram = (db, id) => db.prepare('SELECT * FROM programs WHERE id = ?').get(id);

export function reasonParams(db, reasonId) {
  const params = {};
  for (const row of db.prepare('SELECT name, value FROM reason_params WHERE reason_id = ? ORDER BY name').all(reasonId)) {
    params[row.name] = row.value;
  }
  return params;
}

export function getReason(db, id) {
  const reason = db.prepare('SELECT * FROM reasons WHERE id = ?').get(id);
  return reason ? { ...reason, params: reasonParams(db, id) } : null;
}

export function listReasons(db, programId, { activeOnly = false } = {}) {
  const where = activeOnly ? 'AND active = 1' : '';
  return db
    .prepare(`SELECT * FROM reasons WHERE program_id = ? ${where} ORDER BY sort, id`)
    .all(programId)
    .map((r) => ({ ...r, params: reasonParams(db, r.id) }));
}

export function listGames(db, { activeOnly = false } = {}) {
  const where = activeOnly ? 'WHERE active = 1' : '';
  return db.prepare(`SELECT * FROM casino_games ${where} ORDER BY sort, id`).all();
}

export const getGame = (db, id) => db.prepare('SELECT * FROM casino_games WHERE id = ?').get(id);

export const getUser = (db, id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);

export function listUsers(db) {
  return db.prepare('SELECT id, username, display_name, role, is_casino, class_id, use_timer, active FROM users ORDER BY username').all();
}
