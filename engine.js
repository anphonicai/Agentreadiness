#!/usr/bin/env node
/**
 * engine.js — AI Agent Readiness: scan + score
 *
 * Consolidates probe2/3/4 into one pipeline that produces a final 0-100 score,
 * a grade, per-layer scores, top-3 gaps, and the "what an agent sees" card.
 *
 * CLI:   node engine.js https://superyou.in
 * API:   import { scanStore } from './engine.js'
 *
 * Node 18+. No dependencies.
 */

import {publicFetch} from './public-fetch.js';

// ============================================================== SCORING CONFIG
// Everything tunable lives here. Change a number, rerun, done.

export const VERSION = '2.2-agentnew';   // Comparable scan metadata for Layer 5

export const WEIGHTS = {
  layer1: 0.20,   // Crawler & technical access
  layer2: 0.25,   // Structured data
  layer3: 0.25,   // Checkout & UCP compatibility
  layer4: 0.15,   // Content clarity
  layer5: 0.15,   // Competitive position — computed separately in competitive.js
};

export const SKIPPED_LAYERS = ['layer5'];

/**
 * Layer 2 sub-checks exactly as the spec lists them. `specSub` is the spec's own
 * weight. `scored:false` means the check is measured and shown but kept out of
 * the score; its weight is redistributed across the scored checks in proportion.
 *
 * The scoring weights are DERIVED from this table, never typed separately. An
 * earlier version hand-wrote them and drifted from the spec — variant data was
 * scored at 15% against a spec weight of 20%, review at 15% against 10% — so the
 * screen printed spec weights it wasn't actually using. Change specSub here and
 * both the score and the screen move together.
 */
export const LAYER2_SPEC = [
  { key: 'productSchema', specSub: 35, scored: true,  label: 'Product schema (JSON-LD) coverage' },
  { key: 'variantSchema', specSub: 20, scored: true,  label: 'Variant data structured' },
  { key: 'orgSchema',     specSub: 15, scored: true,  label: 'Organization/entity schema' },
  { key: 'faqSchema',     specSub: 10, scored: true,  label: 'FAQ/HowTo schema' },
  { key: 'llmsTxt',       specSub: 10, scored: false, label: 'llms.txt present' },
  { key: 'reviewSchema',  specSub: 10, scored: true,  label: 'Review/rating schema' },
];

const L2_SCORED = LAYER2_SPEC.filter((c) => c.scored);
const L2_SPEC_TOTAL = L2_SCORED.reduce((a, c) => a + c.specSub, 0);
/** Spec weight renormalised over the scored checks only. */
export const layer2Weight = (key) => {
  const c = L2_SCORED.find((x) => x.key === key);
  return c ? c.specSub / L2_SPEC_TOTAL : 0;
};

/**
 * Layer 3 as the spec lists it. Same contract as LAYER2_SPEC: weights are
 * derived from this table, never typed twice.
 *
 * Four of the five are now measured. Agentic Storefronts eligibility stays
 * unscored — Shopify plan tier is only exposed in public HTML by some stores
 * (3 of 10 tested), so it can confirm Plus but can never establish that a store
 * is NOT Plus. Scoring a check that can only ever return "yes" or "unknown"
 * would punish stores for our blind spot.
 *
 * Note on shipping: the spec's check is pincode-level serviceability, and that
 * is what `serviceability` now measures. The older `shippingPolicy` check
 * measured the policy page's text length — useful, but a different question —
 * so it is kept as a measured extra rather than scored in the spec's slot.
 */
/**
 * `hidden: true` holds a check back from the report entirely — neither shown
 * nor scored, with the remaining weights renormalising over what is left.
 * Nothing is hidden right now; all five checks are live.
 *
 * If you do hide one, hide it from scoring too. Hiding a check while still
 * scoring it leaves the visible weights adding to less than 100% of the layer
 * with the remainder unexplained — the exact kind of silent weight this report
 * exists to expose.
 */
export const LAYER3_SPEC = [
  { key: 'ucpProfile',         specSub: 35, scored: true,  label: 'UCP checkout capability declared' },
  { key: 'codPayment',         specSub: 20, scored: true,  label: 'COD/prepaid logic exposed cleanly' },
  { key: 'serviceability',     specSub: 15, scored: true,  label: 'Shipping/serviceability data structured' },
  { key: 'returnPolicy',       specSub: 15, scored: true,  hidden: true, label: 'Return/exchange policy machine-readable' },
  { key: 'agenticEligibility', specSub: 15, scored: false, hidden: true, label: 'Agentic Storefronts eligibility' },
];

const L3_SHOWN = LAYER3_SPEC.filter((c) => !c.hidden);
const L3_SCORED = L3_SHOWN.filter((c) => c.scored);
const L3_SPEC_TOTAL = L3_SCORED.reduce((a, c) => a + c.specSub, 0);
export const layer3Weight = (key) => {
  const c = L3_SCORED.find((x) => x.key === key);
  return c ? c.specSub / L3_SPEC_TOTAL : 0;
};

/**
 * Layer 4 as the v2 spec lists it, plus three signals we measure but the spec
 * doesn't name. Those carry `added: true` and are never scored — they are shown
 * because description length, duplication and image count explain a lot of what
 * the three scored checks report.
 */
export const LAYER4_SPEC = [
  { key: 'answerFirst',       specSub: 40, scored: true,  label: 'Answer-first product descriptions' },
  { key: 'factualDensity',    specSub: 30, scored: true,  label: 'Factual density' },
  { key: 'entityConsistency', specSub: 30, scored: true,  label: 'Consistent entity naming' },
  { key: 'descriptionDepth',  specSub: null, scored: false, added: true, label: 'Description length' },
  { key: 'uniqueness',        specSub: null, scored: false, added: true, label: 'Description uniqueness' },
  { key: 'imageCoverage',     specSub: null, scored: false, added: true, label: 'Image coverage' },
];

const L4_SHOWN = LAYER4_SPEC.filter((c) => !c.hidden);
const L4_SCORED = L4_SHOWN.filter((c) => c.scored);
const L4_SPEC_TOTAL = L4_SCORED.reduce((a, c) => a + c.specSub, 0);
export const layer4Weight = (key) => {
  const c = L4_SCORED.find((x) => x.key === key);
  return c ? c.specSub / L4_SPEC_TOTAL : 0;
};

export const SUB = {
  // v2 spec: robots, JS render and sitemap demoted to measured-but-not-scored —
  // all three returned 100 on every Shopify store tested. Weights below are the
  // spec's proposed split; change them here if Akshita locks different ones.
  layer1: { pageWeight: 0.40, botWall: 0.35, productFeed: 0.25 },
  layer2: Object.fromEntries(L2_SCORED.map((c) => [c.key, layer2Weight(c.key)])),
  layer3: Object.fromEntries(L3_SCORED.map((c) => [c.key, layer3Weight(c.key)])),
  // v2 spec structure. answerFirst and factualDensity are specified as one
  // Claude Haiku call; they are computed here by deterministic detection
  // instead, so a scan still costs nothing and needs no API key. See l4.
  layer4: Object.fromEntries(L4_SCORED.map((c) => [c.key, layer4Weight(c.key)])),
};

/**
 * Layer 3 checkout scoring. Native Shopify checkout is assumed fully
 * UCP-eligible; each additional third-party layer is assumed to reduce the
 * chance of a clean agentic purchase path.
 *
 * NOTE: this premise is unverified against Shopify's agentic storefronts
 * behaviour. If direct checkout in AI channels turns out to be independent of
 * the online-store checkout app, set all values to 100 and reweight.
 */
export function scoreCheckoutStack(stack) {
  if (stack.length === 0) return 100;
  if (stack.length === 1) return 55;
  if (stack.length === 2) return 35;
  return 20;
}

const GRADES = [
  { min: 80, label: 'Agent-Ready',        note: 'Agents can find, read and recommend this catalogue.' },
  { min: 60, label: 'Partially Ready',    note: 'Readable, but losing ground on details agents rank on.' },
  { min: 40, label: 'At Risk',            note: 'Significant gaps. Agents will often skip these products.' },
  { min: 0,  label: 'Invisible to Agents', note: 'Agents cannot reliably read or recommend this catalogue.' },
];

// ==================================================================== FETCHING

const TIMEOUT_MS = 15000;
const DELAY_MS = 250;
const CONCURRENCY = 3;
const SAMPLE_SIZE = 20;

const AGENTS = {
  Chrome:        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  Googlebot:     'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  GPTBot:        'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.1; +https://openai.com/gptbot',
  ClaudeBot:     'Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)',
  PerplexityBot: 'Mozilla/5.0 (compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)',
};

const AI_BOTS = ['GPTBot', 'ClaudeBot', 'PerplexityBot', 'Google-Extended', 'OAI-SearchBot', 'CCBot'];

const CHECKOUT_STACKS = [
  { key: 'GoKwik',        re: /gokwik|kwikpass|gk-checkout/i },
  { key: 'Shopflo',       re: /shopflo/i },
  { key: 'RazorpayMagic', re: /magic-?checkout|magicx/i },
  { key: 'Simpl',         re: /getsimpl|simpl\.js/i },
  { key: 'Snapmint',      re: /snapmint/i },
  { key: 'Fastrr',        re: /fastrr|pickrr/i },
  { key: 'Shiprocket',    re: /shiprocket.*checkout/i },
];

const REVIEW_APPS = [
  { key: 'Judge.me',        re: /judge\.me|judgeme|jdgm-/i },
  { key: 'Yotpo',           re: /yotpo/i },
  { key: 'Loox',            re: /loox\.io/i },
  { key: 'Stamped',         re: /stamped\.io/i },
  { key: 'Okendo',          re: /okendo|okeReviews/i },
  { key: 'Ryviu',           re: /ryviu/i },
  { key: 'Junip',           re: /junip/i },
  { key: 'Fera',            re: /fera\.ai|feraapp/i },
  { key: 'Growave',         re: /growave/i },
  { key: 'Reviews.io',      re: /reviews\.io|reviewsio/i },
  { key: 'Opinew',          re: /opinew/i },
  { key: 'Rivyo',           re: /rivyo/i },
  { key: 'Shopper Approved',re: /shopperapproved/i },
  { key: 'Trustpilot',      re: /trustpilot/i },
  { key: 'Vitals',          re: /vitals\.co|appvitals/i },
];

/**
 * Generic backstop for review widgets we don't have a name for. The named list
 * above will always lag the app store, and a miss is expensive: without this,
 * a store running an unlisted app falls through to the "no reviews anywhere"
 * baseline of 50 and gets CREDITED for having no reviews, when it in fact has
 * reviews its customers can see and agents can't — which scores 25.
 *
 * Caught exactly that on sleepyowl.co, which runs Junip. Kept deliberately
 * narrow: a rendered "N reviews" count, or a review-widget container. Generic
 * uses of the word "review" (order review, review your cart) must not match.
 */
const REVIEW_UI_RE = /\b\d+\s+reviews?\b|class="[^"]*(?:review-widget|reviews-widget|star-rating|rating-stars|product-reviews)[^"]*"/i;

/**
 * Layer 3 payment and serviceability signals.
 *
 * The distinction that matters is structured vs rendered. A page that says
 * "Cash on Delivery available" in prose tells a human everything and an agent
 * nothing; `acceptedPaymentMethod` on the Offer tells both. Same for delivery:
 * a pincode widget is a JS call to a private API, `shippingDetails` is a field.
 */
const COD_RE = /cash on delivery|\bcod\b|pay on delivery|pay when you receive/i;
const PREPAID_RE = /\bupi\b|net\s?banking|credit card|debit card|razorpay|payu|paytm|phonepe/i;
const PINCODE_RE = /pin\s?code|pincode|check delivery|check serviceability|check availability|delivery estimate|estimated delivery/i;

const FAQ_PATHS = ['/pages/faq', '/pages/faqs', '/pages/frequently-asked-questions', '/pages/help'];
const SHIPPING_PATHS = ['/policies/shipping-policy', '/pages/shipping-policy', '/pages/shipping', '/pages/shipping-returns'];
const RETURN_PATHS = ['/policies/refund-policy', '/pages/return-policy', '/pages/returns', '/pages/refund-policy'];

const UNIT_RE = /\b\d+(\.\d+)?\s?(ml|l|g|kg|mg|gm|cm|mm|inch|in|ft|oz|lb|%|gsm|tc|w|watt|mah|hz|hrs?|hours?|days?|pcs|pack|carat|kt)\b/gi;
const SPEC_RE = /\b(material|composition|ingredients?|dimensions?|weight|capacity|fabric|cotton|silk|leather|steel|silicone|wool|linen|size guide|care instructions|shelf life|warranty|battery|certified)\b/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ============================================================ LLM (OPTIONAL)
/**
 * Layer 4's answer-first check, graded by Gemini instead of keyword matching.
 *
 * Entirely optional. With no GEMINI_API_KEY the scanner falls back to the
 * regexes in ANSWER_PROBES and nothing else changes — the free tier keeps its
 * "no dependencies, no API keys" promise. The report always states which path
 * produced the number, because the two do not agree and pretending otherwise
 * would make scores incomparable.
 *
 * One request per scan: all sampled descriptions go in a single call, so the
 * free tier's per-minute request limit is never the bottleneck. Verdicts are
 * cached by description hash, so re-scanning a store whose copy hasn't changed
 * returns the same score — an LLM in the scoring path would otherwise make
 * results non-reproducible, which the deterministic sampling exists to avoid.
 */
const GEMINI_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
// gemini-2.5-flash-lite is retired for new keys — the API returns a 404 naming
// 3.5 as the replacement. Override with GEMINI_MODEL when this one retires too.
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
const GEMINI_URL = (m) => `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`;
const llmCache = new Map();

const ANSWER_FIELDS = ['material', 'useCase', 'size', 'attribute'];

const GRADER_PROMPT = `You are auditing e-commerce product descriptions for an AI shopping agent.

For each numbered description, decide whether the TEXT ITSELF states each fact.
Answer true only if a shopper could learn that fact from this text alone.
Vague marketing language ("premium materials", "high quality", "carefully crafted")
is NOT a statement of fact — answer false for it.

Facts:
- material: what the product is made of, its ingredients, or its composition
- useCase: what it is for, when or how it is used, or who it is for
- size: a size, weight, volume, dimension, or quantity
- attribute: a specific verifiable attribute (certification, warranty, shelf life,
  dietary claim, or a measured specification)

Return ONLY JSON in this exact shape, one entry per description:
{"results":[{"i":0,"material":true,"useCase":false,"size":true,"attribute":false}]}`;

async function gradeDescriptions(products, onProgress = () => {}) {
  const out = { used: false, model: GEMINI_MODEL, error: null, answers: {}, cached: 0, graded: 0 };
  if (!GEMINI_KEY) { out.error = 'No GEMINI_API_KEY set'; return out; }

  const { createHash } = await import('node:crypto');
  const hash = (s) => createHash('sha1').update(s).digest('hex');

  const pending = [];
  for (const p of products) {
    const text = (p.descFull || '').trim();
    if (!text) continue;
    const key = hash(text);
    if (llmCache.has(key)) { out.answers[p.handle] = llmCache.get(key); out.cached++; continue; }
    pending.push({ handle: p.handle, key, text: text.slice(0, 1200) });
  }
  if (!pending.length) { out.used = out.cached > 0; return out; }

  onProgress('Grading descriptions');
  const body = {
    contents: [{ parts: [{ text: `${GRADER_PROMPT}\n\n${pending.map((x, i) => `[${i}] ${x.text}`).join('\n\n')}` }] }],
    // temperature 0 so the same copy grades the same way on every scan
    generationConfig: { temperature: 0, responseMimeType: 'application/json' },
  };

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 30000);
  try {
    const res = await fetch(GEMINI_URL(GEMINI_MODEL), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_KEY },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    if (!res.ok) {
      const raw = await res.text();
      const parsedErr = safeJson(raw);
      const detail = (parsedErr && parsedErr.error && parsedErr.error.message)
        || raw.slice(0, 120).replace(/\s+/g, ' ');
      out.error = res.status === 429
        ? `Gemini rate limit hit (free tier) — ${detail}`
        : `Gemini returned ${res.status} — ${detail}`;
      return out;
    }
    const j = safeJson(await res.text());
    const text = j && j.candidates && j.candidates[0] && j.candidates[0].content
      && (j.candidates[0].content.parts || []).map((p) => p.text).join('');
    const parsed = safeJson(text || '');
    const rows = parsed && Array.isArray(parsed.results) ? parsed.results : null;
    if (!rows) { out.error = 'Gemini response was not the expected JSON shape'; return out; }

    for (const row of rows) {
      const item = pending[Number(row.i)];
      if (!item) continue;
      const verdict = Object.fromEntries(ANSWER_FIELDS.map((f) => [f, row[f] === true]));
      llmCache.set(item.key, verdict);
      out.answers[item.handle] = verdict;
      out.graded++;
    }
    out.used = out.graded > 0 || out.cached > 0;
    if (!out.used) out.error = 'Gemini returned no usable rows';
  } catch (e) {
    out.error = `Gemini request failed — ${String(e.name === 'AbortError' ? 'timed out after 30s' : e.message)}`;
  } finally { clearTimeout(timer); }
  return out;
}

/** Is the price visible in raw HTML in any plausible rendered format? */
function priceInHtml(html, priceStr) {
  if (!priceStr) return false;
  const num = Number(priceStr);
  if (!Number.isFinite(num)) return false;
  const whole = Math.round(num);
  const forms = new Set([priceStr, String(num), String(whole), num.toFixed(2),
    whole.toLocaleString('en-IN'), num.toLocaleString('en-IN', { minimumFractionDigits: 2 }),
    whole.toLocaleString('en-US'), num.toLocaleString('en-US', { minimumFractionDigits: 2 })]);
  const hay = html.replace(/&nbsp;/g, ' ');
  for (const f of forms) if (f && f.length >= 2 && hay.includes(f)) return true;
  return false;
}
const clamp = (n) => Math.max(0, Math.min(100, Math.round(n)));

/**
 * Page speed as a crawler experiences it: time to first byte and HTML payload.
 *
 * NOT Core Web Vitals. The spec asks for LCP < 2.5s via PageSpeed Insights,
 * which needs an API key and ~30s per URL — 10 minutes added to every scan. TTFB
 * and payload are what actually decide how many pages a crawler samples per
 * visit, and they cost nothing.
 *
 * Free below 600KB and 800ms, then graded. Returned as a breakdown rather than
 * a bare number so the screen can show which half of it hurt.
 */
export function pageSpeedScore(kb, ttfb) {
  const sizePenalty = kb <= 600 ? 0 : kb <= 1000 ? (kb - 600) / 20 : 20 + (kb - 1000) / 40;
  const timePenalty = ttfb <= 800 ? 0 : ttfb <= 2000 ? (ttfb - 800) / 40 : 30 + (ttfb - 2000) / 100;
  return { score: clamp(100 - sizePenalty - timePenalty), sizePenalty, timePenalty };
}
const safeJson = (t) => { try { return JSON.parse(t); } catch { return null; } };
/**
 * Tags out, text left. Script and style CONTENTS must go first — removing only
 * the tags leaves the JavaScript behind as "text", which counted superyou.in's
 * refund policy at 126,010 characters when the policy itself is 2,580. Every
 * length-graded check was reading inline JS.
 */
const stripHtml = (h) => (h || '')
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();

/**
 * MerchantReturnPolicy is the machine-readable answer to "can I return this,
 * by when, at what cost". It sits in different places depending on the theme —
 * on the Product's offer, on the Organization, on an OnlineStore block, or on
 * its own — so this walks the whole graph rather than guessing a path.
 */
function findReturnPolicy(blocks) {
  const found = new Set();
  const walk = (v, depth) => {
    if (!v || typeof v !== 'object' || depth > 6) return;
    if (Array.isArray(v)) return v.forEach((x) => walk(x, depth + 1));
    if ([].concat(v['@type'] || []).includes('MerchantReturnPolicy')) found.add(v);
    for (const k of Object.keys(v)) {
      // Themes often nest an UNTYPED stub here — littlerituals.in publishes
      // {"merchantReturnLink": "..."} with no @type. Keying off @type alone
      // misses it and scores the store as having nothing, which is unfair:
      // a machine-readable pointer beats prose, it just isn't full terms.
      if (k === 'hasMerchantReturnPolicy' && v[k] && typeof v[k] === 'object' && !Array.isArray(v[k])) found.add(v[k]);
      walk(v[k], depth + 1);
    }
  };
  blocks.forEach((b) => walk(b, 0));
  if (!found.size) return null;
  // prefer the richest one if a page carries several
  const rank = (p) => (p.merchantReturnDays != null ? 2 : p.returnPolicyCategory || p.returnFees ? 1 : 0);
  const p = [...found].sort((a, b) => rank(b) - rank(a))[0];
  const tail = (x) => (typeof x === 'string' ? x.split('/').pop() : null);
  const days = Number(p.merchantReturnDays);
  const out = {
    days: Number.isFinite(days) ? days : null,
    category: tail(p.returnPolicyCategory),
    fees: tail(p.returnFees),
    method: tail(p.returnMethod),
    country: [].concat(p.applicableCountry || []).filter(Boolean).join(', ') || null,
    link: p.merchantReturnLink || p.returnPolicyURL || null,
  };
  // a stub that carries a URL and nothing else
  out.linkOnly = out.days == null && !out.category && !out.fees && !out.method && !!out.link;
  return out;
}

/** Shopify's own policy pages wrap the text; prefer it over the whole page. */
function policyText(html) {
  const m = html.match(/<div[^>]+class="[^"]*shopify-policy__body[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i)
    || html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
  return stripHtml(m ? m[1] : html);
}
const words = (t) => (t ? t.split(/\s+/).filter(Boolean).length : 0);
const median = (a) => (a.length ? a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0);

function normalizeDomain(s) {
  s = String(s).trim();
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  return new URL(s).origin;
}

async function get(url, ua = AGENTS.Chrome) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  const t0 = Date.now();
  try {
    const res = await publicFetch(url, { headers: { 'User-Agent': ua }, signal: ctl.signal });
    const ttfb = res.headersAt - t0;
    const body = await res.text();
    return { ok: res.ok, status: res.status, finalUrl: res.url, bytes: body.length, body,
             ttfb, total: Date.now() - t0, cf: !!res.headers.get('cf-ray') };
  } catch (e) {
    return { ok: false, status: 0, finalUrl: url, bytes: 0, body: '', ttfb: 0, total: 0, error: String(e.name || e) };
  } finally { clearTimeout(t); }
}

async function mapLimit(items, limit, fn) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]); await sleep(DELAY_MS); }
  }));
  return out;
}

function spreadSample(arr, n) {
  if (arr.length <= n) return arr.slice();
  const step = arr.length / n;
  return Array.from({ length: n }, (_, i) => arr[Math.floor(i * step)]);
}

function extractJsonLd(html) {
  const out = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    const p = safeJson(m[1].trim()); if (!p) continue;
    if (Array.isArray(p)) out.push(...p);
    else if (p['@graph']) out.push(...[].concat(p['@graph']));
    else out.push(p);
  }
  return out;
}
const isType = (b, t) => b && [].concat(b['@type'] || []).includes(t);

function parseRobots(txt) {
  const groups = []; let cur = null;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim(); if (!line) continue;
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/); if (!m) continue;
    const f = m[1].toLowerCase(), v = m[2].trim();
    if (f === 'user-agent') { if (!cur || cur.rules.length) { cur = { agents: [], rules: [] }; groups.push(cur); } cur.agents.push(v.toLowerCase()); }
    else if (cur && (f === 'disallow' || f === 'allow')) cur.rules.push({ type: f, path: v });
  }
  return groups;
}

// ==================================================================== COLLECT

export async function collect(domainInput, onProgress = () => {}, options = {}) {
  const origin = normalizeDomain(domainInput);
  const raw = { domain: origin, scannedAt: new Date().toISOString(), errors: [] };

  onProgress('Reaching the store');
  const home = await get(origin + '/');
  if (home.status === 0) { raw.errors.push('NO_RESPONSE'); return raw; }
  raw.homeStatus = home.status;
  raw.behindCloudflare = home.cf;
  raw.isShopify = /cdn\.shopify\.com|Shopify\.shop/i.test(home.body);
  if (!raw.isShopify && home.status === 200) { raw.errors.push('NOT_SHOPIFY'); return raw; }
  if (home.status >= 400) { raw.errors.push(`BLOCKED_${home.status}`); }

  raw.checkoutStack = CHECKOUT_STACKS.filter((c) => c.re.test(home.body)).map((c) => c.key);
  // Some themes and embedded apps leak the shop's plan into the homepage HTML.
  // Present is proof absent proves nothing, so this is never scored.
  raw.planName = (home.body.match(/"planName"\s*:\s*"([^"]+)"/i) || [])[1] || null;
  raw.myshopifyDomain = (home.body.match(/"myshopifyDomain"\s*:\s*"([^"]+)"/i) || [])[1] || null;
  const homeBlocks = extractJsonLd(home.body);
  const org = homeBlocks.find((b) => isType(b, 'Organization'));
  // entries that are actually URLs count.
  const sameAsRaw = org && Array.isArray(org.sameAs) ? org.sameAs : [];
  raw.orgSameAs = sameAsRaw.filter((u) => typeof u === 'string' && /^https?:\/\/\S+/i.test(u.trim()));
  raw.org = { present: !!org, sameAs: raw.orgSameAs.length, emptySlots: sameAsRaw.length - raw.orgSameAs.length };
  raw.brandName = (org && org.name) || (home.body.match(/<title>([^<]+)</i) || [])[1] || origin;
  raw.orgLogo = org && (typeof org.logo === 'string' ? org.logo : org.logo && org.logo.url) || '';
  // currency for the fix snippets — the product pages are the reliable source,
  // this is only the fallback when none of them carry an offer
  raw.currency = (home.body.match(/Shopify\.currency\s*=\s*\{[^}]*"active"\s*:\s*"([A-Z]{3})"/) || [])[1] || null;
  // How the brand name is rendered, for Layer 4's entity-consistency check.
  // Tokenised so "SuperYou", "Super You" and "Super-You" all match, and we can
  // tell which literal form each page actually used.
  const brandBase = String(raw.brandName || '').split(/[|–—:·]/)[0].trim();
  const brandTokens = brandBase.replace(/([a-z])([A-Z])/g, '$1 $2').split(/\s+/).filter(Boolean).slice(0, 3);
  raw.brandMatch = brandTokens.length
    ? brandTokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s\\-_.]*')
    : null;

  onProgress('Checking crawler access');
  raw.botWall = {};
  for (const [name, ua] of Object.entries(AGENTS)) {
    const r = await get(origin + '/', ua);
    raw.botWall[name] = {
      status: r.status, bytes: r.bytes,
      challenged: /just a moment|checking your browser|captcha|access denied/i.test(r.body.slice(0, 4000)),
    };
    await sleep(DELAY_MS);
  }

  onProgress('Reading robots.txt');
  const rob = await get(origin + '/robots.txt');
  raw.robots = { fetched: rob.ok, blocked: [], named: [] };
  if (rob.ok) {
    const groups = parseRobots(rob.body);
    for (const bot of AI_BOTS) {
      const exact = groups.find((g) => g.agents.includes(bot.toLowerCase()));
      if (exact) raw.robots.named.push(bot);
      const grp = exact || groups.find((g) => g.agents.includes('*'));
      if (grp && grp.rules.some((r) => r.type === 'disallow' && r.path === '/')) raw.robots.blocked.push(bot);
    }
  }

  onProgress('Reading store policies');
  const firstFound = async (paths) => {
    for (const p of paths) {
      const r = await get(origin + p);
      await sleep(DELAY_MS);
      if (r.ok) { const len = policyText(r.body).length; if (len > 200) return { path: p, len, body: r.body }; }
    }
    return { path: null, len: 0, body: '' };
  };
  raw.policyReturn = await firstFound(RETURN_PATHS);
  raw.policyShipping = await firstFound(SHIPPING_PATHS);
  // the policy page is one of the places the return schema can live
  raw.returnSchema = findReturnPolicy(extractJsonLd(raw.policyReturn.body || ''));
  delete raw.policyReturn.body;
  delete raw.policyShipping.body;

  // FAQ schema lives on dedicated pages far more often than on PDPs
  raw.faq = { onHomepage: homeBlocks.some((b) => isType(b, 'FAQPage') || isType(b, 'HowTo')), onFaqPage: false, faqPageExists: false, path: null };
  for (const p of FAQ_PATHS) {
    const r = await get(origin + p);
    await sleep(DELAY_MS);
    if (r.ok && stripHtml(r.body).length > 400) {
      raw.faq.faqPageExists = true;
      raw.faq.path = p;
      if (extractJsonLd(r.body).some((b) => isType(b, 'FAQPage') || isType(b, 'HowTo'))) raw.faq.onFaqPage = true;
      break;
    }
  }

  raw.reviewApps = REVIEW_APPS.filter((a) => a.re.test(home.body)).map((a) => a.key);

  onProgress('Loading the product catalogue');
  const cat = await get(`${origin}/products.json?limit=250`);
  const cj = safeJson(cat.body);
  const products = cj && Array.isArray(cj.products) ? cj.products : [];
  raw.catalogOpen = products.length > 0;
  raw.catalogCount = products.length;
  if (!products.length) { raw.errors.push('NO_CATALOG'); return raw; }

  const sm = await get(origin + '/sitemap.xml');
  raw.sitemapOk = sm.ok;
  raw.sitemapProductCount = 0;
  if (sm.ok) {
    const locs = [...sm.body.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map((m) => m[1]);
    for (const child of locs.filter((u) => /product/i.test(u)).slice(0, 2)) {
      const c = await get(child);
      if (c.ok) raw.sitemapProductCount += [...c.body.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)]
        .filter((m) => /\/products\//.test(m[1])).length;
      await sleep(DELAY_MS);
    }
  }

  /**
   * UCP profile. Shopify serves this from its platform layer, beneath whatever
   * checkout app sits on the storefront — which is why stack depth has no
   * bearing on it. Verified identical on 13 stores spanning native checkout to
   * four stacked apps.
   *
   * Note the shape: capabilities live at `ucp.capabilities`, NOT at the root,
   * and each capability is an ARRAY of version objects. Reading `.capabilities`
   * off the root returns undefined and scores every store zero.
   */
  const ucpRes = await get(origin + '/.well-known/ucp');
  raw.ucp = { ok: false, status: ucpRes.status, version: null, checkoutVersions: [], capabilities: [], supportedVersions: [] };
  if (ucpRes.ok) {
    const parsed = safeJson(ucpRes.body);
    const u = parsed && parsed.ucp;
    if (u) {
      const checkout = (u.capabilities || {})['dev.ucp.shopping.checkout'];
      raw.ucp = {
        ok: true,
        status: ucpRes.status,
        version: u.version || null,
        capabilities: Object.keys(u.capabilities || {}),
        checkoutVersions: [].concat(checkout || []).map((c) => c && c.version).filter(Boolean),
        supportedVersions: Object.keys(u.supported_versions || {}),
      };
    }
  }
  await sleep(DELAY_MS);

  // llms.txt — reported for completeness; Shopify auto-generates it store-wide
  const llms = await get(origin + '/llms.txt');
  raw.llmsTxt = {
    exists: llms.ok && llms.bytes > 0,
    shopifyGenerated: /shop\.app\/SKILL\.md|agentic storefronts|agent instructions/i.test(llms.body || ''),
    bytes: llms.bytes,
  };

  onProgress(`Inspecting ${Math.min(SAMPLE_SIZE, products.length)} products`);
  const sample = spreadSample(products, SAMPLE_SIZE);
  raw.products = await mapLimit(sample, CONCURRENCY, async (p) => {
    const url = `${origin}/products/${p.handle}`;
    const r = await get(url);
    const html = r.ok ? r.body : '';
    const blocks = extractJsonLd(html);
    const pb = blocks.find((b) => isType(b, 'Product'));
    const offers = pb ? [].concat(pb.offers || []) : [];
    const desc = stripHtml(p.body_html);
    const options = (p.options || []).filter((o) => o.name !== 'Title');
    const variants = p.variants || [];
    const agg = pb && pb.aggregateRating ? pb.aggregateRating : null;
    const canonical = (html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i) || [])[1] || '';
    const robotsMeta = (html.match(/<meta[^>]+name=["']robots["'][^>]+content=["']([^"']+)["']/i) || [])[1] || '';

    return {
      handle: p.handle,
      title: p.title,
      url,
      pageOk: r.ok,
      status: r.status,
      htmlBytes: r.bytes,
      ttfb: r.ttfb,
      loadMs: r.total,
      // Layer 3: what a shopper is told vs what an agent can parse
      returnSchema: findReturnPolicy(blocks),
      codInText: COD_RE.test(html),
      prepaidInText: PREPAID_RE.test(html),
      pincodeWidget: PINCODE_RE.test(html),
      paymentSchema: offers.some((o) => o && o.acceptedPaymentMethod != null),
      shippingSchema: offers.some((o) => o && o.shippingDetails != null),
      reviewAppOnPage: REVIEW_APPS.some((a) => a.re.test(html)),
      reviewAppsOnPage: REVIEW_APPS.filter((a) => a.re.test(html)).map((a) => a.key),
      reviewUiOnPage: REVIEW_UI_RE.test(html),
      staticTitle: !!(p.title && html.includes(p.title.slice(0, 40))),
      staticPrice: priceInHtml(html, variants[0] ? variants[0].price : null),
      staticAvail: /in stock|out of stock|sold out|add to cart|schema\.org\/InStock|schema\.org\/OutOfStock/i.test(html),
      scriptTags: (html.match(/<script[\s>]/gi) || []).length,
      noindex: /noindex/i.test(robotsMeta),
      hasCanonical: !!canonical,
      price: variants[0] ? variants[0].price : null,
      sku: variants[0] ? variants[0].sku : null,
      // real variants, used to build a fix snippet the brand can paste as-is
      variantSample: variants.slice(0, 3).map((v) => ({
        title: v.title, price: v.price, sku: v.sku || null, available: !!v.available,
      })),
      offerCurrency: offers.map((o) => o && o.priceCurrency).find(Boolean) || null,
      available: variants.some((v) => v.available),
      imageCount: (p.images || []).length,
      descWords: words(desc),
      descSnippet: desc.slice(0, 220),
      descFull: desc.slice(0, 2000),
      // distinct literal renderings of the brand name in this page's visible text
      brandForms: raw.brandMatch
        ? [...new Set((stripHtml(html).match(new RegExp(raw.brandMatch, 'gi')) || []).slice(0, 40))]
        : [],
      descKey: desc.slice(0, 200).toLowerCase(),
      unitMentions: (desc.match(UNIT_RE) || []).length,
      hasSpecWord: SPEC_RE.test(desc),
      optionNames: options.map((o) => o.name),
      variantCount: variants.length,
      schema: {
        product: !!pb,
        price: offers.some((o) => o && (o.price != null || o.lowPrice != null)),
        availability: offers.some((o) => o && o.availability != null),
        sku: !!(pb && (pb.sku || offers.some((o) => o && o.sku))),
        brand: !!(pb && pb.brand),
        variantLevelOffers: offers.length > 1 || (pb && Array.isArray(pb.hasVariant)),
        rating: !!agg,
        ratingCount: agg ? Number(agg.reviewCount || agg.ratingCount || 0) : 0,
        faq: blocks.some((b) => isType(b, 'FAQPage') || isType(b, 'HowTo')),
      },
    };
  });

  // Optional: grade the sampled descriptions with Gemini. Falls back silently
  // to keyword detection when no key is set or the call fails.
  raw.llm = options.contentMethod === 'heuristic'
    ? { used: false, model: null, graded: 0, cached: 0, error: null }
    : await gradeDescriptions(raw.products, onProgress);

  return raw;
}

// ======================================================= LAYER 2 FIX SNIPPETS
// Every snippet is built from the store's own catalogue — real handle, real
// price, real SKU, real option names. Two stores never get the same block, and
// a brand can paste what it sees without editing placeholders back out.
// Anything we genuinely cannot know is written in SCREAMING_CASE so it is
// obvious it still needs a human.

const ld = (obj) => JSON.stringify(obj, null, 2);
const availUrl = (yes) => `https://schema.org/${yes ? 'InStock' : 'OutOfStock'}`;

function productFix(p, brand, currency) {
  return ld({
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: p.title,
    url: p.url,
    sku: p.sku || 'YOUR_SKU_HERE',
    brand: { '@type': 'Brand', name: brand },
    offers: {
      '@type': 'Offer',
      url: p.url,
      price: p.price,
      priceCurrency: currency,
      availability: availUrl(p.available),
    },
  });
}

function variantFix(p, brand, currency) {
  const opts = p.optionNames.length ? p.optionNames : ['Size'];
  return ld({
    '@context': 'https://schema.org',
    '@type': 'ProductGroup',
    name: p.title,
    url: p.url,
    productGroupID: p.handle,
    brand: { '@type': 'Brand', name: brand },
    variesBy: opts.map((o) => o.toLowerCase()),
    hasVariant: p.variantSample.map((v) => ({
      '@type': 'Product',
      name: `${p.title} — ${v.title}`,
      sku: v.sku || 'YOUR_SKU_HERE',
      offers: {
        '@type': 'Offer',
        price: v.price,
        priceCurrency: currency,
        availability: availUrl(v.available),
      },
    })),
  });
}

function orgFix(brand, domain, logo, sameAs) {
  const links = sameAs.length >= 2 ? sameAs
    : [...sameAs, 'https://www.instagram.com/YOUR_HANDLE', 'https://www.linkedin.com/company/YOUR_COMPANY'].slice(0, 3);
  return ld({
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: brand,
    url: domain,
    logo: logo || `${domain}/YOUR_LOGO.png`,
    sameAs: links,
  });
}

function faqFix(brand) {
  return ld({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: [
      { '@type': 'Question', name: 'How long does delivery take?',
        acceptedAnswer: { '@type': 'Answer', text: 'REPLACE WITH THE ANSWER ALREADY ON YOUR FAQ PAGE' } },
      { '@type': 'Question', name: `Can I return a ${brand} order?`,
        acceptedAnswer: { '@type': 'Answer', text: 'REPLACE WITH THE ANSWER ALREADY ON YOUR FAQ PAGE' } },
    ],
  });
}

function reviewFix(p, currency) {
  return ld({
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: p.title,
    aggregateRating: {
      '@type': 'AggregateRating',
      ratingValue: 'YOUR_AVERAGE_RATING',
      reviewCount: 'YOUR_REVIEW_COUNT',
      bestRating: 5,
    },
    offers: { '@type': 'Offer', price: p.price, priceCurrency: currency, availability: availUrl(p.available) },
  });
}

// ====================================================================== SCORE

function pctOf(list, fn) { return list.length ? clamp((list.filter(fn).length / list.length) * 100) : 0; }

export function score(raw) {
  const live = (raw.products || []).filter((p) => p.pageOk);
  const hasProducts = live.length > 0;

  // ---------------------------------------------------------------- Layer 1
  let botsBlocked = 0;
  const base = raw.botWall ? raw.botWall.Chrome : null;
  const botVerdicts = {};
  for (const bot of ['GPTBot', 'ClaudeBot', 'PerplexityBot']) {
    const b = raw.botWall ? raw.botWall[bot] : null;
    let v = 'ok';
    if (!b || b.status === 0) v = 'no response';
    else if ([401, 403, 429].includes(b.status)) v = `blocked (${b.status})`;
    else if (b.challenged) v = 'challenged';
    else if (base && base.bytes > 0 && b.bytes < base.bytes * 0.5) v = 'truncated';
    botVerdicts[bot] = v;
    if (v !== 'ok') botsBlocked++;
  }
  const l1 = {
    botWall: clamp(100 - (botsBlocked / 3) * 100),
    robots: raw.robots ? clamp(100 - (raw.robots.blocked.length / AI_BOTS.length) * 100) : 0,
    // v2 spec merges "can agents enumerate the catalogue" with "are the pages
    // indexable" into one check. Sitemap is no longer part of it — that moved
    // to measured-but-not-scored, since Shopify generates one for every store.
    productFeed: raw.catalogOpen && hasProducts
      ? clamp(100 - pctOf(live, (p) => p.noindex) - pctOf(live, (p) => !p.hasCanonical) * 0.3)
      : 0,
    // kept for the measured-but-not-scored rows and the gap messages
    endpoints: clamp((raw.catalogOpen ? 60 : 0) + (raw.sitemapOk ? 40 : 0)),
    indexability: hasProducts
      ? clamp(100 - pctOf(live, (p) => p.noindex) - pctOf(live, (p) => !p.hasCanonical) * 0.3)
      : 0,
    // Recalibrated against real Shopify stores. The previous version penalised
    // >40 script tags, but observed Shopify medians run 64-180 because themes
    // and apps inject dozens of inline blocks (including the JSON-LD we score
    // elsewhere). Script count was the wrong proxy — this uses response time
    // and payload size, which is what actually costs a crawler.
    pageWeight: hasProducts
      ? pageSpeedScore(median(live.map((p) => p.htmlBytes)) / 1024, median(live.map((p) => p.ttfb || 0))).score
      : 0,
  };

  // ---------------------------------------------------------------- Layer 2
  const schemaRatingPct = pctOf(live, (p) => p.schema.rating);
  // apps named anywhere — homepage or any sampled product page
  const namedApps = [...new Set([...(raw.reviewApps || []), ...live.flatMap((p) => p.reviewAppsOnPage || [])])];
  // an unnamed widget still counts as "reviews exist but aren't readable"
  const reviewAppPresent = namedApps.length > 0 || live.some((p) => p.reviewUiOnPage);
  const reviewAppLabel = namedApps.join(' and ') || 'A review widget';
  const l2 = {
    productSchema: pctOf(live, (p) => p.schema.product && p.schema.price && p.schema.availability && p.schema.sku),
    orgSchema: raw.org && raw.org.present && raw.org.sameAs >= 2 ? 100 : raw.org && raw.org.present ? 40 : 0,
    // three states, not binary: schema present / reviews exist but aren't
    // machine-readable / no reviews at all (not a fault, don't crater the score)
    reviewSchema: schemaRatingPct > 0 ? schemaRatingPct : reviewAppPresent ? 25 : 50,
    variantSchema: pctOf(live, (p) => p.variantCount <= 1 || p.schema.variantLevelOffers),
    // FAQ schema lives on FAQ pages far more often than PDPs
    faqSchema: (() => {
      const f = raw.faq || {};
      if (f.onFaqPage) return 100;
      if (f.onHomepage) return 80;
      if (pctOf(live, (p) => p.schema.faq) > 0) return 70;
      if (f.faqPageExists) return 30;   // FAQ content exists but isn't marked up
      return 50;                         // no FAQ content anywhere — not a fault
    })(),
  };

  // ---------------------------------------------------------------- Layer 3
  const graded = (len) => (len > 1200 ? 100 : len > 400 ? 70 : len > 0 ? 40 : 0);
  const codPct = pctOf(live, (p) => p.codInText);
  const paySchemaPct = pctOf(live, (p) => p.paymentSchema);
  const shipSchemaPct = pctOf(live, (p) => p.shippingSchema);
  const pincodePct = pctOf(live, (p) => p.pincodeWidget);
  // the policy page and the product pages are both valid homes for it
  const returnSchemaPct = pctOf(live, (p) => !!p.returnSchema);
  const returnSchema = raw.returnSchema || live.map((p) => p.returnSchema).find(Boolean) || null;
  const returnSchemaWhere = raw.returnSchema ? 'the return policy page'
    : returnSchemaPct > 0 ? `${live.filter((p) => !!p.returnSchema).length} of ${live.length} product pages` : null;
  const l3 = {
    // Replaces checkoutStack, which the v2 spec retires. Checkout-app detection
    // is kept as informational context only — see raw.checkoutStack.
    ucpProfile: (() => {
      const u = raw.ucp || {};
      if (!u.ok || !u.capabilities.length) return 0;
      if (!u.checkoutVersions.length) return 0;
      // current if the declared checkout version matches the profile's own
      return u.version && u.checkoutVersions.includes(u.version) ? 100 : 40;
    })(),
    // v2 spec: binary. A parseable acceptedPaymentMethod on the Offer or
    // nothing — payment options rendered as page text earn no credit.
    codPayment: paySchemaPct > 0 ? 100 : 0,
    // v2 spec: binary on OfferShippingDetails. The pincode-widget and
    // policy-page signals are still collected and reported, just not scored.
    serviceability: shipSchemaPct > 0 ? 100 : 0,
    // The spec asks for machine-readable, so schema is the measure and prose is
    // only a fallback. Prose caps at 40 however long it is: an agent asked "can
    // I return this" cannot parse a policy page, and rewarding length for its
    // own sake is what the old check did.
    returnPolicy: (() => {
      const s = returnSchema;
      if (s) return s.days != null ? 100 : s.linkOnly ? 55 : 70;
      const len = (raw.policyReturn || {}).len || 0;
      return len > 1200 ? 40 : len > 400 ? 30 : len > 0 ? 20 : 0;
    })(),
    // measured and reported, not scored — see LAYER3_SPEC
    shippingPolicy: graded((raw.policyShipping || {}).len || 0),
  };

  // ---------------------------------------------------------------- Layer 4
  const uniqueDesc = new Set(live.map((p) => p.descKey)).size;
  /**
   * Layer 4, v2 spec structure — answer-first, factual density, entity
   * consistency.
   *
   * The spec computes the first two with a Claude Haiku call that asks four
   * questions per description and counts NOT FOUND answers. This implementation
   * asks the same four questions with deterministic detection instead, so a
   * scan needs no API key, costs nothing per run and adds no latency.
   *
   * What that trades away, stated plainly rather than hidden: keyword detection
   * confirms a description MENTIONS material or size, not that it answers the
   * question well. A description reading "premium materials" counts as
   * answering the material question here; an LLM would mark it NOT FOUND. Treat
   * these as an optimistic bound.
   */
  const ANSWER_PROBES = [
    ['material or composition', /\b(material|composition|ingredients?|made (of|from|with)|fabric|cotton|silk|leather|steel|silicone|wool|linen|bamboo|ceramic|glass|organic|blend)\b/i],
    ['primary use case', /\b(use|uses|used for|ideal for|perfect for|designed for|helps?|suitable for|great for|for (daily|everyday|men|women|kids|dry|oily|sensitive)|apply|wear|serve)\b/i],
    ['size or dimension guidance', /\b\d+(\.\d+)?\s?(ml|l|g|kg|mg|gm|cm|mm|inch|in|ft|oz|lb|gsm|tc|pcs|pack|litre|liter|gram|size)\b|\b(size guide|dimensions?|length|width|height|capacity|volume|weight)\b/i],
    ['a specific factual attribute', /\b(certified|warranty|shelf life|expiry|batch|vegan|cruelty.free|gluten.free|fda|iso|bis|spf|ph\b|calories|protein|dermatologically|clinically)\b/i],
  ];
  // Gemini's verdict when we have one for this product, keyword detection
  // otherwise. `answerFacts` is the single source both the score and the
  // evidence list read, so the two can never describe different things.
  const llmAnswers = (raw.llm && raw.llm.answers) || {};
  const llmUsed = !!(raw.llm && raw.llm.used) && live.some((p) => llmAnswers[p.handle]);
  const answerFacts = (p) => {
    const graded = llmAnswers[p.handle];
    if (graded) return ANSWER_PROBES.map(([label], i) => [label, graded[ANSWER_FIELDS[i]] === true]);
    const d = (p.descFull || p.descSnippet || '');
    return ANSWER_PROBES.map(([label, re]) => [label, d.trim() ? re.test(d) : false]);
  };
  const answerScore = (p) => (answerFacts(p).filter(([, ok]) => ok).length / ANSWER_PROBES.length) * 100;
  const l4 = {
    answerFirst: hasProducts ? clamp(live.reduce((a, p) => a + answerScore(p), 0) / live.length) : 0,
    factualDensity: hasProducts
      ? clamp(live.reduce((a, p) => a + Math.min(100, p.unitMentions * 20 + (p.hasSpecWord ? 30 : 0)), 0) / live.length)
      : 0,
    // Brand name rendered one way everywhere = 100; same name differing only in
    // case or spacing = 70; the name missing from some pages entirely = 40.
    entityConsistency: (() => {
      if (!hasProducts) return 0;
      const forms = new Set();
      let missing = 0;
      for (const p of live) {
        if (!p.brandForms || !p.brandForms.length) { missing++; continue; }
        p.brandForms.forEach((f) => forms.add(f));
      }
      if (missing > 0) return 40;
      if (forms.size <= 1) return 100;
      const normalised = new Set([...forms].map((f) => f.toLowerCase().replace(/[^a-z0-9]/g, '')));
      return normalised.size === 1 ? 70 : 40;
    })(),
    // measured and reported, not scored under the v2 weights
    descriptionDepth: hasProducts
      ? clamp(live.reduce((a, p) => {
          const w = p.descWords;
          return a + (w === 0 ? 0 : w < 25 ? 15 : w < 60 ? 40 : w < 120 ? 70 : w < 200 ? 90 : 100);
        }, 0) / live.length)
      : 0,
    uniqueness: hasProducts ? clamp((uniqueDesc / live.length) * 100) : 0,
    imageCoverage: hasProducts
      ? clamp(live.reduce((a, p) => {
          const n = p.imageCount;
          return a + (n === 0 ? 0 : n === 1 ? 20 : n === 2 ? 45 : n <= 4 ? 70 : n <= 6 ? 90 : 100);
        }, 0) / live.length)
      : 0,
  };

  const layerScore = (subs, checks) => clamp(Object.entries(subs).reduce((a, [k, w]) => a + checks[k] * w, 0));
  const layers = {
    layer1: { name: 'Crawler & technical access', score: layerScore(SUB.layer1, l1), checks: l1, weight: WEIGHTS.layer1 },
    layer2: { name: 'Structured data',            score: layerScore(SUB.layer2, l2), checks: l2, weight: WEIGHTS.layer2 },
    layer3: { name: 'Checkout & UCP readiness',   score: layerScore(SUB.layer3, l3), checks: l3, weight: WEIGHTS.layer3 },
    layer4: { name: 'Content clarity',            score: layerScore(SUB.layer4, l4), checks: l4, weight: WEIGHTS.layer4 },
  };

  const included = Object.keys(layers).filter((k) => !SKIPPED_LAYERS.includes(k));
  const totalWeight = included.reduce((a, k) => a + WEIGHTS[k], 0);
  const final = clamp(included.reduce((a, k) => a + layers[k].score * (WEIGHTS[k] / totalWeight), 0));
  const grade = GRADES.find((g) => final >= g.min);

  // ------------------------------------------------------------- top 3 gaps
  // Every message cites a number measured on THIS store, so two scans never
  // read the same.
  const n = live.length;
  const cnt = (fn) => live.filter(fn).length;
  const CHECKOUT_NOTES = {
    GoKwik: 'GoKwik replaces the native cart and checkout with its own one-click flow',
    Shopflo: 'Shopflo takes over checkout on its own hosted domain',
    RazorpayMagic: 'Razorpay Magic Checkout intercepts the native checkout step',
    Simpl: 'Simpl inserts its own pay-later flow into checkout',
    Snapmint: 'Snapmint adds an EMI path outside the native checkout',
    Fastrr: 'Fastrr replaces the checkout flow entirely',
    Shiprocket: 'Shiprocket Checkout overrides the native flow',
  };
  const missingSchemaField = () => {
    const gaps = [
      ['SKU', cnt((p) => !p.schema.sku)],
      ['price', cnt((p) => !p.schema.price)],
      ['stock status', cnt((p) => !p.schema.availability)],
    ].filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1]);
    return gaps.length ? `${gaps[0][0]} is missing on ${gaps[0][1]} of ${n}` : `incomplete on some products`;
  };

  const LABELS = {
    botWall: () => {
      const blocked = Object.entries(botVerdicts).filter(([, x]) => x !== 'ok');
      return `${blocked.map(([b]) => b).join(' and ')} cannot load the site — ${blocked[0] ? blocked[0][1] : 'blocked'}. Agents that can't fetch a page can't recommend what's on it.`;
    },
    robots: () => `robots.txt explicitly disallows ${raw.robots.blocked.join(', ')}.`,
    endpoints: () => raw.catalogOpen
      ? 'The sitemap is unavailable, so agents have no reliable list of product URLs to crawl.'
      : `The public product feed is closed (products.json returned nothing), so no agent can enumerate the ${raw.catalogCount || 0} products.`,
    indexability: () => `${cnt((p) => p.noindex)} of ${n} sampled products carry a noindex tag, and ${cnt((p) => !p.hasCanonical)} have no canonical URL.`,
    pageWeight: () => {
      const kb = Math.round(median(live.map((p) => p.htmlBytes)) / 1024);
      const ms = median(live.map((p) => p.ttfb || 0));
      return `Product pages average ${kb}KB and take ${ms}ms to first byte — slow enough that crawlers sample fewer pages per visit.`;
    },
    productSchema: (v) => `${n - Math.round((v / 100) * n)} of ${n} sampled products have incomplete structured data — ${missingSchemaField()}. Agents read price and stock from this, not from the page.`,
    orgSchema: () => raw.org && raw.org.present
      ? `The homepage has brand data but only ${raw.org.sameAs} linked profile${raw.org.sameAs === 1 ? '' : 's'}. Agents use these to confirm ${raw.brandName} is a real business.`
      : `${raw.brandName} has no Organization markup on the homepage, so agents can't tie the catalogue to a verified brand.`,
    reviewSchema: (v) => v === 25
      ? `${reviewAppLabel} is displaying reviews, but none are exposed as structured data — so agents can't see the ratings customers can.`
      : `${cnt((p) => !p.schema.rating)} of ${n} products have no machine-readable rating. Reviews are one of the five signals Shopify ranks agentic listings on.`,
    variantSchema: () => `${cnt((p) => p.variantCount > 1 && !p.schema.variantLevelOffers)} of ${n} products have multiple variants but expose only one price, so an agent asked for a specific size can't confirm it exists.`,
    faqSchema: (v) => v === 30
      ? 'There is FAQ content on the site but it carries no schema, so agents can\'t use it to answer pre-purchase questions.'
      : 'No FAQ or HowTo data anywhere, so agents have nothing to answer pre-purchase questions from.',
    checkoutStack: () => {
      const stack = raw.checkoutStack || [];
      const notes = stack.map((s) => CHECKOUT_NOTES[s]).filter(Boolean);
      const lead = stack.length > 1
        ? `All ${raw.catalogCount} products route through ${stack.length} stacked checkout systems (${stack.join(', ')})`
        : `All ${raw.catalogCount} products route through ${stack[0]}`;
      return `${lead}. ${notes[0] ? notes[0].charAt(0).toUpperCase() + notes[0].slice(1) : ''}, which may sit outside the native agentic purchase path. Needs confirming against Shopify's Agentic settings for this store.`;
    },
    ucpProfile: () => (raw.ucp || {}).ok
      ? 'The UCP profile is served but declares no current checkout capability, so agents cannot confirm this store can complete a purchase.'
      : `Nothing parseable is served at /.well-known/ucp (${(raw.ucp || {}).status || 'no response'}), so agents have no machine-readable declaration that this store supports checkout.`,
    codPayment: () => {
      const inText = cnt((p) => p.codInText || p.prepaidInText);
      return `No product declares acceptedPaymentMethod in its Offer${inText ? `, though ${inText} of ${n} name payment options in page text a shopper can read and an agent cannot` : ''}. COD versus prepaid is the biggest purchase-path question in Indian ecommerce and it is invisible to agents.`;
    },
    serviceability: () => {
      const widget = cnt((p) => p.pincodeWidget);
      return `No product publishes OfferShippingDetails${widget ? `, and the pincode checker on ${widget} of ${n} pages calls a private API from JavaScript` : ''}. An agent asked whether you deliver to a given pincode has nothing to read.`;
    },
    returnPolicy: (v) => v === 0
      ? 'No return policy page was found at any standard URL, so an agent asked "can I return this?" has nothing to quote.'
      : v === 70
        ? 'The return policy is published as structured data but states no return window — the one field an agent needs most.'
        : `The return policy exists as ${(raw.policyReturn || {}).len} characters of prose with no MerchantReturnPolicy markup, so an agent can't tell how long the window is or who pays for the return.`,
    shippingPolicy: (v) => v === 0
      ? 'No shipping policy page was found at any standard URL, so agents can\'t answer delivery questions before checkout.'
      : `The shipping policy is only ${(raw.policyShipping || {}).len} characters — not enough for an agent to quote delivery terms.`,
    factualDensity: () => `Sampled descriptions average ${(live.reduce((a, p) => a + p.unitMentions, 0) / n).toFixed(1)} concrete measurements each, and ${cnt((p) => !p.hasSpecWord)} of ${n} never mention material, ingredients or dimensions.`,
    descriptionDepth: () => {
      const empty = cnt((p) => p.descWords === 0);
      const thin = cnt((p) => p.descWords > 0 && p.descWords < 60);
      return `${empty} of ${n} sampled products have no description at all and ${thin} have fewer than 60 words. Description length is the first signal Shopify names for agentic ranking.`;
    },
    answerFirst: () => {
      const worst = ANSWER_PROBES.map(([label, re]) => [label, cnt((p) => !re.test(p.descFull || ''))])
        .sort((a, b) => b[1] - a[1])[0];
      return `Sampled descriptions answer ${Math.round(l4.answerFirst / 25)} of the 4 questions an agent asks — ${worst[1]} of ${n} never cover ${worst[0]}.`;
    },
    entityConsistency: (v) => v === 40
      ? `The brand name isn't rendered consistently across sampled pages, so agents can't reliably tie these products to one seller.`
      : `The brand name appears in more than one written form across sampled pages, which weakens the link between the catalogue and the brand entity.`,
    productFeed: () => raw.catalogOpen
      ? `${cnt((p) => p.noindex)} of ${n} sampled products carry a noindex tag, and ${cnt((p) => !p.hasCanonical)} have no canonical URL.`
      : `The public product feed is closed (products.json returned nothing), so no agent can enumerate the ${raw.catalogCount || 0} products.`,
    uniqueness: () => `${n - new Set(live.map((p) => p.descKey)).size} of ${n} sampled products reuse another product's description, so agents can't tell them apart.`,
    imageCoverage: () => `${cnt((p) => p.imageCount <= 1)} of ${n} products have one image or none. Agents use image count to decide how confidently they can show a product.`,
  };

  const allChecks = [];
  for (const key of included) {
    for (const [ck, cw] of Object.entries(SUB[key])) {
      const s = layers[key].checks[ck];
      allChecks.push({ layer: key, check: ck, score: s, impact: (WEIGHTS[key] / totalWeight) * cw * (100 - s) });
    }
  }
  const gaps = allChecks.filter((c) => c.score < 90).sort((a, b) => b.impact - a.impact).slice(0, 3)
    .map((c) => ({ ...c, message: LABELS[c.check] ? LABELS[c.check](c.score) : c.check }));


  // ------------------------------------ full Layer 1 + 2 detail, per the spec
  // Every check the spec names, with what we measured. Checks marked
  // scored:false returned an identical result on every Shopify store tested
  // and so cannot rank one store against another.
  const staticPct = (f) => pctOf(live, f);
  const renderPct = hasProducts ? Math.round(
    live.reduce((a, p) => {
      const shown = [p.staticTitle, p.staticPrice, p.staticAvail].filter(Boolean).length;
      return a + (shown / 3) * 100;
    }, 0) / live.length) : 0;

  // ------------------------------------------------------- speed, in detail
  // Same numbers Layer 1 scores on, shown rather than buried in a spec row.
  // The penalty split matters: 470KB at 400ms and 470KB at 3s score very
  // differently, and only one of them is fixable by trimming the theme.
  const speed = hasProducts ? (() => {
    const kbs = live.map((p) => p.htmlBytes / 1024);
    const ttfbs = live.map((p) => p.ttfb || 0);
    const totals = live.map((p) => p.loadMs || 0);
    const kb = median(kbs);
    const ttfb = median(ttfbs);
    const { score: sc, sizePenalty, timePenalty } = pageSpeedScore(kb, ttfb);
    const slowest = live.slice().sort((a, b) => (b.ttfb || 0) - (a.ttfb || 0)).slice(0, 5)
      .map((p) => ({ title: p.title, url: p.url, note: `${p.ttfb}ms · ${Math.round(p.htmlBytes / 1024)}KB` }));
    return {
      score: sc, sampleSize: n,
      medianKb: Math.round(kb), medianTtfb: Math.round(ttfb), medianTotal: Math.round(median(totals)),
      minTtfb: Math.round(Math.min(...ttfbs)), maxTtfb: Math.round(Math.max(...ttfbs)),
      minKb: Math.round(Math.min(...kbs)), maxKb: Math.round(Math.max(...kbs)),
      sizePenalty: Math.round(sizePenalty * 10) / 10,
      timePenalty: Math.round(timePenalty * 10) / 10,
      // Every Shopify store runs on Shopify's own infrastructure, so neither
      // number is a hosting choice the brand made. Slow TTFB here is render
      // time — theme logic and app blocks — and payload is what the theme and
      // its apps emit. Both are fixable by the brand; "upgrade your server" is
      // not the advice.
      verdict: sizePenalty === 0 && timePenalty === 0
        ? 'Inside both thresholds — no penalty applied.'
        : timePenalty > sizePenalty
          ? 'Shopify takes longer to render these pages than to send them — theme logic and app blocks, not page size.'
          : 'The pages are heavy. Every store here sits on the same Shopify infrastructure, so this is theme and app payload rather than hosting.',
      slowest,
      thresholds: 'Free below 600KB and 800ms to first byte, then graded.',
      caveat: 'Time to first byte and HTML payload, measured from this machine — not Core Web Vitals. The spec asks for LCP via PageSpeed Insights, which needs an API key and around 30 seconds per URL.',
    };
  })() : null;

  // ------------------------------------------------ Layer 2, check by check
  // Each check carries three things the summary row can't: what it measured,
  // WHICH products failed, and the exact JSON-LD this store would need to fix
  // it — built from its own catalogue, so no two stores get the same block.
  //
  // `basis` is deliberate and load-bearing. 'measured' means the number is a
  // percentage of the sample. 'state' means it is one of a fixed set of graded
  // outcomes. 'baseline' means no fault was found and the check declines to
  // punish the store — the only two baselines in this layer are "no reviews
  // anywhere" and "no FAQ content anywhere", both at 50. They are floors by
  // choice, not defaults papering over a failed measurement, and the screen
  // labels them as such so nobody reads 50 as a measurement.
  const layer2Report = (() => {
    const currency = live.map((p) => p.offerCurrency).find(Boolean) || raw.currency || 'INR';
    const brand = raw.brandName;
    const cap = (list) => ({ items: list.slice(0, 8), total: list.length, more: Math.max(0, list.length - 8) });

    const productFails = live
      .filter((p) => !(p.schema.product && p.schema.price && p.schema.availability && p.schema.sku))
      .map((p) => ({ title: p.title, url: p.url, note: p.schema.product
        ? [!p.schema.price && 'no price', !p.schema.availability && 'no availability', !p.schema.sku && 'no sku'].filter(Boolean).join(' · ')
        : 'no Product block at all' }));
    const variantFails = live
      .filter((p) => p.variantCount > 1 && !p.schema.variantLevelOffers)
      .map((p) => ({ title: p.title, url: p.url,
        note: `${p.variantCount} variants (${p.optionNames.join(' × ') || 'unnamed options'}) · one offer published` }));
    const reviewFails = live.filter((p) => !p.schema.rating).map((p) => ({ title: p.title, url: p.url, note: 'no AggregateRating' }));
    // these two lists are things the store got RIGHT — flagged so the screen
    // doesn't colour them like failures
    const faqPdps = live.filter((p) => p.schema.faq)
      .map((p) => ({ title: p.title, url: p.url, note: 'FAQ schema on the product page', pass: true }));

    const sample = (list) => list[0] || live[0] || null;
    const pFix = sample(productFails.length ? live.filter((p) => productFails.some((f) => f.url === p.url)) : live);
    const vFix = sample(live.filter((p) => variantFails.some((f) => f.url === p.url)))
      || live.find((p) => p.variantCount > 1) || live[0] || null;
    const rFix = sample(live.filter((p) => reviewFails.some((f) => f.url === p.url)));

    const wPct = (k) => Math.round(layer2Weight(k) * 1000) / 10;
    const layerShare = WEIGHTS.layer2 / totalWeight;

    const build = (key, o) => {
      const meta = LAYER2_SPEC.find((c) => c.key === key);
      const w = meta.scored ? layer2Weight(key) : 0;
      return {
        key,
        spec: meta.label,
        label: meta.label,
        specSub: meta.specSub,
        effectiveSub: meta.scored ? wPct(key) : null,
        scored: meta.scored,
        value: o.value,
        basis: o.basis,
        basisNote: o.basisNote || '',
        result: o.result,
        why: o.why,
        added: false,
        pointsEarned: Math.round(o.value * w * 10) / 10,
        pointsLost: Math.round((100 - o.value) * w * 10) / 10,
        costOfTotal: Math.round((100 - o.value) * w * layerShare * 10) / 10,
        evidence: o.evidence || null,
        fix: o.fix || null,
      };
    };

    const checks = [
      build('productSchema', {
        value: l2.productSchema,
        basis: 'measured',
        basisNote: `${live.length - productFails.length} of ${n} sampled products passed all four fields`,
        result: `${Math.round((l2.productSchema / 100) * n)} of ${n} products have price + availability + SKU`,
        why: 'Built as specified. Real variance across stores — 0% to 100%.',
        evidence: {
          headline: productFails.length
            ? `${productFails.length} of ${n} sampled products are missing at least one field`
            : `All ${n} sampled products publish price, availability and SKU`,
          ...cap(productFails),
        },
        fix: pFix && productFails.length ? {
          headline: `Product JSON-LD for ${pFix.title}`,
          where: 'Theme editor → product template, or your schema app’s Product settings',
          steps: [
            (() => {
              const parts = [['sku', cnt((p) => !p.schema.sku)], ['price', cnt((p) => !p.schema.price)],
                             ['availability', cnt((p) => !p.schema.availability)]]
                .filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1])
                .map(([f, c]) => `${c} of ${n} omit ${f}`);
              return parts.length ? `${parts.join(', ')}.` : `${productFails.length} of ${n} publish no Product block at all.`;
            })(),
            'Agents read price and stock from this block, not from the rendered page.',
            'Fix it in the template once and it applies to the whole catalogue.',
          ],
          snippet: productFix(pFix, brand, currency),
        } : null,
      }),
      build('variantSchema', {
        value: l2.variantSchema,
        // A store whose whole catalogue is single-variant passes this check
        // vacuously — every product trivially satisfies it. Calling that
        // "measured 100" overstates what we know, so it is labelled a baseline.
        basis: live.some((p) => p.variantCount > 1) ? 'measured' : 'baseline',
        basisNote: live.some((p) => p.variantCount > 1)
          ? `${live.filter((p) => p.variantCount > 1).length} of ${n} sampled products have more than one variant`
          : `No product in the sample has more than one variant, so this check had nothing to evaluate on this store. It scores 100 because no fault was found, not because anything was verified — and it still takes ${Math.round(layer2Weight('variantSchema') * 100)}% of the layer.`,
        result: `${variantFails.length} of ${n} multi-variant products expose only one price`,
        why: 'Redefined. Checking whether option names appear in HTML returned 100 everywhere, so it now checks variant-level offers.',
        evidence: {
          headline: variantFails.length
            ? `${variantFails.length} products publish one offer for several buyable variants`
            : live.some((p) => p.variantCount > 1)
              ? 'Every multi-variant product publishes offers per variant'
              : 'No multi-variant products in the sample — nothing to structure',
          ...cap(variantFails),
        },
        fix: vFix && variantFails.length ? {
          headline: `ProductGroup markup for ${vFix.title}`,
          where: 'Theme editor → product template, replacing the single Product block',
          steps: [
            `${vFix.title} sells ${vFix.variantCount} variants across ${vFix.optionNames.join(' and ') || 'one option'} but publishes one offer.`,
            'An agent asked for a specific size cannot confirm that size exists, so it recommends a competitor that can.',
            'ProductGroup + hasVariant is the pattern Google and the agent crawlers both read.',
          ],
          snippet: variantFix(vFix, brand, currency),
        } : null,
      }),
      build('orgSchema', {
        value: l2.orgSchema,
        basis: 'state',
        basisNote: 'Three graded outcomes: 2+ linked profiles = 100, present but thin = 40, absent = 0',
        result: raw.org && raw.org.present
          ? `Present, ${raw.org.sameAs} linked profile${raw.org.sameAs === 1 ? '' : 's'}${raw.org.emptySlots ? ` (plus ${raw.org.emptySlots} empty slot${raw.org.emptySlots === 1 ? '' : 's'} that count for nothing)` : ''}`
          : 'Absent',
        why: 'Built as specified. Roughly half of tested stores fail on the sameAs requirement.',
        evidence: {
          headline: raw.org && raw.org.present
            ? `Organization block found on the homepage with ${raw.org.sameAs} usable sameAs link${raw.org.sameAs === 1 ? '' : 's'}${raw.org.emptySlots ? `, and ${raw.org.emptySlots} empty slot${raw.org.emptySlots === 1 ? '' : 's'} the theme published blank` : ''}`
            : 'No Organization block on the homepage',
          items: (raw.orgSameAs || []).slice(0, 8).map((u) => ({ title: u, url: u, note: 'linked profile', pass: true })),
          total: (raw.orgSameAs || []).length,
          more: 0,
        },
        fix: l2.orgSchema < 100 ? {
          headline: `Organization markup for ${brand}`,
          where: 'Theme editor → theme.liquid, inside <head> on the homepage',
          steps: [
            raw.org && raw.org.present
              ? `The block exists but lists ${raw.org.sameAs} profile${raw.org.sameAs === 1 ? '' : 's'}. Two or more is what lets an agent confirm ${brand} is a real business.`
              : `${brand} has no Organization block, so agents can't tie this catalogue to a verified brand.`,
            'Use the profiles you actually run — Instagram, LinkedIn, Wikipedia, Amazon brand store.',
          ],
          snippet: orgFix(brand, raw.domain, raw.orgLogo, raw.orgSameAs || []),
        } : null,
      }),
      build('faqSchema', {
        value: l2.faqSchema,
        basis: l2.faqSchema === 50 ? 'baseline' : 'state',
        basisNote: l2.faqSchema === 50
          ? 'No FAQ content found anywhere. Scored 50 by choice — a store without an FAQ page is not committing a markup error, so it is neither credited nor punished.'
          : 'Graded outcomes: FAQ page 100, homepage 80, product pages 70, content but no markup 30',
        result: raw.faq && raw.faq.onFaqPage ? `On the FAQ page (${raw.faq.path})`
          : raw.faq && raw.faq.onHomepage ? 'On the homepage'
          : faqPdps.length ? `On ${faqPdps.length} product pages, not on the FAQ page`
          : raw.faq && raw.faq.faqPageExists ? `FAQ page exists (${raw.faq.path}) but carries no schema`
          : 'No FAQ content found',
        why: 'Widened. The spec looked at product and category pages; FAQ markup almost always lives on a dedicated FAQ page.',
        evidence: {
          headline: raw.faq && raw.faq.faqPageExists
            ? `FAQ page found at ${raw.faq.path}${raw.faq.onFaqPage ? ' with FAQPage schema' : ' with no FAQPage schema'}`
            : 'No FAQ page found at any of the four standard paths',
          ...cap(faqPdps),
        },
        fix: l2.faqSchema < 100 ? {
          headline: 'FAQPage markup' + (raw.faq && raw.faq.path ? ` for ${raw.faq.path}` : ''),
          where: raw.faq && raw.faq.path ? `Theme editor → page template for ${raw.faq.path}` : 'A new /pages/faq page',
          steps: [
            raw.faq && raw.faq.faqPageExists
              ? 'The answers are already written — they are just not machine-readable. This is markup around copy you have.'
              : 'There is no FAQ content to mark up yet. Write the delivery and returns answers first.',
            'Reuse your real question-and-answer text verbatim; inventing answers here would misrepresent the store.',
          ],
          snippet: faqFix(brand),
        } : null,
      }),
      build('llmsTxt', {
        value: raw.llmsTxt && raw.llmsTxt.exists ? 100 : 0,
        basis: 'state',
        basisNote: 'Measured and shown, excluded from the score. Its 10% is redistributed across the other five checks.',
        result: raw.llmsTxt && raw.llmsTxt.exists
          ? (raw.llmsTxt.shopifyGenerated ? 'Present — auto-generated by Shopify, not written by the brand' : 'Present, custom')
          : 'Absent',
        why: 'Dropped from scoring. Shopify auto-generates llms.txt for every store, pointing agents at shop.app. Returned 100 on all 15 stores tested.',
        evidence: {
          headline: raw.llmsTxt && raw.llmsTxt.exists
            ? `${raw.llmsTxt.bytes} bytes served at /llms.txt`
            : 'Nothing served at /llms.txt',
          items: [], total: 0, more: 0,
        },
        fix: null,
      }),
      build('reviewSchema', {
        value: l2.reviewSchema,
        basis: schemaRatingPct > 0 ? 'measured' : reviewAppPresent ? 'state' : 'baseline',
        basisNote: schemaRatingPct > 0
          ? `${live.length - reviewFails.length} of ${n} sampled products expose AggregateRating`
          : reviewAppPresent
            ? 'A review app is displaying ratings but none are machine-readable. Scored 25 — reviews exist, agents just cannot read them.'
            : 'No reviews found anywhere on the store. Scored 50 by choice — having no reviews yet is not a markup fault, so it is neither credited nor punished.',
        result: schemaRatingPct > 0 ? `${Math.round((schemaRatingPct / 100) * n)} of ${n} products expose AggregateRating`
          : reviewAppPresent ? `${reviewAppLabel} is running but exposes no schema` : 'No reviews found on the store',
        why: 'Three states instead of pass/fail. Review apps inject ratings via JavaScript, so a store with thousands of reviews scored 0 under the original check.',
        evidence: {
          headline: reviewAppPresent
            ? `Review widget detected: ${namedApps.join(', ') || 'unnamed, matched by its rendered review count'}`
            : 'No review app detected on the homepage or product pages',
          ...cap(reviewFails),
        },
        fix: l2.reviewSchema < 100 && rFix ? {
          headline: `AggregateRating for ${rFix.title}`,
          where: reviewAppPresent
            ? `${namedApps[0] || 'Your review app'} settings → enable rich snippets / SEO schema output`
            : 'Product template, once you have reviews to publish',
          steps: [
            reviewAppPresent
              ? `${namedApps[0] || 'The review widget'} renders ratings in JavaScript. Agents fetch the HTML once and never run it, so the ratings your customers see are invisible to them.`
              : 'Collect reviews first — this block must reflect real ratings.',
            'Most review apps have this as a single toggle; it does not need theme code.',
            'Never publish a rating you cannot substantiate.',
          ],
          snippet: reviewFix(rFix, currency),
        } : null,
      }),
    ];

    const order = LAYER2_SPEC.map((c) => c.key);
    checks.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));

    return {
      name: 'Structured Data / Schema',
      score: layers.layer2.score,
      specWeight: Math.round(WEIGHTS.layer2 * 100),
      effectiveWeight: Math.round(layerShare * 100),
      currency,
      sampleSize: n,
      note: `llms.txt is measured but not scored; its ${LAYER2_SPEC.find((c) => c.key === 'llmsTxt').specSub}% is redistributed across the five scored checks, which is why the effective weights differ from the spec column.`,
      checks,
    };
  })();

  // -Layer 3, check by check
  const layer3Report = (() => {
    const cap = (list) => ({ items: list.slice(0, 8), total: list.length, more: Math.max(0, list.length - 8) });
    const stack = raw.checkoutStack || [];
    const currency = live.map((p) => p.offerCurrency).find(Boolean) || raw.currency || 'INR';
    const payExample = live.find((p) => p.codInText) || live[0] || null;
    const shipExample = live.find((p) => p.pincodeWidget) || live[0] || null;
    const layerShare = WEIGHTS.layer3 / totalWeight;
    const wPct = (k) => Math.round(layer3Weight(k) * 1000) / 10;

    const build = (key, o) => {
      const meta = LAYER3_SPEC.find((c) => c.key === key);
      const w = meta.scored ? layer3Weight(key) : 0;
      return {
        key, spec: meta.label, label: meta.label, specSub: meta.specSub,
        effectiveSub: meta.scored ? wPct(key) : null, scored: meta.scored,
        value: o.value, basis: o.basis, basisNote: o.basisNote || '',
        result: o.result, why: o.why, added: false,
        pointsEarned: Math.round(o.value * w * 10) / 10,
        pointsLost: Math.round((100 - o.value) * w * 10) / 10,
        costOfTotal: Math.round((100 - o.value) * w * layerShare * 10) / 10,
        evidence: o.evidence || null,
        fix: o.fix || null,
      };
    };

    const checks = [
      build('ucpProfile', {
        value: l3.ucpProfile,
        basis: 'state',
        basisNote: `Read from /.well-known/ucp. Checkout capability declared at the profile's current version = 100; declared at an older version only = 40; absent or unreachable = 0.`,
        result: (raw.ucp || {}).ok
          ? `Declares dev.ucp.shopping.checkout at ${((raw.ucp || {}).checkoutVersions || []).join(', ') || 'no version'} · ${(raw.ucp || {}).capabilities.length} capabilities`
          : `No UCP profile served (${(raw.ucp || {}).status || 'no response'})`,
        why: 'Replaces the retired checkout-stack penalty. That check graded a store by how many checkout apps sat over native Shopify; fetching /.well-known/ucp on 13 stores spanning native checkout to four stacked apps returned an identical profile every time, so app count has no relationship to declared capability. Shopify serves this from its platform layer, beneath the storefront the apps modify. This confirms the endpoint DECLARES checkout capability — it does not simulate a live agent-initiated purchase, so app-specific friction during an actual transaction is untested.',
        evidence: {
          headline: (raw.ucp || {}).ok
            ? `UCP ${(raw.ucp || {}).version} with ${(raw.ucp || {}).capabilities.length} capabilities declared`
            : 'No parseable UCP profile at /.well-known/ucp',
          items: ((raw.ucp || {}).capabilities || []).map((c) => ({
            title: c.replace('dev.ucp.shopping.', '').replace('dev.shopify.', 'shopify:'),
            url: raw.domain + '/.well-known/ucp',
            note: c === 'dev.ucp.shopping.checkout' ? 'the scored capability' : 'declared',
            pass: true,
          })),
          total: ((raw.ucp || {}).capabilities || []).length, more: 0,
        },
        fix: l3.ucpProfile < 100 ? {
          headline: 'No current checkout capability declared',
          where: 'Shopify admin → Sales channels → Agentic',
          steps: [
            (raw.ucp || {}).ok
              ? 'The profile is served but does not declare checkout at its current version.'
              : 'Nothing parseable is served at /.well-known/ucp, which is unusual for a live Shopify store.',
            'Every one of the 13 stores tested returned a complete profile, so this is worth checking in the admin rather than treating as normal.',
          ],
          snippet: null,
        } : null,
      }),
      build('codPayment', {
        value: l3.codPayment,
        basis: 'state',
        basisNote: 'Binary, per the v2 spec: acceptedPaymentMethod declared on the Offer = 100, anything else = 0. Payment options rendered as page text earn no credit — they are shown below as context, not as partial marks.',
        result: paySchemaPct > 0
          ? `${Math.round((paySchemaPct / 100) * n)} of ${n} products declare acceptedPaymentMethod`
          : codPct > 0
            ? `No acceptedPaymentMethod anywhere — COD appears only as page text on ${cnt((p) => p.codInText)} of ${n} products`
            : 'No acceptedPaymentMethod, and no COD or prepaid signal in page text either',
        why: 'Not in the previous build. The spec asks for payment options structured rather than buried in JS widgets, so this separates a parseable field from prose a human reads.',
        evidence: {
          headline: codPct > 0
            ? `COD named in the page text of ${cnt((p) => p.codInText)} of ${n} products; acceptedPaymentMethod on 0`
            : `No COD signal on any of ${n} sampled products`,
          ...cap(live.filter((p) => p.codInText || p.prepaidInText).map((p) => ({
            title: p.title, url: p.url,
            note: [p.codInText && 'COD in text', p.prepaidInText && 'prepaid in text'].filter(Boolean).join(' · '),
          }))),
        },
        fix: l3.codPayment < 100 && payExample ? {
          headline: `Declare payment methods on the Offer for ${payExample.title}`,
          where: 'Theme editor → product template, in the existing Product JSON-LD Offer',
          steps: [
            'COD versus prepaid is the single biggest purchase-path question in Indian ecommerce, and right now it is invisible to agents.',
            'This goes inside the Offer you already publish — it is two extra fields, not a new block.',
            'List only the methods you genuinely accept.',
          ],
          snippet: ld({
            '@context': 'https://schema.org', '@type': 'Offer',
            url: payExample.url, price: payExample.price, priceCurrency: currency,
            availability: availUrl(payExample.available),
            acceptedPaymentMethod: [
              { '@type': 'PaymentMethod', name: 'Cash on Delivery' },
              { '@type': 'PaymentMethod', name: 'UPI' },
              { '@type': 'PaymentMethod', name: 'Credit Card' },
            ],
          }),
        } : null,
      }),
      build('serviceability', {
        value: l3.serviceability,
        basis: 'state',
        basisNote: 'Binary, per the v2 spec: OfferShippingDetails in the product JSON-LD = 100, anything else = 0. A pincode widget is a JavaScript call to a private API an agent cannot make, so it is reported below as context rather than scored.',
        result: shipSchemaPct > 0
          ? `${Math.round((shipSchemaPct / 100) * n)} of ${n} products publish OfferShippingDetails`
          : pincodePct > 0
            ? `No OfferShippingDetails — a JS-only pincode checker runs on ${cnt((p) => p.pincodeWidget)} of ${n} pages`
            : 'No OfferShippingDetails and no pincode checker found',
        why: 'Not in the previous build. The old shipping check measured the policy page\'s text length, which is a different question from pincode-level serviceability. That measurement is kept below as an extra, unscored.',
        evidence: {
          headline: pincodePct > 0
            ? `Pincode or delivery-estimate widget found on ${cnt((p) => p.pincodeWidget)} of ${n} product pages`
            : 'No pincode or delivery-estimate widget found on any sampled product page',
          ...cap(live.filter((p) => p.pincodeWidget).map((p) => ({
            title: p.title, url: p.url, note: 'pincode checker, JS-only',
          }))),
        },
        fix: l3.serviceability < 100 && shipExample ? {
          headline: `Publish delivery windows as shippingDetails for ${shipExample.title}`,
          where: 'Theme editor → product template, in the existing Product JSON-LD Offer',
          steps: [
            'The pincode widget already knows your delivery windows — this exposes the same answer in a field an agent can read.',
            'Agents asked "can you deliver to Pune by Friday" currently have nothing to work from.',
            'Publish your real handling and transit times; a wrong promise here is worse than none.',
          ],
          snippet: ld({
            '@context': 'https://schema.org', '@type': 'Offer',
            url: shipExample.url,
            shippingDetails: {
              '@type': 'OfferShippingDetails',
              shippingDestination: { '@type': 'DefinedRegion', addressCountry: 'IN' },
              deliveryTime: {
                '@type': 'ShippingDeliveryTime',
                handlingTime: { '@type': 'QuantitativeValue', minValue: 1, maxValue: 2, unitCode: 'DAY' },
                transitTime: { '@type': 'QuantitativeValue', minValue: 2, maxValue: 6, unitCode: 'DAY' },
              },
            },
          }),
        } : null,
      }),
      build('returnPolicy', {
        value: l3.returnPolicy,
        basis: 'state',
        basisNote: returnSchema
          ? `Return markup found on ${returnSchemaWhere}. Full terms with a stated window = 100; typed schema without a window = 70; a bare link to the policy page = 55.`
          : 'No return markup anywhere. Prose caps at 40 however long the page is — an agent cannot parse a policy page, so length is not machine-readability. Over 1200 characters = 40, over 400 = 30, any text = 20, missing = 0.',
        result: returnSchema
          ? returnSchema.linkOnly
            ? `Only a link to the policy page — hasMerchantReturnPolicy on ${returnSchemaWhere} carries no window, fees or method`
            : [`MerchantReturnPolicy on ${returnSchemaWhere}`,
               returnSchema.days != null ? `${returnSchema.days}-day window` : 'no return window stated',
               returnSchema.fees ? returnSchema.fees.replace(/([A-Z])/g, ' $1').trim().toLowerCase() : null,
               returnSchema.country ? `for ${returnSchema.country}` : null].filter(Boolean).join(' · ')
          : (raw.policyReturn || {}).len
            ? `Prose only — ${(raw.policyReturn || {}).len} characters at ${(raw.policyReturn || {}).path}, no schema`
            : 'No return policy page found at any standard path',
        // no `why` — this check matches the spec, so there is nothing to explain.
        // An empty why hides the "Against the spec" block entirely.
        why: '',
        evidence: {
          headline: returnSchema
            ? returnSchema.linkOnly
              ? `A machine-readable pointer to the policy exists on ${returnSchemaWhere}, but no actual terms`
              : `Structured return terms published on ${returnSchemaWhere}`
            : (raw.policyReturn || {}).len
              ? `Return policy page found at ${(raw.policyReturn || {}).path}, but it carries no MerchantReturnPolicy`
              : 'No return policy page at any of the four standard paths',
          items: returnSchema
            ? [['Return window', returnSchema.days != null ? `${returnSchema.days} days` : 'not stated'],
               ['Category', returnSchema.category || 'not stated'],
               ['Fees', returnSchema.fees || 'not stated'],
               ['Method', returnSchema.method || 'not stated'],
               ['Applies to', returnSchema.country || 'not stated']]
              .map(([k, v]) => ({ title: k, url: (raw.policyReturn || {}).path ? raw.domain + raw.policyReturn.path : raw.domain, note: v, pass: v !== 'not stated' }))
            : [],
          total: returnSchema ? 5 : 0, more: 0,
        },
        fix: l3.returnPolicy < 100 ? {
          headline: returnSchema
            ? returnSchema.linkOnly
              ? 'Replace the bare policy link with the actual terms'
              : 'Add a return window to the policy you already publish'
            : 'Publish return terms as MerchantReturnPolicy',
          where: 'Theme editor → product template, inside the Offer, or on the return policy page template',
          steps: [
            returnSchema
              ? returnSchema.linkOnly
                ? 'hasMerchantReturnPolicy currently holds only a URL. An agent following it lands on a prose page it still cannot parse, so the pointer buys nothing.'
                : 'The schema is there but states no return window, which is the one field an agent needs most.'
              : `The policy is written${(raw.policyReturn || {}).len ? ` — ${(raw.policyReturn || {}).len} characters at ${raw.policyReturn.path}` : ''}, it just isn't machine-readable.`,
            'An agent asked "can I return this, by when, at what cost" reads these five fields. Prose gives it nothing.',
            'Use your real window and fees — this markup is a promise to the customer.',
          ],
          snippet: ld({
            '@context': 'https://schema.org',
            '@type': 'MerchantReturnPolicy',
            applicableCountry: 'IN',
            returnPolicyCategory: 'https://schema.org/MerchantReturnFiniteReturnWindow',
            merchantReturnDays: returnSchema && returnSchema.days != null ? returnSchema.days : 7,
            returnMethod: 'https://schema.org/ReturnByMail',
            returnFees: 'https://schema.org/FreeReturn',
            returnPolicyURL: (raw.policyReturn || {}).path ? raw.domain + raw.policyReturn.path : `${raw.domain}/policies/refund-policy`,
          }),
        } : null,
      }),
      build('agenticEligibility', {
        value: raw.planName ? 100 : 0,
        basis: 'state',
        basisNote: 'Measured and shown, never scored. A plan name in the HTML confirms the tier; its absence proves nothing, so scoring it would punish stores for our blind spot. Its 15% is redistributed across the four scored checks.',
        result: raw.planName
          ? `Confirmed: ${raw.planName}`
          : 'Plan tier not exposed in public HTML — cannot be determined without admin access',
        why: 'The spec marks this as a manual check. Partly automatable: 3 of 10 stores tested leak planName into the homepage HTML. The rest genuinely need a human with admin access.',
        evidence: {
          headline: raw.planName
            ? `planName found in homepage HTML: ${raw.planName}`
            : `No planName in the homepage HTML${raw.myshopifyDomain ? ` (store identified as ${raw.myshopifyDomain})` : ''}`,
          items: [], total: 0, more: 0,
        },
        fix: null,
      }),
    ];

    const order = LAYER3_SPEC.map((c) => c.key);
    const shown = checks.filter((c) => L3_SHOWN.some((s) => s.key === c.key));
    shown.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));

    return {
      name: 'India Checkout & UCP Compatibility',
      score: layers.layer3.score,
      specWeight: Math.round(WEIGHTS.layer3 * 100),
      effectiveWeight: Math.round(layerShare * 100),
      sampleSize: n,
      currency,
      note: `Rebuilt to the v2 spec. The checkout-stack penalty is retired — ${stack.length ? `this store runs ${stack.join(' + ')}, shown for context only and not scored` : 'no third-party checkout detected'}. Return/exchange policy and Agentic Storefronts eligibility are held back for the next review, so the spec's 35/20/15 renormalise across the three checks below.`,
      checks: shown,
    };
  })();

  // ------------------------------------------------ Layer 4, check by check
  const layer4Report = (() => {
    const cap = (list) => ({ items: list.slice(0, 8), total: list.length, more: Math.max(0, list.length - 8) });
    const layerShare = WEIGHTS.layer4 / totalWeight;
    const wPct = (k) => Math.round(layer4Weight(k) * 1000) / 10;
    const allForms = [...new Set(live.flatMap((p) => p.brandForms || []))];
    const noBrand = live.filter((p) => !(p.brandForms || []).length);

    const build = (key, o) => {
      const meta = LAYER4_SPEC.find((c) => c.key === key);
      const w = meta.scored ? layer4Weight(key) : 0;
      return {
        key, spec: meta.label, label: meta.label, specSub: meta.specSub,
        effectiveSub: meta.scored ? wPct(key) : null, scored: meta.scored, added: !!meta.added,
        value: o.value, basis: o.basis, basisNote: o.basisNote || '',
        result: o.result, why: o.why || '',
        pointsEarned: Math.round(o.value * w * 10) / 10,
        pointsLost: Math.round((100 - o.value) * w * 10) / 10,
        costOfTotal: Math.round((100 - o.value) * w * layerShare * 10) / 10,
        evidence: o.evidence || null,
        fix: o.fix || null,
      };
    };

    // per-probe miss counts, used by both the result line and the evidence list
    const probeMisses = ANSWER_PROBES.map(([label], i) =>
      [label, live.filter((p) => !answerFacts(p)[i][1]).length]);
    const worstProbe = probeMisses.slice().sort((a, b) => b[1] - a[1])[0] || ['', 0];

    const checks = [
      build('answerFirst', {
        value: l4.answerFirst,
        basis: 'measured',
        basisNote: `Each sampled description is checked for four facts an agent needs — material or composition, primary use case, size or dimension guidance, and one specific factual attribute. A product scores 25 per fact it covers, and the check is the average across ${n} products. ${
          llmUsed
            ? `Graded by ${(raw.llm || {}).model}, which reads the text and judges whether each fact is actually stated — vague copy like "premium materials" is marked as not covering material.`
            : `Graded by keyword detection${(raw.llm || {}).error ? ` (${raw.llm.error})` : ''}, which errs in both directions: "premium materials" counts as covering material when a reader would not, and a use case phrased outside the matched vocabulary is missed. Treat it as an indicator, not a verdict.`
        }`,
        result: `Descriptions cover ${(l4.answerFirst / 25).toFixed(1)} of the 4 facts on average · ${worstProbe[1]} of ${n} never mention ${worstProbe[0]}`,
        why: llmUsed
          ? `Built to the v2 spec structure. The spec names Claude Haiku; this runs on ${(raw.llm || {}).model} via the free Gemini tier, one request per scan with all descriptions batched. Verdicts are cached by description hash and graded at temperature 0, so unchanged copy always scores the same.`
          : 'Built to the v2 spec structure, computed without the LLM call it specifies. Same four questions, keyword detection, so a scan needs no API key and costs nothing. Set GEMINI_API_KEY to grade these with a model instead.',
        evidence: {
          headline: probeMisses.every(([, c]) => c === 0)
            ? `All ${n} sampled descriptions cover all four facts`
            : `Facts missing across the ${n} sampled descriptions`,
          items: probeMisses.map(([label, c]) => ({
            title: label, url: raw.domain, note: c === 0 ? `covered on all ${n}` : `missing on ${c} of ${n}`, pass: c === 0,
          })),
          total: 4, more: 0,
        },
        fix: l4.answerFirst < 100 ? {
          headline: 'Lead with the facts, then the story',
          where: 'Product descriptions — Shopify admin → Products, or your PIM',
          steps: [
            `${worstProbe[1]} of ${n} sampled descriptions never mention ${worstProbe[0]}.`,
            'Agents answer shopper questions by quoting your copy. A description that opens with brand storytelling gives them nothing to quote.',
            'Put material, size and use case in the first two sentences; keep the storytelling after.',
          ],
          snippet: null,
        } : null,
      }),
      build('factualDensity', {
        value: l4.factualDensity,
        basis: 'measured',
        basisNote: 'Per product: 20 points for each concrete measurement in the description (ml, g, cm, %, and similar) capped at 100, plus 30 for naming a spec term such as material, ingredients, dimensions or warranty. Averaged across the sample.',
        result: `${(live.reduce((a, p) => a + p.unitMentions, 0) / Math.max(1, n)).toFixed(1)} measurements per description on average · ${live.filter((p) => !p.hasSpecWord).length} of ${n} never name a spec term`,
        why: '',
        evidence: {
          headline: `Products with the least concrete detail`,
          ...cap(live.slice().sort((a, b) => (a.unitMentions + (a.hasSpecWord ? 3 : 0)) - (b.unitMentions + (b.hasSpecWord ? 3 : 0)))
            .filter((p) => p.unitMentions === 0 || !p.hasSpecWord)
            .map((p) => ({
              title: p.title, url: p.url,
              note: `${p.unitMentions} measurement${p.unitMentions === 1 ? '' : 's'}${p.hasSpecWord ? '' : ', no spec term'}`,
            }))),
        },
        fix: l4.factualDensity < 100 ? {
          headline: 'Add measurable attributes to thin descriptions',
          where: 'Product descriptions — Shopify admin → Products',
          steps: [
            `Sampled descriptions average ${(live.reduce((a, p) => a + p.unitMentions, 0) / Math.max(1, n)).toFixed(1)} concrete measurements.`,
            'Vague marketing copy ranks below a competitor that states grams, millilitres or dimensions.',
            'One line of specifications per product moves this more than rewriting the prose.',
          ],
          snippet: null,
        } : null,
      }),
      build('entityConsistency', {
        value: l4.entityConsistency,
        basis: 'state',
        basisNote: `One rendered form of the brand name across all sampled pages = 100; several forms that match once case and spacing are normalised = 70; the name missing from some pages entirely = 40. Matching is anchored on "${raw.brandName}".`,
        result: noBrand.length
          ? `The brand name is absent from ${noBrand.length} of ${n} sampled product pages`
          : allForms.length <= 1
            ? `One consistent form across all ${n} pages: "${allForms[0] || raw.brandName}"`
            : `${allForms.length} written forms in use: ${allForms.slice(0, 4).map((f) => `"${f}"`).join(', ')}${allForms.length > 4 ? '…' : ''}`,
        why: 'Returned 70 on every store tested so far — most brands render their name in more than one form but identically once case and spacing are normalised. Worth the same scrutiny as the other non-differentiating checks before its 30% weight is locked.',
        evidence: {
          headline: noBrand.length
            ? `${noBrand.length} sampled pages carry no recognisable form of the brand name`
            : `Distinct rendered forms of "${raw.brandName}" across ${n} sampled pages`,
          items: noBrand.length
            ? noBrand.slice(0, 8).map((p) => ({ title: p.title, url: p.url, note: 'brand name not found' }))
            : allForms.slice(0, 8).map((f) => ({ title: `"${f}"`, url: raw.domain, note: 'in use', pass: allForms.length <= 1 })),
          total: noBrand.length || allForms.length, more: 0,
        },
        fix: l4.entityConsistency < 100 ? {
          headline: 'Settle on one written form of the brand name',
          where: 'Product titles, descriptions and theme copy',
          steps: [
            allForms.length > 1
              ? `This store renders the name as ${allForms.slice(0, 3).map((f) => `"${f}"`).join(', ')}.`
              : `The name is missing entirely from ${noBrand.length} sampled pages.`,
            'Agents match a catalogue to a brand entity by name. Aliasing makes that link weaker than it should be.',
            'Pick the form used in your Organization schema and use it everywhere.',
          ],
          snippet: null,
        } : null,
      }),
      build('descriptionDepth', {
        value: l4.descriptionDepth,
        basis: 'measured',
        basisNote: 'Not in the spec. Graded per product on word count: 200+ words = 100, 120+ = 90, 60+ = 70, 25+ = 40, under 25 = 15, none = 0. Shown because it explains most of what the scored checks report.',
        result: `${live.filter((p) => p.descWords === 0).length} of ${n} products have no description at all · ${live.filter((p) => p.descWords > 0 && p.descWords < 60).length} have fewer than 60 words`,
        why: '',
        evidence: {
          headline: 'Shortest descriptions in the sample',
          ...cap(live.slice().sort((a, b) => a.descWords - b.descWords).filter((p) => p.descWords < 60)
            .map((p) => ({ title: p.title, url: p.url, note: p.descWords === 0 ? 'no description' : `${p.descWords} words` }))),
        },
        fix: l4.descriptionDepth < 100 ? {"headline": "Complete short or missing descriptions", "where": "Shopify admin → Products → Description", "steps": ["Start with the products listed in the evidence. Explain what each product is, who it is for, and its verified materials, dimensions, contents and usage instructions.", "Write useful product-specific copy without padding the word count. Publish the changes and rescan. This check is informational and does not change the weighted score."], "snippet": null} : null,
      }),
      build('uniqueness', {
        value: l4.uniqueness,
        basis: 'measured',
        basisNote: 'Not in the spec. The share of sampled products whose opening 200 characters are not reused by another product.',
        result: `${n - uniqueDesc} of ${n} sampled products reuse another product's description`,
        why: '',
        evidence: {
          headline: n - uniqueDesc > 0
            ? `${n - uniqueDesc} products share copy with another product`
            : `All ${n} sampled descriptions are distinct`,
          items: [], total: 0, more: 0,
        },
        fix: l4.uniqueness < 100 ? {"headline": "Make each product description distinct", "where": "Shopify admin → Products → Description", "steps": ["Replace repeated introductions with verified facts specific to each product. Keep shared policy text separate from product descriptions.", "Check the opening paragraphs across similar products, publish the changes and rescan. Do not invent product differences."], "snippet": null} : null,
      }),
      build('imageCoverage', {
        value: l4.imageCoverage,
        basis: 'measured',
        basisNote: 'Not in the spec. Graded per product on image count: 7+ = 100, 5-6 = 90, 3-4 = 70, 2 = 45, 1 = 20, none = 0.',
        result: `${live.filter((p) => p.imageCount <= 1).length} of ${n} products have one image or none`,
        why: '',
        evidence: {
          headline: 'Products with the fewest images',
          ...cap(live.slice().sort((a, b) => a.imageCount - b.imageCount).filter((p) => p.imageCount <= 2)
            .map((p) => ({ title: p.title, url: p.url, note: `${p.imageCount} image${p.imageCount === 1 ? '' : 's'}` }))),
        },
        fix: l4.imageCoverage < 100 ? {"headline": "Add useful product images", "where": "Shopify admin → Products → Select product → Media", "steps": ["Start with the products listed in the evidence. Add a clear main image, alternate angles, close-up details and a scale or in-use view where relevant. Use genuine product images and match variant images to the right variants.", "Add concise alternative text describing each image. Confirm that images load on the public product page, then rescan. Image count is informational and does not change the weighted score."], "snippet": null} : null,
      }),
    ];

    const order = LAYER4_SPEC.map((c) => c.key);
    const shown = checks.filter((c) => L4_SHOWN.some((s) => s.key === c.key));
    shown.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));

    return {
      name: 'Content Clarity',
      score: layers.layer4.score,
      specWeight: Math.round(WEIGHTS.layer4 * 100),
      effectiveWeight: Math.round(layerShare * 100),
      sampleSize: n,
      currency: live.map((p) => p.offerCurrency).find(Boolean) || raw.currency || 'INR',
      note: `${llmUsed ? `Answer-first is graded by ${(raw.llm || {}).model}; factual density and entity naming stay deterministic, because counting and string matching do not need a model.` : `The spec computes the first two checks with an LLM call; they are measured here by keyword detection instead, so a scan needs no API key and costs nothing.`} Description length, uniqueness and image coverage are not in the spec — they are measured and shown, never scored.`,
      checks: shown,
    };
  })();

  const specDetail = {
    layer1: {
      name: 'Crawler & Technical Access',
      specWeight: 20,
      checks: [
        { spec: 'robots.txt allows AI crawlers', specSub: 30, scored: false,
          result: raw.robots && raw.robots.blocked.length === 0
            ? `All ${AI_BOTS.length} AI crawlers allowed` : `Blocked: ${(raw.robots || {}).blocked.join(', ')}`,
          value: l1.robots,
          why: 'Shopify never disallows AI crawlers by default. Returned 100 on all 15 stores tested.' },
        { spec: 'JS-independent content render', specSub: 35, scored: false,
          result: `${renderPct}% of title/price/stock visible without JavaScript`,
          value: renderPct,
          why: 'Shopify renders server-side in Liquid, so this returned 100 on all 15 stores tested.' },
        { spec: 'Page load speed', specSub: 15, scored: true,
          result: hasProducts ? `${Math.round(median(live.map((p) => p.htmlBytes)) / 1024)}KB, ${median(live.map((p) => p.ttfb || 0))}ms to first byte` : 'no pages loaded',
          value: l1.pageWeight,
          why: 'Measured as response time and payload size rather than PageSpeed Insights — no API key, no 30s wait per scan.' },
        { spec: 'Sitemap present & current', specSub: 20, scored: false,
          result: raw.sitemapOk ? `Present, ${raw.sitemapProductCount || 0} product URLs` : 'Missing',
          value: raw.sitemapOk ? 100 : 0,
          why: 'Shopify auto-generates sitemap.xml for every store. Returned 100 on all 15 stores tested.' },
        { spec: 'AI crawler access by user-agent', specSub: null, scored: true, added: true,
          result: Object.entries(botVerdicts).map(([b, v]) => `${b}: ${v}`).join(' · '),
          value: l1.botWall,
          why: 'Not in the spec. Fetches the store as each crawler and compares — catches edge blocking that robots.txt cannot show.' },
        { spec: 'Product feed & indexability', specSub: null, scored: true, added: true,
          result: `products.json ${raw.catalogOpen ? 'open' : 'closed'} · ${pctOf(live, (p) => p.noindex)}% noindex · ${staticPct((p) => !p.hasCanonical)}% no canonical`,
          value: Math.round((l1.endpoints + l1.indexability) / 2),
          why: 'Not in the spec. Whether agents can enumerate and index the catalogue at all.' },
      ],
    },
    // One source of truth. The overview row and the deep Layer 2 section are the
    // same objects, so they cannot drift — the previous version duplicated these
    // strings and the FAQ row printed "carries no schema" on stores scoring 70
    // because their FAQ markup was on the product pages.
    layer2: {
      name: layer2Report.name,
      specWeight: layer2Report.specWeight,
      checks: layer2Report.checks,
    },
    layer3: {
      name: layer3Report.name,
      specWeight: layer3Report.specWeight,
      checks: layer3Report.checks,
    },
    layer4: {
      name: layer4Report.name,
      specWeight: layer4Report.specWeight,
      checks: layer4Report.checks,
    },
  };

  // ------------------------------------------------- "what an agent sees"
  // Fields an agent can read show the real value. Fields it can't show what
  // needs to go there. We never invent a value the store doesn't have.
  const worst = live.slice().sort((a, b) => (a.descWords + a.imageCount * 20) - (b.descWords + b.imageCount * 20))[0];
  const agentView = worst ? {
    title: worst.title,
    url: worst.url,
    catalogNote: `Weakest of ${n} sampled products`,
    fields: [
      { label: 'Name', value: worst.title, visible: true },
      { label: 'Price', value: worst.price ? `\u20b9${worst.price}` : null, visible: worst.schema.price,
        action: 'Expose price in the product schema' },
      { label: 'In stock', value: worst.available ? 'Yes' : 'No', visible: worst.schema.availability,
        action: 'Add availability to the offer' },
      { label: 'SKU', value: worst.schema.sku ? 'Present' : null, visible: worst.schema.sku,
        action: 'Publish the SKU field' },
      { label: 'Rating', value: worst.schema.ratingCount ? `${worst.schema.ratingCount} reviews` : null,
        visible: worst.schema.rating,
        action: reviewAppPresent
          ? `Expose ratings from ${namedApps[0] || 'your review app'} as structured data`
          : 'Collect reviews and expose them as structured data' },
      { label: 'Options', value: worst.optionNames.join(', ') || 'Single variant',
        visible: worst.variantCount <= 1 || worst.schema.variantLevelOffers,
        action: 'Expose each variant as its own offer' },
      { label: 'Images', value: `${worst.imageCount}`, visible: worst.imageCount >= 3,
        action: `Add images \u2014 ${worst.imageCount} today, 5 or more works better` },
      { label: 'Description', value: worst.descSnippet || null, visible: worst.descWords >= 25,
        action: `Write 60+ words covering material, size and use case \u2014 ${worst.descWords} today` },
    ],
  } : null;
  if (agentView) {
    agentView.gapCount = agentView.fields.filter((f) => !f.visible).length;
  }

  return {
    version: VERSION,
    domain: raw.domain,
    brandName: raw.brandName,
    scannedAt: raw.scannedAt,
    catalogCount: raw.catalogCount,
    sampled: live.length,
    sampleAttempted: (raw.products || []).length,
    homeStatus: raw.homeStatus,
    checkoutStack: raw.checkoutStack || [],
    botVerdicts,
    behindCloudflare: !!raw.behindCloudflare,
    errors: raw.errors,
    layers,
    skipped: SKIPPED_LAYERS,
    finalScore: final,
    grade: grade.label,
    gradeNote: grade.note,
    gaps,
    specDetail,
    speed,
    llm: raw.llm
      ? { used: !!raw.llm.used, model: raw.llm.model, graded: raw.llm.graded, cached: raw.llm.cached, error: raw.llm.error }
      : null,
    layer2Report,
    layer3Report,
    layer4Report,
    agentView,
  };
}

export async function scanStore(domain, onProgress, options = {}) {
  const raw = await collect(domain, onProgress, options);
  if (raw.errors.length && !raw.products) {
    return { domain: raw.domain, errors: raw.errors, finalScore: null, grade: null };
  }
  if (onProgress) onProgress('Scoring');
  return score(raw);
}

// ========================================================================= CLI

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const target = process.argv[2];
  if (!target) { console.error('Usage: node engine.js https://store.com'); process.exit(1); }
  const r = await scanStore(target, (m) => process.stderr.write(`  ${m}...\n`));
  if (process.argv.includes('--json')) { console.log(JSON.stringify(r, null, 2)); }
  else {
    if (r.errors && r.errors.length && r.finalScore === null) { console.log(`\n${r.domain}: ${r.errors.join(', ')}`); process.exit(0); }
    console.log(`\n${r.brandName} — ${r.domain}`);
    console.log(`${r.finalScore}/100   ${r.grade}`);
    console.log(`${r.gradeNote}\n`);
    for (const [, l] of Object.entries(r.layers)) {
      console.log(`  ${String(l.score).padStart(3)}  ${l.name.padEnd(30)} ${'█'.repeat(Math.round(l.score / 5))}`);
    }
    console.log('\n  Top gaps:');
    r.gaps.forEach((g, i) => console.log(`   ${i + 1}. ${g.message}`));
    console.log(`\n  Checkout: ${r.checkoutStack.length ? r.checkoutStack.join(' + ') : 'native Shopify'}`);
  }
}
