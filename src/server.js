// Entry point: node src/server.js (see package.json and deploy/README.md).

import { createServer } from 'node:http';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db/database.js';

const config = loadConfig();
const db = openDatabase(config.dbPath);
const server = createServer(createApp({ db, config }));

server.headersTimeout = 20_000;
server.requestTimeout = 30_000;

server.listen(config.port, config.host, () => {
  console.log(`szigzug listening on http://${config.host}:${config.port} (database: ${config.dbPath})`);
});

function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
