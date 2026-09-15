// Log admin routes: the event log and the suspicion report (Rulebook §3.7, §8.3).

import { verifyAuditChain } from '../domain/audit.js';
import { listPrograms } from '../domain/catalog.js';
import { analyze } from '../domain/suspicion/index.js';
import { logPage, suspicionPage } from '../views/admin/review.js';
import { idParam, render, requireFeature, requireRole } from './helpers.js';

const PAGE_SIZE = 100;

export function registerReviewRoutes(router) {
  router.get('/admin/log', requireRole('logadmin'), requireFeature('features.log'), (ctx) => {
    const { db, url } = ctx;
    const filters = { action: url.searchParams.get('action') ?? '', actor: url.searchParams.get('actor') ?? '' };
    const before = url.searchParams.get('before');
    const rows = db
      .prepare(`
        SELECT * FROM audit_log
        WHERE ($action = '' OR action = $action) AND ($actor = '' OR actor = $actor) AND ($before IS NULL OR id < $before)
        ORDER BY id DESC LIMIT ${PAGE_SIZE + 1}`)
      .all({ action: filters.action, actor: filters.actor, before: before ? idParam(before) : null });
    const page = rows.slice(0, PAGE_SIZE);
    render(
      ctx,
      logPage(ctx, {
        rows: page,
        chain: verifyAuditChain(db),
        actions: db.prepare('SELECT DISTINCT action FROM audit_log ORDER BY action').all().map((r) => r.action),
        actors: db.prepare('SELECT DISTINCT actor FROM audit_log ORDER BY actor').all().map((r) => r.actor),
        filters,
        nextBefore: rows.length > PAGE_SIZE ? page.at(-1).id : null,
      }),
      { title: ctx.t('log.title') },
    );
  });

  router.get('/admin/suspicion', requireRole('logadmin'), requireFeature('features.suspicion'), (ctx) => {
    const requested = ctx.url.searchParams.get('program');
    const programId = requested ? idParam(requested) : null;
    const items = analyze(ctx.db, ctx.settings, { programId });
    render(
      ctx,
      suspicionPage(ctx, { programs: listPrograms(ctx.db), programId, items, threshold: ctx.settings.get('suspicion.threshold') }),
      { title: ctx.t('suspicion.title') },
    );
  });
}
