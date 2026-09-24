import { createServer } from 'node:http';
import { createSecureServer } from 'node:http2';
import { promises as fs } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

const PORT = Number(process.env.PORT || 8443);
const HOST = process.env.HOST || '0.0.0.0';
const STORAGE_DIR = path.resolve(process.env.STORAGE_DIR || './storage');
const PUBLIC_DIR = path.resolve('./public');
const MAX_CHUNK_BYTES = Number(process.env.MAX_CHUNK_BYTES || 4 * 1024 * 1024) + 28;
const hmacKey = Buffer.from(process.env.STORAGE_HMAC_KEY || crypto.randomBytes(32).toString('hex'));
if (!process.env.STORAGE_HMAC_KEY) console.warn('WARNING: set STORAGE_HMAC_KEY for a stable deployment.');

const json = (res, status, value) => { const body = JSON.stringify(value); res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' }); res.end(body); };
const fail = (res, status, message) => json(res, status, { error: message });
const idOk = id => /^[a-f0-9]{32}$/.test(id);
const safeIndex = value => /^\d+$/.test(value) && Number(value) <= 10_000_000;
const fileDir = id => path.join(STORAGE_DIR, id);
const manifestPath = id => path.join(fileDir(id), 'manifest.json');
const chunkPath = (id, index) => path.join(fileDir(id), `chunk-${index}.bin`);
const macPath = (id, index) => path.join(fileDir(id), `chunk-${index}.hmac`);
const computeMac = (id, index, body) => crypto.createHmac('sha256', hmacKey).update(id).update(':').update(String(index)).update(':').update(body).digest('hex');
const headers = { 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' };

async function readBody(req, limit) {
  const parts = []; let size = 0;
  for await (const part of req) { size += part.length; if (size > limit) throw new Error('request body too large'); parts.push(part); }
  return Buffer.concat(parts);
}
async function readManifest(id) { return JSON.parse(await fs.readFile(manifestPath(id), 'utf8')); }
async function writeManifest(id, manifest) { await fs.writeFile(manifestPath(id), JSON.stringify(manifest, null, 2), { mode: 0o600 }); }
async function allChunksPresent(id, count) { for (let i = 0; i < count; i++) { try { await fs.access(chunkPath(id, i)); } catch { return false; } } return true; }

async function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const requested = url.pathname === '/' ? '/index.html' : url.pathname;
  const relative = decodeURIComponent(requested).replace(/^\/+/, '');
  if (relative.includes('..') || relative.includes('\\')) return false;
  const target = path.join(PUBLIC_DIR, relative);
  try {
    const stat = await fs.stat(target); if (!stat.isFile()) return false;
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };
    const body = req.method === 'HEAD' ? null : await fs.readFile(target);
    res.writeHead(200, { ...headers, 'content-type': types[path.extname(target)] || 'application/octet-stream', 'content-length': stat.size, 'cache-control': 'no-cache' });
    if (body) res.end(body); else res.end();
    return true;
  } catch { return false; }
}

async function completeHandler(req, res) {
  const match = new URL(req.url, `http://${HOST}`).pathname.match(/^\/api\/files\/([a-f0-9]{32})\/complete$/);
  if (req.method !== 'POST' || !match) return false;
  const id = match[1]; let manifest; try { manifest = await readManifest(id); } catch { fail(res, 404, 'file not found'); return true; }
  if (!(await allChunksPresent(id, manifest.totalChunks))) { fail(res, 409, 'not all chunks have been uploaded'); return true; }
  manifest.status = 'complete'; manifest.completedAt = new Date().toISOString(); await writeManifest(id, manifest); json(res, 200, { id, status: manifest.status }); return true;
}

async function apiHandler(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host || HOST}`);
    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { status: 'ok' });
    if (req.method === 'POST' && url.pathname === '/api/files/init') {
      const input = JSON.parse((await readBody(req, 1024 * 1024)).toString());
      if (!Number.isSafeInteger(input.size) || input.size < 0) return fail(res, 400, 'invalid size');
      if (!Number.isSafeInteger(input.chunkSize) || input.chunkSize < 64 * 1024 || input.chunkSize > 4 * 1024 * 1024) return fail(res, 400, 'chunkSize must be between 64KiB and 4MiB');
      if (typeof input.filename !== 'string' || !input.filename.trim() || input.filename.length > 255) return fail(res, 400, 'invalid filename');
      if (!/^[A-Za-z0-9+/=]{16,128}$/.test(input.salt || '')) return fail(res, 400, 'salt is required');
      const id = crypto.randomBytes(16).toString('hex'); const totalChunks = Math.max(1, Math.ceil(input.size / input.chunkSize));
      await fs.mkdir(fileDir(id), { recursive: true, mode: 0o700 });
      await writeManifest(id, { id, filename: path.basename(input.filename), size: input.size, chunkSize: input.chunkSize, totalChunks, salt: input.salt, kdf: input.kdf || 'scrypt', iterations: input.iterations || null, status: 'uploading', createdAt: new Date().toISOString() });
      return json(res, 201, { id, totalChunks, chunkSize: input.chunkSize });
    }
    const match = url.pathname.match(/^\/api\/files\/([a-f0-9]{32})(?:\/chunks\/(\d+))?$/);
    if (!match) return fail(res, 404, 'not found');
    const id = match[1]; let manifest; try { manifest = await readManifest(id); } catch { return fail(res, 404, 'file not found'); }
    if (req.method === 'GET' && !match[2]) {
      const present = (await Promise.all(Array.from({ length: manifest.totalChunks }, async (_, i) => { try { await fs.access(chunkPath(id, i)); return i; } catch { return null; } }))).filter(i => i !== null);
      return json(res, 200, { ...manifest, present });
    }
    if (!match[2] || !safeIndex(match[2])) return fail(res, 400, 'invalid chunk index');
    const index = Number(match[2]); if (index >= manifest.totalChunks) return fail(res, 416, 'chunk index out of range');
    if (req.method === 'PUT') {
      const body = await readBody(req, Math.min(MAX_CHUNK_BYTES, manifest.chunkSize + 28));
      if (body.length < 28) return fail(res, 400, 'encrypted chunk is too short');
      await fs.writeFile(chunkPath(id, index), body, { mode: 0o600 }); await fs.writeFile(macPath(id, index), computeMac(id, index, body), { mode: 0o600 });
      return json(res, 200, { id, index, bytes: body.length, sha256: crypto.createHash('sha256').update(body).digest('hex') });
    }
    if (req.method === 'GET') {
      let body, storedMac; try { body = await fs.readFile(chunkPath(id, index)); storedMac = (await fs.readFile(macPath(id, index), 'utf8')).trim(); } catch { return fail(res, 404, 'chunk not uploaded'); }
      const expected = computeMac(id, index, body);
      if (storedMac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(storedMac), Buffer.from(expected))) return fail(res, 500, 'stored chunk integrity check failed');
      res.writeHead(200, { ...headers, 'content-type': 'application/octet-stream', 'content-length': body.length, 'cache-control': 'no-store', 'x-chunk-sha256': crypto.createHash('sha256').update(body).digest('hex') }); return res.end(body);
    }
    return fail(res, 405, 'method not allowed');
  } catch (error) { console.error(error); return fail(res, error.message === 'request body too large' ? 413 : 400, error.message || 'bad request'); }
}

await fs.mkdir(STORAGE_DIR, { recursive: true, mode: 0o700 });
const serverHandler = async (req, res) => { res.setHeader('access-control-allow-origin', process.env.CORS_ORIGIN || '*'); if (await completeHandler(req, res)) return; const url = new URL(req.url, `http://${HOST}`); if (url.pathname.startsWith('/api/')) return apiHandler(req, res); if (!(await serveStatic(req, res, url))) fail(res, 404, 'not found'); };
const tls = process.env.TLS_KEY_FILE && process.env.TLS_CERT_FILE;
const server = tls ? createSecureServer({ key: await fs.readFile(process.env.TLS_KEY_FILE), cert: await fs.readFile(process.env.TLS_CERT_FILE) }, serverHandler) : createServer(serverHandler);
server.listen(PORT, HOST, () => console.log(`${tls ? 'HTTPS' : 'HTTP'} server listening on ${tls ? 'https' : 'http'}://${HOST}:${PORT}`));
