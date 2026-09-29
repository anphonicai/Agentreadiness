import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest('hex');

// What an agent cannot answer today, phrased as the shopper question it fails.
// Questions are built from this scan's own gaps and sampled product, never from
// a fixture, and the answer is the documented failure mode for that missing
// field -- an illustration of the consequence, not a recorded model response.
const AGENT_ASKS = {
  codPayment: {
    ask: title => `Does the ${title} accept Cash on Delivery?`,
    reply: "I don't have that information for this product. You may want to check the retailer's website directly.",
    missing: 'acceptedPaymentMethod',
  },
  serviceability: {
    ask: title => `Can you deliver the ${title} to 560001?`,
    reply: "I can't confirm delivery for this product. The store doesn't publish shipping details I can read.",
    missing: 'OfferShippingDetails',
  },
  factualDensity: {
    ask: title => `What is the ${title} made of, and what size is it?`,
    reply: "The product description doesn't state the material or dimensions, so I can't say.",
    missing: 'material and size in the description',
  },
  productSchema: {
    ask: title => `What's the current price and stock status of the ${title}?`,
    reply: "I can't read structured pricing or availability for this product, so I'd be guessing.",
    missing: 'complete Product schema',
  },
  orgSchema: {
    ask: title => `Who sells the ${title}, and can I trust the store?`,
    reply: "I can't identify the seller from this store's structured data, so I'd rather suggest a retailer I can verify.",
    missing: 'Organization schema',
  },
  answerFirst: {
    ask: title => `Is the ${title} right for what I need?`,
    reply: "The page doesn't answer that directly, so I can't recommend it with confidence.",
    missing: 'a direct answer in the page content',
  },
};

function agentAsk(r) {
  const title = typeof r.agentView?.title === 'string' ? r.agentView.title : null;
  if (!title) return null;
  const gap = (r.gaps || [])[0];
  const template = AGENT_ASKS[gap?.check] || AGENT_ASKS.productSchema;
  // Name the fields the scanner genuinely could not read on this product.
  const unreadable = (r.agentView.fields || []).filter(field => field.visible !== true)
    .map(field => field.label).filter(label => typeof label === 'string').slice(0, 3);
  return {
    question: template.ask(title),
    answer: template.reply,
    missing: template.missing,
    unreadable,
  };
}
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
  const checks = [r.layer2Report, r.layer3Report, r.layer4Report].flatMap(layer => layer?.checks || []);
  const recommendations = checks.filter(check => Number.isFinite(check.value) && check.value < 100 && typeof check.fix?.headline === 'string');
  const primary = recommendations.find(check => check.key === r.gaps?.[0]?.check) || recommendations[0];
  const allowedFields = new Set(['Name','Price','In stock','SKU','Rating','Options']);
  result.preview = {
    recommendationCount: recommendations.length,
    recommendationTitle: primary?.fix.headline || null,
    product: typeof r.agentView?.title === 'string' ? {
      title: r.agentView.title,
      fields: (r.agentView.fields || []).filter(field => allowedFields.has(field.label)).slice(0,6).map(field => ({
        label: field.label,
        visible: field.visible === true,
        value: field.visible === true && ['string','number','boolean'].includes(typeof field.value) ? String(field.value) : null,
      })),
    } : null,
    agentAsk: agentAsk(r),
  };
  return result;
}

export function openReportStore(filename) {
  mkdirSync(dirname(filename), {recursive:true});
  const db = new DatabaseSync(filename);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS checkout_locks (report_id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS scan_owners (report_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS competitor_requests (report_id TEXT PRIMARY KEY, domains TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS checkout_sessions (id TEXT PRIMARY KEY, report_id TEXT NOT NULL, token TEXT, email_status TEXT NOT NULL DEFAULT 'pending');
    CREATE TABLE IF NOT EXISTS saved_reports (
      id TEXT PRIMARY KEY, email TEXT, name TEXT, result TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS coupon_redemptions (
      code TEXT NOT NULL, report_id TEXT NOT NULL, token TEXT,
      redeemed_at TEXT NOT NULL, email_status TEXT NOT NULL DEFAULT 'pending',
      PRIMARY KEY (code, report_id)
    );
    CREATE TABLE IF NOT EXISTS report_links (
      token_hash TEXT PRIMARY KEY, report_id TEXT NOT NULL, mode TEXT NOT NULL,
      expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0,
      payment_reference TEXT, delivery_status TEXT NOT NULL DEFAULT 'created', provider_id TEXT
    );`);
  return {
    createOwner(id) {
      const token = randomBytes(32).toString('hex');
      db.prepare('INSERT INTO scan_owners VALUES (?,?)').run(id,hash(token));
      return token;
    },
    owns(id, token) {
      return typeof token === 'string' && /^[a-f0-9]{64}$/.test(token) && Boolean(db.prepare('SELECT 1 FROM scan_owners WHERE report_id=? AND token_hash=?').get(id,hash(token)));
    },
    competitors(id) {
      const row=db.prepare('SELECT * FROM competitor_requests WHERE report_id=?').get(id);
      return row ? {...row, domains:JSON.parse(row.domains)} : null;
    },
    queueCompetitors(id, domains) {
      if (db.prepare('SELECT 1 FROM checkout_locks WHERE report_id=?').get(id)) throw new Error('Competitors must be selected before starting checkout.');
      if (db.prepare('SELECT 1 FROM checkout_sessions WHERE report_id=?').get(id) || db.prepare('SELECT 1 FROM report_links WHERE report_id=?').get(id)) throw new Error('Competitors must be selected before checkout or report access.');
      const existing=this.competitors(id);
      if (existing && JSON.stringify(existing.domains)!==JSON.stringify(domains)) throw new Error('Competitors are already saved for this report. Start a new scan to select different stores.');
      if (existing && existing.status!=='failed') return;
      db.prepare("INSERT INTO competitor_requests VALUES (?,?,'queued',?) ON CONFLICT(report_id) DO UPDATE SET status='queued'").run(id,JSON.stringify(domains),new Date().toISOString());
    },
    pendingCompetitors() { return db.prepare("SELECT report_id FROM competitor_requests WHERE status IN ('queued','running') ORDER BY created_at").all(); },
    competitorStatus(id, status) { db.prepare('UPDATE competitor_requests SET status=? WHERE report_id=?').run(status,id); },
    completeCompetitors(id, layer5Report) {
      const saved=this.get(id);
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('UPDATE saved_reports SET result=? WHERE id=?').run(JSON.stringify({...saved.result,layer5Report}),id);
        this.competitorStatus(id,'ready');
        db.exec('COMMIT');
      } catch(error) {db.exec('ROLLBACK');throw error;}
    },
    lockCompetitors(id) { this.assertCompetitorsReady(id); db.prepare('INSERT OR IGNORE INTO checkout_locks VALUES (?)').run(id); },
    assertCompetitorsReady(id) {
      const request=this.competitors(id);
      if(request && request.status!=='ready') throw new Error('Your competitor comparison is not ready yet. Return to the free report to check its status.');
    },
    redemption(code, reportId) { return db.prepare('SELECT * FROM coupon_redemptions WHERE code=? AND report_id=?').get(code, reportId); },
    redemptionCount(code) { return db.prepare('SELECT COUNT(*) AS n FROM coupon_redemptions WHERE code=?').get(code).n; },
    saveRedemption(code, reportId, token) {
      db.prepare('INSERT INTO coupon_redemptions (code,report_id,token,redeemed_at) VALUES (?,?,?,?)').run(code, reportId, token, new Date().toISOString());
    },
    redemptionEmail(code, reportId, status) {
      db.prepare('UPDATE coupon_redemptions SET email_status=? WHERE code=? AND report_id=?').run(status, code, reportId);
    },
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
      this.assertCompetitorsReady(id);
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
