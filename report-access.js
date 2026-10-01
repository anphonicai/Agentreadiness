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
  // Indian storefronts get the COD framing; everywhere else the same missing
  // field is asked about in terms a shopper there would actually use.
  codPayment: {
    missing: 'acceptedPaymentMethod',
    variantsIntl: [
      {ask: t => `What payment methods can I use for the ${t}?`, reply: "I don't have that information for this product. You may want to check the retailer's website directly."},
      {ask: t => `Can I pay for the ${t} with my card?`, reply: "The store doesn't publish the payment methods it accepts in a form I can read, so I can't confirm that."},
      {ask: t => `How do I pay for the ${t}?`, reply: "I can't tell which payment methods this product supports. You'd need to check the store directly."},
    ],
    variants: [
      {ask: t => `Does the ${t} accept Cash on Delivery?`, reply: "I don't have that information for this product. You may want to check the retailer's website directly."},
      {ask: t => `Can I pay cash when the ${t} is delivered?`, reply: "The store doesn't publish the payment methods it accepts in a form I can read, so I can't confirm that."},
      {ask: t => `Is the ${t} prepaid only, or is COD available?`, reply: "I can't tell which payment methods this product supports. You'd need to check the store directly."},
    ],
  },
  serviceability: {
    missing: 'OfferShippingDetails',
    variants: [
      {ask: t => `Can you deliver the ${t} to 560001?`, reply: "I can't confirm delivery to that pincode. The store doesn't publish shipping details I can read."},
      {ask: t => `How long would the ${t} take to reach me?`, reply: "There's no delivery estimate published for this product, so I can't say."},
      {ask: t => `Do they ship the ${t} to my city?`, reply: "This product doesn't expose serviceability data, so I can't check that for you."},
    ],
  },
  factualDensity: {
    missing: 'material and size in the description',
    variants: [
      {ask: t => `What is the ${t} made of, and what size is it?`, reply: "The product description doesn't state the material or dimensions, so I can't say."},
      {ask: t => `What are the exact dimensions of the ${t}?`, reply: "The description doesn't give measurements I can quote back to you."},
      {ask: t => `What's the ${t} actually made from?`, reply: "The description doesn't mention the material, so I'd only be guessing."},
    ],
  },
  productSchema: {
    missing: 'complete Product schema',
    variants: [
      {ask: t => `What's the current price and stock status of the ${t}?`, reply: "I can't read structured pricing or availability for this product, so I'd be guessing."},
      {ask: t => `Is the ${t} in stock right now?`, reply: "There's no machine-readable availability on this product, so I can't confirm it."},
      {ask: t => `How much does the ${t} cost?`, reply: "The price isn't published in a format I can read reliably, so I can't quote it."},
    ],
  },
  orgSchema: {
    missing: 'Organization schema',
    variants: [
      {ask: t => `Who sells the ${t}, and can I trust the store?`, reply: "I can't identify the seller from this store's structured data, so I'd rather suggest a retailer I can verify."},
      {ask: t => `Is this a legitimate retailer for the ${t}?`, reply: "The store doesn't publish organisation details I can verify, so I can't vouch for it."},
      {ask: t => `Who is behind the store selling the ${t}?`, reply: "There's no seller identity I can read on this store, so I can't tell you."},
    ],
  },
  answerFirst: {
    missing: 'a direct answer in the page content',
    variants: [
      {ask: t => `Is the ${t} right for what I need?`, reply: "The page doesn't answer that directly, so I can't recommend it with confidence."},
      {ask: t => `Why should I choose the ${t} over similar products?`, reply: "The page doesn't make that case in a way I can quote back to you."},
      {ask: t => `What problem does the ${t} actually solve?`, reply: "The description doesn't answer that directly, so I can't summarise it."},
    ],
  },
};

// Stable per store, different between stores: the same domain always sees the
// same question, while two clients with the same top gap do not read identical
// copy. Not security-sensitive -- only picks a phrasing.
function variantIndex(seed, length) {
  if (!length) return 0;
  const text = String(seed ?? '');
  // FNV-1a, then a murmur3 finalizer. A plain *31 hash collapses badly against a
  // small modulus and sent most stores to the same phrasing.
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  }
  hash ^= hash >>> 16; hash = Math.imul(hash, 2246822507);
  hash ^= hash >>> 13; hash = Math.imul(hash, 3266489909);
  hash = (hash ^ (hash >>> 16)) >>> 0;
  return hash % length;
}

function agentAsk(r) {
  const title = typeof r.agentView?.title === 'string' ? r.agentView.title.trim() : '';
  if (!title) return null;
  const template = AGENT_ASKS[(r.gaps || [])[0]?.check] || AGENT_ASKS.productSchema;
  const indian = (r.country ? r.country === 'IN' : r.currency === 'INR');
  const variants = (!indian && template.variantsIntl) || template.variants;
  const variant = variants[variantIndex(r.domain || title, variants.length)];
  if (!variant) return null;
  // Name only fields the scanner genuinely could not read on this product, and
  // only ones the free report already lists, so the note matches the evidence.
  const shown = new Set(['Price','In stock','SKU','Rating','Options']);
  const unreadable = (r.agentView.fields || [])
    .filter(field => field.visible !== true && shown.has(field.label))
    .map(field => field.label).slice(0, 3);
  return {question: variant.ask(title), answer: variant.reply, missing: template.missing, unreadable};
}
// The summary block behind the free report's evidence sections. Paid views
// render the same summary above the detail, so both paths build it here.
// Only ever link back to a product page on the store that was scanned: the URL
// travels into the report's HTML, and a scan is of a third-party storefront.
function sameStoreUrl(value, domain) {
  try {
    const url = new URL(value);
    const store = new URL(domain);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.hostname.replace(/^www\./, '') !== store.hostname.replace(/^www\./, '')) return null;
    return url.href;
  } catch { return null; }
}

export function reportPreview(r) {
  const checks = [r.layer2Report, r.layer3Report, r.layer4Report].flatMap(layer => layer?.checks || []);
  const recommendations = checks.filter(check => Number.isFinite(check.value) && check.value < 100 && typeof check.fix?.headline === 'string');
  const primary = recommendations.find(check => check.key === r.gaps?.[0]?.check) || recommendations[0];
  const allowedFields = new Set(['Name','Price','In stock','SKU','Rating','Options']);
  return {
    recommendationCount: recommendations.length,
    recommendationTitle: primary?.fix.headline || null,
    product: typeof r.agentView?.title === 'string' ? {
      title: r.agentView.title,
      url: sameStoreUrl(r.agentView.url, r.domain),
      fields: (r.agentView.fields || []).filter(field => allowedFields.has(field.label)).slice(0,6).map(field => ({
        label: field.label,
        visible: field.visible === true,
        value: field.visible === true && ['string','number','boolean'].includes(typeof field.value) ? String(field.value) : null,
      })),
    } : null,
    agentAsk: agentAsk(r),
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
  result.preview = reportPreview(r);
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
