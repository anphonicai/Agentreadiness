/**
 * server.js — API + static host for the Agent Readiness dashboard
 *
 * Scans run as background jobs so a slow store never times out the request.
 *   POST /api/scan      { url }        -> { id }
 *   GET  /api/scan/:id                 -> { status, step, result }
 *   GET  /api/history                  -> recent scans
 *
 * Jobs live in memory. Swap the `jobs` Map for Supabase when this goes live —
 * that is the only change needed to make it multi-user and persistent.
 *
 * Run: node server.js    then open http://localhost:3000
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { scanStore, VERSION } from './engine.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3100;
const PUBLIC = join(__dirname, 'public');

const jobs = new Map();
const history = [];

// crude per-IP rate limit — a public scanner pointed at arbitrary domains
// needs one before it ever leaves localhost
const hits = new Map();
const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 60 * 60 * 1000;

function rateLimited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  list.push(now);
  hits.set(ip, list);
  return list.length > RATE_LIMIT;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };

function json(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(s) });
  res.end(s);
}

function startScan(url) {
  const id = randomUUID();
  const job = { id, url, status: 'running', step: 'Starting', startedAt: Date.now(), result: null, error: null };
  jobs.set(id, job);

  scanStore(url, (step) => { job.step = step; })
    .then((result) => {
      job.result = result;
      job.status = 'done';
      job.step = 'Complete';
      job.ms = Date.now() - job.startedAt;
      history.unshift({ id, domain: result.domain, score: result.finalScore, grade: result.grade, at: Date.now() });
      history.splice(25);
    })
    .catch((err) => { job.status = 'error'; job.error = err.message; });

  return id;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const ip = req.socket.remoteAddress || 'unknown';

  if (req.method === 'POST' && url.pathname === '/api/scan') {
    if (rateLimited(ip)) return json(res, 429, { error: 'Too many scans from this address. Try again later.' });
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
    req.on('end', () => {
      const parsed = (() => { try { return JSON.parse(body); } catch { return null; } })();
      if (!parsed || !parsed.url) return json(res, 400, { error: 'Enter a store URL.' });
      let target;
      try { target = new URL(/^https?:\/\//i.test(parsed.url) ? parsed.url : 'https://' + parsed.url).origin; }
      catch { return json(res, 400, { error: "That doesn't look like a URL. Try example.com" }); }
      return json(res, 202, { id: startScan(target), domain: target });
    });
    return;
  }

  if (req.method === 'GET' && url.pathname.startsWith('/api/scan/')) {
    const job = jobs.get(url.pathname.split('/').pop());
    if (!job) return json(res, 404, { error: 'Scan not found.' });
    return json(res, 200, { status: job.status, step: job.step, result: job.result, error: job.error, ms: job.ms });
  }

  if (req.method === 'GET' && url.pathname === '/api/version') return json(res, 200, { version: VERSION });

  if (req.method === 'GET' && url.pathname === '/api/history') return json(res, 200, { history });

  // static
  const path = url.pathname === '/' ? '/index.html' : url.pathname;
  try {
    const file = await readFile(join(PUBLIC, path.replace(/\.\./g, '')));
    res.writeHead(200, { 'Content-Type': MIME[extname(path)] || 'application/octet-stream' });
    res.end(file);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
});

server.listen(PORT, () => console.log(`\n  ==========================================\n   AGENTNEW  \u2014  engine v${VERSION}\n   Open: http://localhost:${PORT}\n  ==========================================\n`));
