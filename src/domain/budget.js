// Style point allowances (Rulebook §4.2).
//
// Each organizer may hand out a limited number of style points per program
// (90 at the Opening party). The allowance is the program default unless the
// superadmin set a personal amount. "Spent" is always recomputed from the
// ledger, so a voided entry automatically gives its points back.

export function styleBudget(db, userId, programId) {
  const program = db.prepare('SELECT style_budget FROM programs WHERE id = ?').get(programId);
  const custom = db.prepare('SELECT amount FROM budgets WHERE user_id = ? AND program_id = ?').get(userId, programId);
  const { spent } = db
    .prepare(`
      SELECT COALESCE(SUM(e.amount), 0) AS spent
      FROM entries e JOIN reasons r ON r.id = e.reason_id
      WHERE e.created_by = ? AND e.program_id = ? AND r.kind = 'style' AND e.voided_at IS NULL`)
    .get(userId, programId);
  const allotted = custom ? custom.amount : (program?.style_budget ?? 0);
  return { allotted, spent, remaining: allotted - spent, custom: Boolean(custom) };
}

export function setAllotted(db, userId, programId, amount) {
  db.prepare(`
    INSERT INTO budgets (user_id, program_id, amount) VALUES (?, ?, ?)
    ON CONFLICT (user_id, program_id) DO UPDATE SET amount = excluded.amount`).run(userId, programId, amount);
}
