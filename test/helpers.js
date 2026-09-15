// Shared test fixtures. Not a test file itself (only *.test.js files are run).

import { createServer } from 'node:http';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/auth/passwords.js';
import { openDatabase } from '../src/db/database.js';
import { createSettings } from '../src/domain/settings.js';

export const PASSWORD = 'correct-horse-battery';

let cheapHash;
/** A low-cost scrypt hash, so tests don't spend seconds on key derivation. */
export async function testPasswordHash() {
  cheapHash ??= await hashPassword(PASSWORD, 1024);
  return cheapHash;
}

/**
 * A controllable clock. Every call returns the current time and then moves it
 * forward by `step` ms, so records get distinct, increasing timestamps like in real life.
 */
export function createClock(start = '2026-09-18T12:00:00.000Z', step = 1000) {
  let ms = Date.parse(start);
  const clock = () => {
    const current = ms;
    ms += step;
    return current;
  };
  clock.now = () => new Date(clock()).toISOString();
  clock.advance = (seconds) => {
    ms += seconds * 1000;
  };
  clock.peek = () => new Date(ms).toISOString();
  return clock;
}

const CLASS_NAMES = ['7.A', '9.A', '9.B', '10.A', '11.A'];
const ACCOUNTS = [
  // username, display name, role, casino staff, own class
  ['boss', 'Rovenszky Robin', 'superadmin', 0, null],
  ['logan', 'Nagy Zsófi', 'logadmin', 0, '10.A'],
  ['org', 'Tornai Bence', 'admin', 0, '9.A'],
  ['org2', 'Cseh Benedek', 'admin', 0, '9.B'],
  ['dealer', 'Császár Domonkos', 'admin', 1, '11.A'],
  ['dealer2', 'Máté Viktória', 'admin', 1, null],
];

/** A fresh in-memory world: seeded database, five classes, one account per role and an open Opening party. */
export async function createWorld({ openProgram = true, clock = createClock() } = {}) {
  const db = openDatabase(':memory:');
  const settings = createSettings(db);
  const hash = await testPasswordHash();

  const classes = {};
  for (const name of CLASS_NAMES) {
    classes[name] = db.prepare('INSERT INTO classes (name, sort) VALUES (?, ?)').run(name, Number.parseInt(name, 10)).lastInsertRowid;
  }

  const users = {};
  const insertUser = db.prepare(
    'INSERT INTO users (username, display_name, password_hash, role, is_casino, class_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  for (const [username, name, role, casino, className] of ACCOUNTS) {
    const id = insertUser.run(username, name, hash, role, casino, className ? classes[className] : null, '2026-09-01T00:00:00.000Z').lastInsertRowid;
    users[username] = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  }

  const program = db.prepare("SELECT * FROM programs WHERE slug = 'nyitobuli'").get();
  if (openProgram) db.prepare("UPDATE programs SET status = 'open' WHERE id = ?").run(program.id);
  const reasonList = db.prepare('SELECT * FROM reasons WHERE program_id = ? ORDER BY sort').all(program.id);
  const reasons = {
    style: reasonList.find((r) => r.kind === 'style').id,
    style2: reasonList.filter((r) => r.kind === 'style')[1].id,
    minutes: reasonList.find((r) => r.kind === 'minutes').id,
    menetlevel: reasonList.find((r) => r.formula.includes('stamps')).id,
    mini: reasonList.find((r) => r.formula.includes('participants') && r.kind === 'formula').id,
    pool: reasonList.find((r) => r.kind === 'pool').id,
    casino: reasonList.find((r) => r.kind === 'casino').id,
  };

  return {
    db,
    settings,
    clock,
    classes,
    users,
    program,
    reasons,
    user: (username) => db.prepare('SELECT * FROM users WHERE username = ?').get(username),
    programBySlug: (slug) => db.prepare('SELECT * FROM programs WHERE slug = ?').get(slug),
  };
}

/** Starts the real HTTP app on a random port. */
export async function startServer(world, config = {}) {
  const app = createApp({ db: world.db, config: { cookieSecure: false, trustProxy: false, ...config }, clock: world.clock });
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    client: (options) => createClient(base, options),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** A tiny browser: cookie jar, same-origin headers and automatic CSRF token. */
export function createClient(base, { language = 'hu-HU,hu;q=0.9' } = {}) {
  const cookies = new Map();
  let csrf = '';

  async function request(method, path, { form, headers = {}, origin = base } = {}) {
    const sent = { 'accept-language': language, ...headers };
    if (cookies.size) sent.cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    if (origin) sent.origin = origin;
    let body;
    if (form) {
      sent['content-type'] = sent['content-type'] ?? 'application/x-www-form-urlencoded';
      const params = form instanceof URLSearchParams ? form : new URLSearchParams({ csrf, ...form });
      body = params.toString();
    }
    const res = await fetch(base + path, { method, headers: sent, body, redirect: 'manual' });
    for (const line of res.headers.getSetCookie()) {
      const [pair, ...attributes] = line.split('; ');
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq);
      if (attributes.some((a) => a.toLowerCase() === 'max-age=0')) cookies.delete(name);
      else cookies.set(name, pair.slice(eq + 1));
    }
    const text = await res.text();
    const token = text.match(/name="csrf" value="([^"]+)"/);
    if (token) csrf = token[1];
    return { status: res.status, headers: res.headers, location: res.headers.get('location'), text };
  }

  const client = {
    cookies,
    get csrf() {
      return csrf;
    },
    get: (path, options) => request('GET', path, options),
    post: (path, form, options) => request('POST', path, { ...options, form }),
    async login(username, password = PASSWORD) {
      await request('GET', '/admin/login');
      const res = await request('POST', '/admin/login', { form: { username, password } });
      // Follow the redirect chain once so the CSRF token of the landing page is captured.
      let location = res.status === 303 ? res.location : null;
      for (let hops = 0; location && hops < 3; hops++) {
        const next = await request('GET', location);
        location = next.status === 303 ? next.location : null;
      }
      return res;
    },
  };
  return client;
}

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
export const decode = (text) => text.replace(/&(amp|lt|gt|quot|#39);/g, (m) => ENTITIES[m]);

/** The text of the first notice of a kind (ok, warn, error) on a page, decoded. */
export function notice(html, kind) {
  const m = html.match(new RegExp(`class="notice ${kind}"[^>]*>([\\s\\S]*?)</(p|div)>`));
  return m ? decode(m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()) : null;
}

/** Awards points directly through the domain layer (for tests that aren't about the HTTP layer). */
export function awardArgs(world, actor, reasonId, input, extra = {}) {
  return { actor: world.user(actor), reasonId, input, now: world.clock.now(), ...extra };
}
