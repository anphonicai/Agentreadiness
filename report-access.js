import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest('hex');
export function freeReport(r) {
  if (!r) return null;
  const result = {};
  for (const key of ['domain','brandName','scannedAt','finalScore','grade','gradeNote','catalogCount','sampled']) result[key] = r[key];
  result.checkoutStack = (r.checkoutStack || []).filter(v => typeof v === 'string');
  result.errors = (r.errors || []).filter(v => typeof v === 'string');
  result.layers = Object.fromEntries(['layer1','layer2','layer3','layer4'].filter(key => r.layers?.[key]).map(key => {
    const {name, score, weight} = r.layers[key];
    return [key, {name, score, weight}];
  }));
  result.gaps = (r.gaps || []).slice(0,3).map(({layer,message}) => ({layer,message}));
  return result;
}

export function openReportStore(filename) {
  mkdirSync(dirname(filename), {recursive:true});
  const db = new DatabaseSync(filename);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS checkout_sessions (id TEXT PRIMARY KEY, report_id TEXT NOT NULL, token TEXT, email_status TEXT NOT NULL DEFAULT 'pending');
    CREATE TABLE IF NOT EXISTS saved_reports (
      id TEXT PRIMARY KEY, email TEXT, name TEXT, result TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS report_links (
      token_hash TEXT PRIMARY KEY, report_id TEXT NOT NULL, mode TEXT NOT NULL,
      expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0,
      payment_reference TEXT, delivery_status TEXT NOT NULL DEFAULT 'created', provider_id TEXT
    );`);
  return {
    saveCheckout(id, reportId) { db.prepare('INSERT INTO checkout_sessions (id,report_id) VALUES (?,?)').run(id,reportId); },
    getCheckout(id) { return db.prepare('SELECT * FROM checkout_sessions WHERE id=?').get(id); },
    checkoutToken(id, token) { db.prepare('UPDATE checkout_sessions SET token=? WHERE id=?').run(token,id); },
    checkoutEmail(id, status) { db.prepare('UPDATE checkout_sessions SET email_status=? WHERE id=?').run(status,id); },
    save(id, result, contact = {}) {
      db.prepare('INSERT INTO saved_reports VALUES (?, ?, ?, ?, ?)').run(id, contact.email || null, contact.name || null, JSON.stringify(result), new Date().toISOString());
    },
    get(id) {
      const row = db.prepare('SELECT * FROM saved_reports WHERE id=?').get(id);
      return row ? {...row, result:JSON.parse(row.result)} : null;
    },
    issue(id, {preview=false, paymentReference, ttlMs=30*24*60*60*1000} = {}) {
      const report = this.get(id);
      if (!report || !Number.isFinite(report.result.finalScore)) throw new Error('A completed, successful report is required.');
      if (!preview && (!report.email || typeof paymentReference !== 'string' || !paymentReference.trim())) throw new Error('Recipient and verified payment reference are required.');
      if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error('Invalid link lifetime.');
      const token = randomBytes(32).toString('hex');
      db.prepare('INSERT INTO report_links (token_hash,report_id,mode,expires_at,payment_reference) VALUES (?,?,?,?,?)')
        .run(hash(token),id,preview ? 'preview' : 'paid',Date.now()+ttlMs,paymentReference || null);
      return token;
    },
    resolve(token, {allowPreview=false, now=Date.now()} = {}) {
      if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return null;
      const link = db.prepare('SELECT * FROM report_links WHERE token_hash=? AND revoked=0 AND expires_at>?').get(hash(token),now);
      if (!link || (link.mode === 'preview' && !allowPreview)) return null;
      const report = this.get(link.report_id);
      return report ? {result:report.result, preview:link.mode==='preview'} : null;
    },
    delivery(token, status, providerId = null) {
      db.prepare('UPDATE report_links SET delivery_status=?,provider_id=? WHERE token_hash=?').run(status,providerId,hash(token));
    },
    revoke(token) { db.prepare('UPDATE report_links SET revoked=1 WHERE token_hash=?').run(hash(token)); },
    close() { db.close(); },
  };
}
