// Serves the few files in /public. They are loaded into memory once at startup,
// so a request can only ever reach a file from that list (no path traversal).
// In production nginx serves /static/ directly; this is the fallback and dev server.
//
// Pages link files with a short hash of their content (style.css?v=3f2a...), so
// after a deploy browsers fetch the new version instead of a cached old one.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';

const TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
};

export function loadStaticFiles(dir) {
  const files = new Map();
  for (const name of readdirSync(dir)) {
    const type = TYPES[extname(name)];
    if (!type) continue;
    const body = readFileSync(join(dir, name));
    files.set(name, { body, type, version: createHash('sha256').update(body).digest('hex').slice(0, 10) });
  }
  return files;
}

/** URL of a static file that changes whenever the file's content changes. */
export function assetUrl(files, name) {
  const file = files.get(name);
  return file ? `/static/${name}?v=${file.version}` : `/static/${name}`;
}

export function serveStatic(files, name, res) {
  const file = files.get(name);
  if (!file) return false;
  res.statusCode = 200;
  res.setHeader('Content-Type', file.type);
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.end(file.body);
  return true;
}
