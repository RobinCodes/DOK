# szigzug.hu

Website and admin panel of the **jubilee points competition** of the school's 125th year, organized by the student council (DÖK), reachable at [szigzug.hu](https://szigzug.hu).

- **Public page** (`/`): everything about the competition in Hungarian, or in English for browsers set to another language, plus the published top 10 classes.
- **Admin panel** (`/admin`): personal accounts created on the server console, in three nested levels (organizer, log admin, superadmin), plus casino staff.
  - Points ledger with storno and corrections that never rewrite history.
  - Style point allowances, check-in/out timers, shared pools, and a modular casino (light, visit or detailed-game mode).
  - The superadmin can view, set, change by ±n or switch off every value and module at runtime.
  - A hash-chained, append-only event log and a 1–100 suspicion score for every record.

## Technology

Node.js 22.13 or newer with **no npm dependencies**: `node:http`, `node:sqlite` and `node:test`. Nothing to install besides Node itself.

## Running it locally

```bash
npm run dev                  # http://localhost:3000, database in data/szigzug.db (created automatically)
npm run users -- create robin --name "Rovenszky Robin" --role superadmin
```

Then log in at <http://localhost:3000/admin> and add the classes under *Szuperadmin → Osztályok*.

Environment variables (all optional locally): `PORT` (3000), `HOST` (127.0.0.1), `DB_PATH` (data/szigzug.db), `NODE_ENV`, `COOKIE_SECURE`, `TRUST_PROXY`. Everything else is a runtime setting stored in the database.

## Tests

```bash
npm test                     # unit, domain, property-based, HTTP and CLI tests
npm run coverage             # the same with a coverage report
```

GitHub Actions runs the suite on Node 22 and 24 for every push, and the deploy script runs it again on the server before switching versions.

## Structure

```
src/
  server.js          entry point
  app.js             request handling, CSRF checks, error pages
  config.js          environment variables
  http/              small HTTP layer: router, auto-escaping HTML templates, form parsing, security headers
  db/                SQLite schema (with integrity triggers) and seed data from the rulebook
  auth/              scrypt passwords, sessions, login throttling, roles
  domain/            business logic, independent of HTTP
    awards.js        points ledger: award, storno, correction, superadmin adjustments
    rules/           anti-cheat rules, each documented with its purpose and rulebook section
    timers.js        check-in/check-out participation timers
    casino.js        casino modes, balances, reconciliation, conversion to points
    manage.js        every superadmin change (set / adjust / toggle) in one audited path
    formula.js       safe evaluator for the configurable point formulas
    audit.js         hash-chained event log
    suspicion/       suspicion score: statistical and game-theory detectors
  routes/            URL handlers
  views/             HTML templates
  i18n/              Hungarian and English texts
  cli/               console account management
bin/                 users.js (accounts), backup.js (backups + log integrity check)
public/              style.css, app.js, favicon.svg
deploy/              server guide (HTTPS, updates, backups), nginx, systemd, deploy script
test/                unit/, domain/, http/, cli/
```

Code comments refer to sections of the detailed rulebook (e.g. *Rulebook §4.2*), which is kept outside the repository.

## Deployment

See **[deploy/README.md](deploy/README.md)**: server setup on the netcup VPS, HTTPS with Let's Encrypt, automatic deploys from GitHub, manual updates, backups and a go-live checklist.
