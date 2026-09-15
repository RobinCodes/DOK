// Account management for the server console (Rulebook §2.1).
// Accounts are deliberately NOT creatable through the website: only someone
// with shell access to the server can add an organizer or reset a password.

import { hashPassword, MIN_PASSWORD_LENGTH } from '../auth/passwords.js';
import { ROLES } from '../auth/roles.js';
import { destroyUserSessions } from '../auth/sessions.js';
import { CONSOLE, audit } from '../domain/audit.js';
import { cleanName } from '../domain/names.js';

export const USAGE = `Usage:
  users create <username> --name "Full Name" [--role admin|logadmin|superadmin] [--casino] [--class 9.A]
  users passwd <username>
  users role <username> <admin|logadmin|superadmin>
  users casino <username> <on|off>
  users disable <username>
  users enable <username>
  users list`;

export class CliError extends Error {}

const USERNAME = /^[a-z0-9][a-z0-9._-]{1,31}$/i;

function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--casino') flags.casino = true;
    else if (['--name', '--role', '--class'].includes(args[i])) flags[args[i].slice(2)] = args[++i];
    else if (args[i].startsWith('--')) throw new CliError(`Unknown option ${args[i]}`);
    else positional.push(args[i]);
  }
  return { flags, positional };
}

function findUser(db, username) {
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username ?? '');
  if (!user) throw new CliError(`No such user: ${username}`);
  return user;
}

async function askNewPassword(readPassword) {
  const password = await readPassword('New password: ');
  if (password.length < MIN_PASSWORD_LENGTH) throw new CliError(`The password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  if ((await readPassword('Repeat password: ')) !== password) throw new CliError('The passwords do not match.');
  return password;
}

/** Runs one command. `readPassword(prompt)` and `print(line)` are injected so tests can drive it. */
export async function runUsers(db, args, { readPassword, print, now = () => new Date().toISOString(), cost }) {
  const [command, ...rest] = args;
  const { flags, positional } = parseFlags(rest);
  const [username, value] = positional;

  switch (command) {
    case 'create': {
      if (!USERNAME.test(username ?? '')) throw new CliError('Username: 2–32 characters, letters, digits, dot, dash, underscore.');
      if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw new CliError(`User ${username} already exists.`);
      const role = flags.role ?? 'admin';
      if (!ROLES.includes(role)) throw new CliError(`Role must be one of: ${ROLES.join(', ')}`);
      const name = cleanName(flags.name);
      if (!name) throw new CliError('Give the person’s name with --name "Full Name".');
      let classId = null;
      if (flags.class) {
        const cls = db.prepare('SELECT id FROM classes WHERE name = ?').get(flags.class);
        if (!cls) throw new CliError(`No such class: ${flags.class} (add classes in the superadmin panel first).`);
        classId = cls.id;
      }
      const hash = await hashPassword(await askNewPassword(readPassword), cost);
      const { lastInsertRowid: id } = db
        .prepare('INSERT INTO users (username, display_name, password_hash, role, is_casino, class_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(username, name, hash, role, flags.casino ? 1 : 0, classId, now());
      audit(db, { actor: CONSOLE, action: 'user.create', subject: `user:${id}`, details: { username, name, role, casino: Boolean(flags.casino), classId }, at: now() });
      print(`Created ${role}${flags.casino ? ' (casino staff)' : ''}: ${username} (${name})`);
      return;
    }
    case 'passwd': {
      const user = findUser(db, username);
      const hash = await hashPassword(await askNewPassword(readPassword), cost);
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, user.id);
      destroyUserSessions(db, user.id);
      audit(db, { actor: CONSOLE, action: 'user.passwd', subject: `user:${user.id}`, at: now() });
      print(`Password changed for ${user.username}; their sessions were logged out.`);
      return;
    }
    case 'role': {
      const user = findUser(db, username);
      if (!ROLES.includes(value)) throw new CliError(`Role must be one of: ${ROLES.join(', ')}`);
      db.prepare('UPDATE users SET role = ? WHERE id = ?').run(value, user.id);
      destroyUserSessions(db, user.id);
      audit(db, { actor: CONSOLE, action: 'user.role', subject: `user:${user.id}`, details: { before: user.role, after: value }, at: now() });
      print(`${user.username} is now ${value}.`);
      return;
    }
    case 'casino': {
      const user = findUser(db, username);
      if (!['on', 'off'].includes(value)) throw new CliError('Use: users casino <username> on|off');
      db.prepare('UPDATE users SET is_casino = ? WHERE id = ?').run(value === 'on' ? 1 : 0, user.id);
      audit(db, { actor: CONSOLE, action: 'user.casino', subject: `user:${user.id}`, details: { after: value }, at: now() });
      print(`${user.username}: casino staff ${value}.`);
      return;
    }
    case 'disable':
    case 'enable': {
      const user = findUser(db, username);
      db.prepare('UPDATE users SET active = ? WHERE id = ?').run(command === 'enable' ? 1 : 0, user.id);
      if (command === 'disable') destroyUserSessions(db, user.id);
      audit(db, { actor: CONSOLE, action: `user.${command}`, subject: `user:${user.id}`, at: now() });
      print(`${user.username} ${command}d.`);
      return;
    }
    case 'list': {
      const users = db.prepare('SELECT u.*, c.name AS class_name FROM users u LEFT JOIN classes c ON c.id = u.class_id ORDER BY u.username').all();
      if (users.length === 0) print('No users yet.');
      for (const u of users) {
        const tags = [u.role, u.is_casino ? 'casino' : null, u.class_name, u.active ? null : 'DISABLED'].filter(Boolean).join(', ');
        print(`${u.username.padEnd(20)} ${u.display_name} [${tags}]`);
      }
      return;
    }
    default:
      throw new CliError(USAGE);
  }
}
