import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { describe, test } from 'node:test';
import { HttpError, ValidationError } from '../../src/http/errors.js';
import { escapeHtml, html, raw, SafeHtml } from '../../src/http/html.js';
import { clientIp, isSameOrigin, MAX_BODY_BYTES, parseCookies, readForm } from '../../src/http/request.js';
import { applySecurityHeaders, redirect, safeLocalPath, send, setCookie } from '../../src/http/response.js';
import { createRouter } from '../../src/http/router.js';

function fakeRequest(body, headers = {}) {
  const req = Readable.from(body === null ? [] : [Buffer.from(body)]);
  req.headers = { 'content-type': 'application/x-www-form-urlencoded', ...headers };
  return req;
}

function fakeResponse() {
  const headers = {};
  return {
    headers,
    statusCode: 200,
    body: null,
    setHeader: (name, value) => (headers[name.toLowerCase()] = value),
    getHeader: (name) => headers[name.toLowerCase()],
    end(body) {
      this.body = body;
    },
  };
}

describe('html templating', () => {
  test('escapes every interpolated value', () => {
    const name = `<script>alert("x")</script> & 'quotes'`;
    assert.equal(
      html`<p title="${name}">${name}</p>`.toString(),
      '<p title="&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;quotes&#39;">&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;quotes&#39;</p>',
    );
  });

  test('nests templates without double escaping and joins arrays', () => {
    const items = ['a<b', 'c'].map((x) => html`<li>${x}</li>`);
    assert.equal(html`<ul>${items}</ul>`.toString(), '<ul><li>a&lt;b</li><li>c</li></ul>');
  });

  test('renders null, undefined and false as nothing, but keeps 0', () => {
    assert.equal(html`[${null}${undefined}${false}${0}]`.toString(), '[0]');
  });

  test('raw() is the only way to insert markup', () => {
    assert.ok(raw('<b>') instanceof SafeHtml);
    assert.equal(html`${raw('<b>ok</b>')}`.toString(), '<b>ok</b>');
    assert.equal(escapeHtml(42), '42');
  });
});

describe('router', () => {
  const router = createRouter();
  const a = () => 'a';
  const b = () => 'b';
  router.get('/admin/award/:reasonId', a);
  router.post('/admin/award/:reasonId', b);
  router.get('/', a);

  test('matches literal and parameter segments', () => {
    assert.deepEqual(router.match('GET', '/admin/award/12').params, { reasonId: '12' });
    assert.equal(router.match('POST', '/admin/award/12').handlers[0], b);
    assert.deepEqual(router.match('GET', '/').params, {});
  });

  test('ignores trailing and duplicate slashes', () => {
    assert.ok(router.match('GET', '/admin//award/5/'));
  });

  test('HEAD is served by GET routes', () => {
    assert.equal(router.match('HEAD', '/').handlers[0], a);
  });

  test('distinguishes unknown paths from wrong methods', () => {
    assert.equal(router.match('GET', '/nope'), null);
    assert.deepEqual(router.match('DELETE', '/admin/award/1'), { methodNotAllowed: true });
  });

  test('decodes parameters and rejects malformed percent-encoding', () => {
    assert.equal(router.match('GET', '/admin/award/%C3%A9').params.reasonId, 'é');
    assert.equal(router.match('GET', '/admin/award/%E0%A4%A'), null);
  });
});

describe('request parsing', () => {
  test('parses cookies, tolerating junk and bad encoding', () => {
    assert.deepEqual(parseCookies('sid=abc; lang=hu; =x; broken; theme=%E0%A4%A; x=a%20b'), {
      sid: 'abc',
      lang: 'hu',
      theme: '%E0%A4%A',
      x: 'a b',
    });
    assert.deepEqual(parseCookies(undefined), {});
  });

  test('reads url-encoded forms, including repeated keys and unicode', async () => {
    const form = await readForm(fakeRequest('name=Kov%C3%A1cs+P%C3%A9ter&a=1&a=2'));
    assert.equal(form.get('name'), 'Kovács Péter');
    assert.deepEqual(form.getAll('a'), ['1', '2']);
  });

  test('rejects other content types', async () => {
    await assert.rejects(readForm(fakeRequest('{}', { 'content-type': 'application/json' })), (err) => err.status === 415);
    await assert.rejects(readForm(fakeRequest('x', { 'content-type': undefined })), (err) => err.status === 415);
  });

  test('rejects bodies over the limit, whether declared or streamed', async () => {
    await assert.rejects(readForm(fakeRequest('a=1', { 'content-length': String(MAX_BODY_BYTES + 1) })), (err) => err.status === 413);
    await assert.rejects(readForm(fakeRequest('a='.padEnd(MAX_BODY_BYTES + 10, 'x'))), (err) => err.status === 413);
  });

  test('uses X-Forwarded-For only when the proxy is trusted', () => {
    const req = { headers: { 'x-forwarded-for': '1.2.3.4, 10.0.0.1' }, socket: { remoteAddress: '127.0.0.1' } };
    assert.equal(clientIp(req, true), '1.2.3.4');
    assert.equal(clientIp(req, false), '127.0.0.1');
    assert.equal(clientIp({ headers: {}, socket: {} }, true), '');
  });

  test('same-origin check uses Origin, then Referer, and fails closed', () => {
    const host = 'szigzug.hu';
    assert.equal(isSameOrigin({ headers: { host, origin: 'https://szigzug.hu' } }), true);
    assert.equal(isSameOrigin({ headers: { host, referer: 'https://szigzug.hu/admin' } }), true);
    assert.equal(isSameOrigin({ headers: { host, origin: 'https://evil.example' } }), false);
    assert.equal(isSameOrigin({ headers: { host, origin: 'https://szigzug.hu.evil.example' } }), false);
    assert.equal(isSameOrigin({ headers: { host, origin: 'null' } }), false);
    assert.equal(isSameOrigin({ headers: { host } }), false);
  });
});

describe('responses', () => {
  test('security headers forbid framing, sniffing and foreign scripts', () => {
    const res = fakeResponse();
    applySecurityHeaders(res);
    assert.match(res.headers['content-security-policy'], /script-src 'self'/);
    assert.match(res.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.equal(res.headers['x-frame-options'], 'DENY');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
  });

  test('cookies are HttpOnly and SameSite by default, and accumulate', () => {
    const res = fakeResponse();
    setCookie(res, 'sid', 'a b', { maxAge: 60, secure: true });
    setCookie(res, 'lang', 'hu', { httpOnly: false });
    assert.deepEqual(res.headers['set-cookie'], ['sid=a%20b; Path=/; SameSite=Lax; Max-Age=60; HttpOnly; Secure', 'lang=hu; Path=/; SameSite=Lax']);
  });

  test('send and redirect', () => {
    const res = fakeResponse();
    send(res, 404, 'x', 'text/plain');
    assert.equal(res.statusCode, 404);
    assert.equal(res.headers['cache-control'], 'no-store');
    const r2 = fakeResponse();
    redirect(r2, '/admin');
    assert.equal(r2.statusCode, 303);
    assert.equal(r2.headers.location, '/admin');
  });

  test('only local paths are accepted as redirect targets', () => {
    assert.equal(safeLocalPath('/admin?x=1#a'), '/admin?x=1#a');
    for (const bad of ['//evil.example', 'https://evil.example', '/\\evil.example', 'admin', '', null, undefined, 42]) {
      assert.equal(safeLocalPath(bad, '/fallback'), '/fallback');
    }
  });

  test('asset URLs carry a content hash that changes with the content', async () => {
    const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { assetUrl, loadStaticFiles } = await import('../../src/http/static.js');
    const dir = mkdtempSync(join(tmpdir(), 'szigzug-static-'));
    try {
      writeFileSync(join(dir, 'a.css'), 'body{color:red}');
      writeFileSync(join(dir, 'secret.env'), 'SECRET=1');
      const first = assetUrl(loadStaticFiles(dir), 'a.css');
      writeFileSync(join(dir, 'a.css'), 'body{color:blue}');
      const files = loadStaticFiles(dir);
      assert.match(first, /^\/static\/a\.css\?v=[0-9a-f]{10}$/);
      assert.notEqual(assetUrl(files, 'a.css'), first);
      assert.equal(files.has('secret.env'), false, 'only known file types are served');
      assert.equal(assetUrl(files, 'missing.js'), '/static/missing.js');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('error classes carry status and message key', () => {
    const err = new HttpError(403, 'error.featureOff', { a: 1 });
    assert.equal(err.status, 403);
    assert.equal(err.messageKey, 'error.featureOff');
    assert.deepEqual(new HttpError(404).messageKey, 'error.404');
    const v = new ValidationError('error.required');
    assert.ok(v instanceof HttpError);
    assert.equal(v.status, 400);
  });
});
