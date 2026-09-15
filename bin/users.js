#!/usr/bin/env node
// Console account management. On the server:
//   sudo -u szigzug env DB_PATH=/var/lib/szigzug/szigzug.db node --disable-warning=ExperimentalWarning /opt/szigzug/bin/users.js list
// Passwords are typed without echo, or read line by line from stdin when piped.

import { createInterface } from 'node:readline';
import { CliError, runUsers } from '../src/cli/users.js';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';

function hiddenPrompt(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (text) => {
      if (text.startsWith(question)) process.stdout.write(question); // echo the prompt, never the typed characters
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

function pipedLines() {
  let buffered = null;
  return async () => {
    if (buffered === null) {
      let text = '';
      for await (const chunk of process.stdin) text += chunk;
      buffered = text.split(/\r?\n/);
    }
    return buffered.shift() ?? '';
  };
}

const readPassword = process.stdin.isTTY ? hiddenPrompt : pipedLines();
const db = openDatabase(loadConfig().dbPath);

try {
  await runUsers(db, process.argv.slice(2), { readPassword, print: (line) => console.log(line) });
} catch (err) {
  if (!(err instanceof CliError)) throw err;
  console.error(err.message);
  process.exitCode = 1;
} finally {
  db.close();
}
