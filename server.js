/**
 * server.js — API + static host for the Agent Readiness dashboard
 *
 * Scans run as background jobs so a slow store never times out the request.
 *   POST /api/scan      { url }        -> { id }
 *   GET  /api/scan/:id                 -> { status, step, result }
 *   GET  /api/history                  -> recent scans
 *
 * Running jobs live in memory. Completed reports persist in SQLite.
 * Public scan responses contain only free summaries; full reports use private links.
 *
 * Run: node server.js    then open http://localhost:3000
 */

import {clientIp} from './client-ip.js';
import {createEmailOtp} from './email-otp.js';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { freeReport, openReportStore } from './report-access.js';
import {createPayments, verifyStripeEvent} from './stripe-payment.js';
import {createCoupons} from './coupons.js';
import { reportEmail } from './report-email.js';
import { openLeadStore, handleLeadRequest, validateLead } from './leads.js';
import { normalizeStoreUrl, handleStoreRequest } from './store-url.js';
import { VERSION } from './engine.js';
import { scanWithCompetitors, COMPETITORS } from './competitive.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3100;
const PUBLIC = join(__dirname, 'public');

const leadStore = openLeadStore(process.env.LEADS_DB_PATH || join(__dirname, 'data', 'leads.sqlite'));
const reportStore = openReportStore(process.env.REPORTS_DB_PATH || join(__dirname, 'data', 'reports.sqlite'));
const emailOtp = createEmailOtp(leadStore);
const coupons = createCoupons(reportStore);
const payments = createPayments(reportStore, {coupons});
const demoAllowed = req => process.env.NODE_ENV !== 'production' && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
const previewAllowed = req => demoAllowed(req) && process.env.REPORT_EMAIL_PREVIEW === '1';
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
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(s), 'Cache-Control':'no-store', 'Referrer-Policy':'no-referrer' });
  res.end(s);
}

function startScan(url, contact) {
  const id = randomUUID();
  const job = { id, url, status: 'running', step: 'Starting', startedAt: Date.now(), result: null, error: null };
  jobs.set(id, job);

  scanWithCompetitors(url, (step) => { job.step = step; })
    .then((result) => {
      reportStore.save(id, result, contact);
      job.result = result;
      job.status = 'done';
      job.step = 'Complete';
      job.ms = Date.now() - job.startedAt;
      history.unshift({ id, brandName: result.brandName, domain: result.domain, score: result.finalScore, grade: result.grade, at: Date.now() });
      history.splice(25);
    })
    .catch((err) => { job.status = 'error'; job.error = err.message; });

  return id;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const ip = clientIp(req);

  if (req.method === 'POST' && ['/api/checkout','/api/checkout/status','/api/stripe/webhook'].includes(url.pathname)) {
    const webhook = url.pathname === '/api/stripe/webhook';
    if (!payments.ready) return json(res,503,{error:'Payments are not configured yet.'});
    if (!webhook && rateLimited('payment:'+ip)) return json(res,429,{error:'Too many requests. Try again later.'});
    let raw='';
    try {
      for await (const chunk of req) { raw+=chunk; if(raw.length>262144) return json(res,413,{error:'Request too large.'}); }
      if(webhook) {
        let event;
        try { event=verifyStripeEvent(raw,req.headers['stripe-signature'],process.env.STRIPE_WEBHOOK_SECRET); }
        catch { return json(res,400,{error:'Invalid webhook signature.'}); }
        if(['checkout.session.completed','checkout.session.async_payment_succeeded'].includes(event.type)) {
          if(!reportStore.getCheckout(event.data.object.id)) return json(res,200,{received:true});
          const result=await payments.fulfill(event.data.object.id);
          if(result.emailStatus==='failed') return json(res,503,{error:'Email delivery pending; retry fulfillment.'});
        }
        return json(res,200,{received:true});
      }
      if(!req.headers['content-type']?.startsWith('application/json')) return json(res,415,{error:'JSON required.'});
      const body=JSON.parse(raw);
      return json(res,200,url.pathname==='/api/checkout' ? await payments.checkout(body.scanId, body.code) : await payments.fulfill(body.sessionId));
    } catch { return json(res,webhook?503:400,{error:'Unable to confirm payment. Please retry or contact support.'}); }
  }

  // Full-access codes bypass Stripe entirely, so they get their own strict
  // rate-limit bucket: this is the one endpoint worth brute-forcing.
  if (req.method === 'POST' && url.pathname === '/api/redeem') {
    if (!coupons.enabled) return json(res, 404, {error:'Discount codes are not available.'});
    if (rateLimited('redeem:' + ip)) return json(res, 429, {error:'Too many code attempts. Try again later.'});
    if (!req.headers['content-type']?.startsWith('application/json')) return json(res, 415, {error:'JSON required.'});
    let raw = '';
    try {
      for await (const chunk of req) { raw += chunk; if (raw.length > 4096) return json(res, 413, {error:'Request too large.'}); }
      const body = JSON.parse(raw);
      return json(res, 200, await coupons.redeem(body.scanId, body.code));
    } catch (error) {
      return json(res, error instanceof SyntaxError ? 400 : 403, {error: error instanceof SyntaxError ? 'Invalid JSON.' : error.message});
    }
  }

  if (req.method === 'POST' && ['/api/otp/request','/api/otp/verify'].includes(url.pathname)) {
    if(rateLimited('otp:'+ip)) return json(res,429,{error:'Too many attempts. Try again later.'});
    if(!req.headers['content-type']?.startsWith('application/json')) return json(res,415,{error:'JSON required.'});
    try {
      let raw='';
      for await(const chunk of req) {raw+=chunk;if(raw.length>4096)return json(res,413,{error:'Request too large.'});}
      const body=JSON.parse(raw);
      const result=url.pathname.endsWith('/request') ? await emailOtp.request(body) : emailOtp.verify(body.challengeId,body.code);
      return json(res,200,result);
    } catch(error) {return json(res,400,{error:error instanceof SyntaxError?'Invalid JSON.':error.message});}
  }

  if (req.method === 'POST' && url.pathname === '/api/store') {
    if (rateLimited('store:' + ip)) return json(res, 429, { error: 'Too many requests. Please try again later.' });
    return handleStoreRequest(req, res, [...history, ...Object.entries(COMPETITORS).flatMap(([domain, peers]) => [domain, ...peers].map(domain => ({domain})))]);
  }

  if (req.method === 'POST' && url.pathname === '/api/leads') {
    if (rateLimited('leads:' + ip)) return json(res, 429, { error: 'Too many submissions. Please try again later.' });
    return handleLeadRequest(req, res, leadStore);
  }

  if (req.method === 'POST' && url.pathname === '/api/scan') {
    if (rateLimited(ip)) return json(res, 429, { error: 'Too many scans from this address. Try again later.' });
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
    req.on('end', () => {
      const parsed = (() => { try { return JSON.parse(body); } catch { return null; } })();
      if (!parsed || !parsed.url) return json(res, 400, { error: 'Enter a store URL.' });
      let target;
      try { target = normalizeStoreUrl(parsed.url); }
      catch { return json(res, 400, { error: "That doesn't look like a URL. Try example.com" }); }
      let contact;
      try { contact = emailOtp.consume(parsed.verificationToken,target); }
      catch(error) { return json(res,403,{error:error.message}); }
      return json(res, 202, { id: startScan(target, contact), domain: target });
    });
    return;
  }

  if (req.method === 'POST' && /^\/api\/scan\/[^/]+\/preview$/.test(url.pathname)) {
    if (!demoAllowed(req)) return json(res, 403, {error:'Report preview is available only in local development. Paid access requires verified payment.'});
    if (req.headers['content-type'] !== 'application/json') return json(res, 415, {error:'JSON required.'});
    const saved = reportStore.get(url.pathname.split('/')[3]);
    if (!saved || !Number.isFinite(saved.result.finalScore)) return json(res, 409, {error:'Complete a successful scan before previewing the report.'});
    return json(res, 200, {result:saved.result, preview:true});
  }

  if (req.method === 'POST' && /^\/api\/scan\/[^/]+\/email-preview$/.test(url.pathname)) {
    if (!previewAllowed(req)) return json(res, 403, {error:'Email preview is available only in explicitly enabled local development.'});
    if (req.headers['content-type'] !== 'application/json') return json(res, 415, {error:'JSON required.'});
    if (rateLimited('email-preview:' + ip)) return json(res, 429, {error:'Too many previews. Try again later.'});
    try {
      const id = url.pathname.split('/')[3];
      const saved = reportStore.get(id);
      if (!saved?.email) return json(res, 400, {error:'Start a new scan with your contact details to preview this email.'});
      const token = reportStore.issue(id, {preview:true});
      const origin = `http://localhost:${PORT}`;
      const email = reportEmail({name:saved.name,domain:saved.result.domain,reportUrl:`${origin}/?report=${token}&store=${encodeURIComponent(new URL(saved.result.domain).hostname.replace(/^www\./, '').split('.')[0])}`,preview:true});
      return json(res, 200, {preview:true, email:saved.email, ...email});
    } catch { return json(res, 409, {error:'The report must finish successfully before an email can be prepared.'}); }
  }

  if (req.method === 'POST' && url.pathname === '/api/report/view') {
    if (req.headers['content-type'] !== 'application/json') return json(res, 415, {error:'JSON required.'});
    if (rateLimited('report-view:' + ip)) return json(res, 429, {error:'Too many attempts. Try again later.'});
    let body = '';
    try {
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 1024) return json(res, 413, {error:'Request too large.'});
      }
      const {token} = JSON.parse(body);
      const report = reportStore.resolve(token, {allowPreview:previewAllowed(req)});
      if (!report) return json(res, 403, {error:'This report link is invalid, expired or no longer available. Please contact the team for a new link.'});
      return json(res, 200, report);
    } catch { return json(res, 400, {error:'Unable to open this report link.'}); }
  }

  if (req.method === 'GET' && /^\/api\/scan\/[^/]+$/.test(url.pathname)) {
    const id = url.pathname.split('/').pop();
    const job = jobs.get(id);
    const saved = job ? null : reportStore.get(id);
    if (!job && !saved) return json(res, 404, { error: 'Scan not found.' });
    return json(res, 200, { status: job?.status || 'done', step: job?.step || 'Complete', result: freeReport(job?.result || saved?.result), error: job?.error, ms: job?.ms, checkoutAvailable:payments.ready, couponsAvailable:coupons.enabled, reportPreviewAvailable:demoAllowed(req) });
  }

  if (req.method === 'GET' && url.pathname === '/api/version') return json(res, 200, { version: VERSION });

  if (req.method === 'GET' && url.pathname === '/api/benchmarks') return json(res, 200, { competitors: COMPETITORS });

  if (url.pathname.startsWith('/api/benchmark/')) return json(res, 403, {error:'A private paid report link is required to view competitor findings.'});

  if (req.method === 'GET' && url.pathname === '/api/history') return json(res, 200, { history });

  // static
  const path = url.pathname === '/' ? '/index.html' : url.pathname;
  try {
    const file = await readFile(join(PUBLIC, path.replace(/\.\./g, '')));
    res.writeHead(200, { 'Content-Type': MIME[extname(path)] || 'application/octet-stream', 'Referrer-Policy':'no-referrer' });
    res.end(file);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
});

server.listen(PORT, process.env.HOST || '127.0.0.1', () => console.log(`\n  ==========================================\n   AGENTNEW  \u2014  engine v${VERSION}\n   Open: http://localhost:${PORT}\n  ==========================================\n`));
