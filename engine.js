#!/usr/bin/env node
/**
 * engine.js, AI Agent Readiness: scan + score
 *
 * Consolidates probe2/3/4 into one pipeline that produces a final 0-100 score,
 * a grade, per-layer scores, top-3 gaps, and the "what an agent sees" card.
 *
 * CLI:   node engine.js https://superyou.in
 * API:   import { scanStore } from './engine.js'
 *
 * Node 18+. No dependencies.
 */

import {createHash} from 'node:crypto';
import {publicFetch} from './public-fetch.js';

// ============================================================== SCORING CONFIG
// Everything tunable lives here. Change a number, rerun, done.

export const VERSION = '2.4-agentnew';   // Comparable scan metadata for Layer 5

export const WEIGHTS = {
  layer1: 0.20,   // Crawler & technical access
  layer2: 0.25,   // Structured data
  layer3: 0.25,   // Checkout & UCP compatibility
  layer4: 0.15,   // Content clarity
  layer5: 0.15,   // Competitive position, computed separately in competitive.js
};

export const SKIPPED_LAYERS = ['layer5'];

/**
 * Layer 2 sub-checks exactly as the spec lists them. `specSub` is the spec's own
 * weight. `scored:false` means the check is measured and shown but kept out of
 * the score; its weight is redistributed across the scored checks in proportion.
 *
 * The scoring weights are DERIVED from this table, never typed separately. An
 * earlier version hand-wrote them and drifted from the spec, variant data was
 * scored at 15% against a spec weight of 20%, review at 15% against 10%, so the
 * screen printed spec weights it wasn't actually using. Change specSub here and
 * both the score and the screen move together.
 */
export const LAYER2_SPEC = [
  { key: 'productSchema', specSub: 35, scored: true,  label: 'Product schema (JSON-LD) coverage' },
  { key: 'variantSchema', specSub: 20, scored: true,  label: 'Variant data structured' },
  { key: 'orgSchema',     specSub: 15, scored: true,  label: 'Organization/entity schema' },
  { key: 'faqSchema',     specSub: 10, scored: true,  label: 'FAQ/HowTo schema' },
  { key: 'agentMd', specSub: null, scored: false, label: 'agents.md present' },
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
 * unscored, Shopify plan tier is only exposed in public HTML by some stores
 * (3 of 10 tested), so it can confirm Plus but can never establish that a store
 * is NOT Plus. Scoring a check that can only ever return "yes" or "unknown"
 * would punish stores for our blind spot.
 *
 * Note on shipping: the spec's check is pincode-level serviceability, and that
 * is what `serviceability` now measures. The older `shippingPolicy` check
 * measured the policy page's text length, useful, but a different question, * so it is kept as a measured extra rather than scored in the spec's slot.
 */
/**
 * `hidden: true` holds a check back from the report entirely, neither shown
 * nor scored, with the remaining weights renormalising over what is left.
 * Nothing is hidden right now; all five checks are live.
 *
 * If you do hide one, hide it from scoring too. Hiding a check while still
 * scoring it leaves the visible weights adding to less than 100% of the layer
 * with the remainder unexplained, the exact kind of silent weight this report
 * exists to expose.
 */
export const LAYER3_SPEC = [
  { key: 'ucpProfile',         specSub: 35, scored: true,  label: 'UCP checkout capability declared' },
  { key: 'codPayment',         specSub: 20, scored: true,  label: 'Accepted payment methods exposed cleanly' },
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
 * doesn't name. Those carry `added: true` and are never scored, they are shown
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
  // v2 spec: robots, JS render and sitemap demoted to measured-but-not-scored, // all three returned 100 on every Shopify store tested. Weights below are the
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
  { min: 80, label: 'Strong checklist coverage', note: 'Most public storefront checks passed. Actual AI recommendations and purchases were not tested.' },
  { min: 60, label: 'Partial checklist coverage', note: 'Some public storefront checks passed; review the measured gaps.' },
  { min: 40, label: 'Limited checklist coverage', note: 'Several measured public storefront checks need review.' },
  { min: 0,  label: 'Low checklist coverage', note: 'Few public storefront checks passed. This does not establish invisibility to AI channels.' },
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

// Anchored to the asset a live integration must actually load. Bare brand names
// also appear in theme config that switches the app OFF -- cleolifestyle.com
// carried "enable_shopflo_checkout":false and twobrothersfood.com carried
// goKwik:false, and both were reported as the store's checkout.
const CHECKOUT_STACKS = [
  { key: 'GoKwik',        re: /gokwik\.co|kwikpass\.[a-z]{2,}|pdp-widget\.gokwik/i },
  { key: 'Shopflo',       re: /shopflo\.(?:com|in)\b/i },
  { key: 'RazorpayMagic', re: /magic-?checkout\.razorpay|checkout\.razorpay\.com/i },
  { key: 'Simpl',         re: /getsimpl\.com|simpl\.js/i },
  { key: 'Snapmint',      re: /snapmint\.com/i },
  { key: 'Fastrr',        re: /fastrr\.(?:com|in)|pickrr\.com/i },
  { key: 'Shiprocket',    re: /shiprocket\.(?:in|com)/i },
];

// A config key that names an app while disabling it is not an installation.
const DISABLED_FLAG = /["']?[\w.$-]*(gokwik|shopflo|simpl|snapmint|fastrr|pickrr|shiprocket|magic-?checkout)[\w.$-]*["']?\s*[:=]\s*(false|0|"false"|'false'|null)/gi;
const withoutDisabledFlags = html => String(html || '').replace(DISABLED_FLAG, '');

// Anchored like the checkout stacks: a brand name in prose, a blog link or a
// disabled config flag is not an installed app, and the detected name is quoted
// back to the merchant in their recommendations.
const REVIEW_APPS = [
  { key: 'Judge.me',        re: /judge\.me\b|judgeme\.(?:com|net)|jdgm-|cdn\.judge\.me/i },
  { key: 'Yotpo',           re: /yotpo\.com|staticw2\.yotpo/i },
  { key: 'Loox',            re: /loox\.io/i },
  { key: 'Stamped',         re: /stamped\.io/i },
  { key: 'Okendo',          re: /okendo\.io|okeReviews/i },
  { key: 'Ryviu',           re: /ryviu\.(?:com|io)/i },
  { key: 'Junip',           re: /junip\.co/i },
  { key: 'Fera',            re: /fera\.ai|feraapp/i },
  { key: 'Growave',         re: /growave\.io/i },
  { key: 'Reviews.io',      re: /reviews\.io|reviewsio/i },
  { key: 'Opinew',          re: /opinew\.com/i },
  { key: 'Rivyo',           re: /rivyo\.(?:com|io)|thimatic/i },
  { key: 'Shopper Approved',re: /shopperapproved\.com/i },
  { key: 'Trustpilot',      re: /trustpilot\.com/i },
  { key: 'Vitals',          re: /vitals\.co|appvitals/i },
];

/**
 * Generic backstop for review widgets we don't have a name for. The named list
 * above will always lag the app store, and a miss is expensive: without this,
 * a store running an unlisted app falls through to the "no reviews anywhere"
 * baseline of 50 and gets CREDITED for having no reviews, when it in fact has
 * reviews its customers can see and agents can't, which scores 25.
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
 * regexes in ANSWER_PROBES and nothing else changes, the free tier keeps its
 * "no dependencies, no API keys" promise. The report always states which path
 * produced the number, because the two do not agree and pretending otherwise
 * would make scores incomparable.
 *
 * One request per scan: all sampled descriptions go in a single call, so the
 * free tier's per-minute request limit is never the bottleneck. Verdicts are
 * cached by description hash, so re-scanning a store whose copy hasn't changed
 * returns the same score, an LLM in the scoring path would otherwise make
 * results non-reproducible, which the deterministic sampling exists to avoid.
 */
const GEMINI_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
// gemini-2.5-flash-lite is retired for new keys, the API returns a 404 naming
// 3.5 as the replacement. Override with GEMINI_MODEL when this one retires too.
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
const GEMINI_URL = (m) => `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`;
const llmCache = new Map();

const ANSWER_FIELDS = ['material', 'useCase', 'size', 'attribute'];

const GRADER_PROMPT = `You are auditing e-commerce product descriptions for an AI shopping agent.

For each numbered description, decide whether the TEXT ITSELF states each fact.
Answer true only if a shopper could learn that fact from this text alone.
Vague marketing language ("premium materials", "high quality", "carefully crafted")
is NOT a statement of fact, answer false for it.

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
        ? `Gemini rate limit hit (free tier): ${detail}`
        : `Gemini returned ${res.status}: ${detail}`;
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
    out.error = `Gemini request failed: ${String(e.name === 'AbortError' ? 'timed out after 30s' : e.message)}`;
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
 * which needs an API key and ~30s per URL, 10 minutes added to every scan. TTFB
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
 * Tags out, text left. Script and style CONTENTS must go first, removing only
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
 * by when, at what cost". It sits in different places depending on the theme, * on the Product's offer, on the Organization, on an OnlineStore block, or on
 * its own, so this walks the whole graph rather than guessing a path.
 */
function findReturnPolicy(blocks) {
  const found = new Set();
  const walk = (v, depth) => {
    if (!v || typeof v !== 'object' || depth > 6) return;
    if (Array.isArray(v)) return v.forEach((x) => walk(x, depth + 1));
    if ([].concat(v['@type'] || []).includes('MerchantReturnPolicy')) found.add(v);
    for (const k of Object.keys(v)) {
      // Themes often nest an UNTYPED stub here, littlerituals.in publishes
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
             ttfb, total: Date.now() - t0, contentType: res.headers.get('content-type') || '', cf: !!res.headers.get('cf-ray') };
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

// Shopify ranks its own collection pages by real order volume, so the store's
// bestsellers are public without buying demand data. Only the HTML route honours
// sort_by -- /collections/all/products.json ignores it and returns alphabetical.
function bestSellingHandles(html) {
  const out = [];
  const seen = new Set();
  const re = /\/products\/([a-z0-9][a-z0-9-]*)/gi;
  let m;
  while ((m = re.exec(html))) {
    const handle = m[1].toLowerCase();
    if (!seen.has(handle)) { seen.add(handle); out.push(handle); }
  }
  return out;
}

// Returns the catalogue's bestsellers in order, or null when the store's
// collection page cannot be read (JS-rendered themes, blocked, or empty).
async function bestSellerSample(origin, products, size, fetchPage) {
  const byHandle = new Map(products.filter(p => typeof p.handle === 'string').map(p => [p.handle.toLowerCase(), p]));
  if (!byHandle.size) return null;
  const ranked = [];
  const taken = new Set();
  for (let page = 1; page <= 2 && ranked.length < size; page += 1) {
    const res = await fetchPage(`${origin}/collections/all?sort_by=best-selling${page > 1 ? `&page=${page}` : ''}`);
    if (!res.ok || !res.body) break;
    const handles = bestSellingHandles(res.body);
    if (!handles.length) break;
    for (const handle of handles) {
      const product = byHandle.get(handle);
      if (!product || taken.has(handle)) continue;
      taken.add(handle);
      ranked.push(product);
      if (ranked.length >= size) break;
    }
    // A page that adds nothing new means pagination has run out.
    if (!handles.some(h => byHandle.has(h))) break;
  }
  // Too few matches means the page was not a usable product listing.
  return ranked.length >= Math.min(size, 5, byHandle.size) ? ranked : null;
}

function spreadSample(arr, n) {
  if (arr.length <= n) return arr.slice();
  const step = arr.length / n;
  return Array.from({ length: n }, (_, i) => arr[Math.floor(i * step)]);
}

export function extractJsonLd(html) {
  const out = [];
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (value['@type']) out.push(value);
    for (const child of Object.values(value)) if (child && typeof child === 'object') visit(child);
  };
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = re.exec(html))) visit(safeJson(match[1].trim()));
  return out;
}
const isType = (b, t) => b && [].concat(b['@type'] || []).some(type => String(type).replace(/^https?:\/\/schema.org\//, '') === t);
export function productMarkup(blocks) {
  const product = blocks.find(b => isType(b, 'ProductGroup')) || blocks.find(b => isType(b, 'Product'));
  const resolve = node => node?.['@id'] ? {...blocks.find(b => b['@id'] === node['@id']), ...node} : node;
  const variants = [].concat(product?.hasVariant || []).map(resolve).filter(Boolean);
  const offersFor = node => [].concat(node?.offers || []).map(resolve).filter(o => o && typeof o === 'object');
  const offers = [...offersFor(product), ...variants.flatMap(offersFor)];
  return {product, offers, variants, variantLevelOffers: variants.length > 1
    ? variants.every(v => offersFor(v).some(o => o.price != null && o.availability != null))
    : offers.length > 1 && offers.every(o => o.price != null && o.availability != null)};
}
export function productPageIssue(response) {
  if (!response.ok) return `HTTP ${response.status || 'unavailable'}`;
  if (!response.body?.trim()) return 'Empty product page';
  const title = (response.body.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
  if (/404|page not found|just a moment|access denied|checking your browser/i.test(title)) return 'Error or challenge page';
  if (response.finalUrl && !new URL(response.finalUrl).pathname.includes('/products/')) return 'Redirected away from a product URL';
  return null;
}

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

// Currency must come from explicit store data, never geography or a default.
export function storefrontMarket(html) {
  return {
    currency: (html.match(/Shopify\.currency\s*=\s*\{[^}]*["']?active["']?\s*:\s*["']([A-Z]{3})["']/i) || [])[1]?.toUpperCase() || null,
    country: (html.match(/Shopify\.country\s*=\s*["']([A-Z]{2})["']/i) || [])[1]?.toUpperCase() || null,
  };
}
export function reportCurrency(products, fallback) {
  const currencies = [...new Set(products.map(p => p.offerCurrency).filter(c => /^[A-Z]{3}$/.test(c || '')))];
  return currencies.length > 1 ? null : currencies[0] || (/^[A-Z]{3}$/.test(fallback || '') ? fallback : null);
}
// Pair the price with its own Offer currency. Catalogue prices can belong to a
// different market; never relabel them with a currency from another page.
export function observedOfferPrice(p) {
  return p.offerPrice != null && /^[A-Z]{3}$/.test(p.offerCurrency || '')
    ? {price: p.offerPrice, priceCurrency: p.offerCurrency}
    : {price: 'REPLACE_WITH_VERIFIED_PRICE', priceCurrency: 'REPLACE_WITH_VERIFIED_CURRENCY'};
}

/**
 * Ratings a review app renders into the page but does not publish as
 * AggregateRating. jhamasweets.com serves data-average-rating='4.50' and
 * data-number-of-reviews='4' from Judge.me while its Product schema carries no
 * rating at all, so the audit reported "no rating found" to a merchant who
 * plainly has reviews. The score is unchanged, because an agent still cannot
 * read them; only the evidence becomes accurate.
 */
export function observedRating(html, {appPresent = false} = {}) {
  const text = String(html || '');
  const pick = (pattern, limit) => [...text.matchAll(pattern)]
    .map(m => Number(m[1])).filter(v => Number.isFinite(v) && v >= 0 && (!limit || v <= limit));

  // Aggregate attributes only. A bare data-rating is a single star in a widget's
  // own markup, and treating it as an aggregate reported "rated 5" on products
  // with zero reviews.
  const counts = pick(/data-(?:number-of-reviews|reviews?-count|number-of-ratings|review-total|total-reviews)=['"](\d+)['"]/gi);
  const scores = pick(/data-(?:average-rating|average-score|aggregate-rating|rating-value|avg-rating|average)=['"]([\d.]+)['"]/gi, 5);

  // Microdata, which several apps emit instead of JSON-LD.
  const micro = /itemprop=['"]ratingValue['"][^>]*content=['"]([\d.]+)['"]/gi;
  const microCount = /itemprop=['"](?:reviewCount|ratingCount)['"][^>]*content=['"](\d+)['"]/gi;
  scores.push(...pick(micro, 5));
  counts.push(...pick(microCount));

  // Text a widget renders server side, e.g. "Based on 34 reviews". The number
  // and the word must sit together on one line: \s+ spans newlines, and a
  // stray "8" ending one element joined a "Reviews" heading in the next.
  const fromText = [
    ...text.matchAll(/\bbased on[ \u00a0]{1,3}(\d{1,6})[ \u00a0]{1,3}reviews?\b/gi),
    ...text.matchAll(/(\d{1,6})[ \u00a0]{1,2}reviews?\b/gi),
  ].map(m => Number(m[1])).filter(Number.isFinite);
  counts.push(...fromText);

  const count = counts.length ? Math.max(...counts) : 0;
  const value = scores.filter(v => v > 0).sort((a, b) => b - a)[0] ?? null;
  if (count > 0 || value !== null) return {status: 'found', count, value};
  // A widget that reports zero was read successfully: this product has no
  // reviews yet, which is a different fact from one we could not read.
  if (counts.length) return {status: 'none', count: 0, value: null};
  // A widget is on the page but nothing countable came out of it. Saying "no
  // rating found" here would be a claim the audit cannot support: the reviews
  // may exist and load only in a browser.
  if (appPresent) return {status: 'untraceable', count: 0, value: null};
  return null;
}

export function inspectAgentMd(response) {
  const {status, body = '', contentType = ''} = response;
  if (status === 404 || status === 410) return {status: 'absent', value: 0, detail: `Not found (HTTP ${status}).`};
  if (!response.ok) return {status: 'unavailable', value: null, detail: status ? `Could not verify (HTTP ${status}).` : 'Could not verify: request failed or timed out.'};
  if (!body.trim()) return {status: 'absent', value: 0, detail: 'The endpoint returned an empty response.'};
  if (/text\/html|application\/xhtml/i.test(contentType) || /<!doctype\s+html|<html[\s>]/i.test(body)) {
    return {status: 'unavailable', value: null, detail: 'The endpoint returned an HTML page, not a verified Markdown file.'};
  }
  if (contentType && !/text\/(plain|markdown|x-markdown)|application\/(octet-stream|markdown)/i.test(contentType)) {
    return {status: 'unavailable', value: null, detail: 'The endpoint returned an unexpected content type.'};
  }
  return {status: 'present', value: 100, detail: 'A non-empty text response was found. Presence only; instructions and authorship were not validated.'};
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

  const checkoutHtml = withoutDisabledFlags(home.body);
  raw.checkoutStack = CHECKOUT_STACKS.filter((c) => c.re.test(checkoutHtml)).map((c) => c.key);
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
  // currency for the fix snippets, the product pages are the reliable source,
  // this is only the fallback when none of them carry an offer
  Object.assign(raw, storefrontMarket(home.body));
  // How the brand name is rendered, for Layer 4's entity-consistency check.
  // Tokenised so "SuperYou", "Super You" and "Super-You" all match, and we can
  // tell which literal form each page actually used.
  const brandBase = String(raw.brandName || '').split(/[|–, :·]/)[0].trim();
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

  raw.reviewApps = REVIEW_APPS.filter((a) => a.re.test(withoutDisabledFlags(home.body))).map((a) => a.key);

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
   * checkout app sits on the storefront, which is why stack depth has no
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

  // llms.txt, reported for completeness; Shopify auto-generates it store-wide
  const llms = await get(origin + '/llms.txt');
  raw.llmsTxt = {
    exists: inspectAgentMd(llms).status === 'present',
    status: inspectAgentMd(llms).status,
    detail: inspectAgentMd(llms).detail,
    shopifyGenerated: /shop\.app\/SKILL\.md|agentic storefronts|agent instructions/i.test(llms.body || ''),
    bytes: llms.bytes,
  };

  onProgress('Checking /agents.md');
  raw.agentMd = inspectAgentMd(await get(origin + '/agents.md'));

  onProgress(`Inspecting ${Math.min(SAMPLE_SIZE, products.length)} products`);
  // Audit what the store actually sells. Falls back to an even spread across the
  // catalogue when the bestseller listing is unreadable; the basis is recorded
  // either way so the two can be told apart afterwards.
  const ranked = await bestSellerSample(origin, products, SAMPLE_SIZE, get);
  raw.samplingBasis = ranked ? 'best-selling' : 'catalogue-spread';
  raw.samplingRanked = ranked ? ranked.length : 0;
  const sample = ranked || spreadSample(products, SAMPLE_SIZE);
  raw.products = await mapLimit(sample, CONCURRENCY, async (p) => {
    const url = `${origin}/products/${p.handle}`;
    const r = await get(url);
    const pageIssue = productPageIssue(r);
    const html = !pageIssue ? r.body : '';
    const blocks = extractJsonLd(html);
    const markup = productMarkup(blocks);
    const pb = markup.product;
    const offers = markup.offers;
    const desc = stripHtml(p.body_html);
    const options = (p.options || []).filter((o) => o.name !== 'Title');
    const variants = p.variants || [];
    const agg = pb && pb.aggregateRating ? pb.aggregateRating : null;
    const reviewUi = REVIEW_APPS.some((a) => a.re.test(html)) || REVIEW_UI_RE.test(html);
    const rendered = agg ? null : observedRating(html, {appPresent: reviewUi});
    const canonical = (html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i) || [])[1] || '';
    const robotsMeta = (html.match(/<meta[^>]+name=["']robots["'][^>]+content=["']([^"']+)["']/i) || [])[1] || '';

    return {
      handle: p.handle,
      title: p.title,
      url,
      pageOk: !pageIssue,
      pageIssue,
      finalUrl: r.finalUrl,
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
      offerPrice: offers.find(o => o && o.price != null && /^[A-Z]{3}$/.test(o.priceCurrency || ''))?.price ?? null,
      offerCurrency: offers.find(o => o && o.price != null && /^[A-Z]{3}$/.test(o.priceCurrency || ''))?.priceCurrency || null,
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
        sku: !!(pb && (pb.sku || offers.some((o) => o && o.sku) || markup.variants.some(v => v.sku))),
        brand: !!(pb && pb.brand),
        variantLevelOffers: markup.variantLevelOffers,
        rating: !!agg,
        ratingCount: agg ? Number(agg.reviewCount || agg.ratingCount || 0) : 0,
        renderedRating: rendered,
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
// Every snippet is built from the store's own catalogue, real handle, real
// price, real SKU, real option names. Two stores never get the same block, and
// a brand can paste what it sees without editing placeholders back out.
// Anything we genuinely cannot know is written in SCREAMING_CASE so it is
// obvious it still needs a human.

const ld = (obj) => JSON.stringify(obj, null, 2);
const availUrl = (yes) => `https://schema.org/${yes ? 'InStock' : 'OutOfStock'}`;

function productFix(p, brand) {
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
      ...observedOfferPrice(p),
      availability: availUrl(p.available),
    },
  });
}

function variantFix(p, brand) {
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
      name: `${p.title}: ${v.title}`,
      sku: v.sku || 'YOUR_SKU_HERE',
      offers: {
        '@type': 'Offer',
        price: 'REPLACE_WITH_VERIFIED_VARIANT_PRICE',
        priceCurrency: 'REPLACE_WITH_VERIFIED_VARIANT_CURRENCY',
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

function reviewFix(p) {
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
    offers: { '@type': 'Offer', ...observedOfferPrice(p), availability: availUrl(p.available) },
  });
}

// ====================================================================== SCORE

function pctOf(list, fn) { return list.length ? clamp((list.filter(fn).length / list.length) * 100) : 0; }

/**
 * Report wording that depends on where the store sells. COD is a real purchase
 * path in India and not in the US, and "pincode" is Indian usage for a postcode.
 * cleolifestyle.com is a USD storefront whose report read "No COD signal on any
 * of 15 sampled products"; keep this market-aware rather than inlining it.
 */
export function marketTerms(country, currency) {
  const indian = country ? country === 'IN' : currency === 'INR';
  return {
    indian,
    area: indian ? 'pincode' : 'postcode',
    payWords: indian ? 'COD or prepaid' : 'payment-method',
    paySignal: indian ? 'COD' : 'payment-method',
  };
}

export function score(raw) {
  const live = (raw.products || []).filter((p) => p.pageOk);
  // Recorded so a thin sample is visible rather than silently scored as failure.
  raw.productPages = {attempted: (raw.products || []).length, readable: live.length};
  const {indian: IN_MARKET, area: AREA, payWords: PAY_WORDS, paySignal: PAY_SIGNAL} =
    marketTerms(raw.country, reportCurrency(live, raw.currency));
  const money = p => {
    const offer = observedOfferPrice(p);
    return p.offerPrice != null && /^[A-Z]{3}$/.test(p.offerCurrency || '')
      ? `${offer.priceCurrency} ${offer.price}` : null;
  };
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
    robots: raw.robots?.fetched ? clamp(100 - (raw.robots.blocked.length / AI_BOTS.length) * 100) : 0,
    // v2 spec merges "can agents enumerate the catalogue" with "are the pages
    // indexable" into one check. Sitemap is no longer part of it, that moved
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
    // elsewhere). Script count was the wrong proxy, this uses response time
    // and payload size, which is what actually costs a crawler.
    pageWeight: hasProducts
      ? pageSpeedScore(median(live.map((p) => p.htmlBytes)) / 1024, median(live.map((p) => p.ttfb || 0))).score
      : 0,
  };

  // ---------------------------------------------------------------- Layer 2
  const schemaRatingPct = pctOf(live, (p) => p.schema.rating);
  // apps named anywhere, homepage or any sampled product page
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
      return 50;                         // no FAQ content anywhere, not a fault
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
    // is kept as informational context only, see raw.checkoutStack.
    ucpProfile: (() => {
      const u = raw.ucp || {};
      if (!u.ok || !u.capabilities.length) return 0;
      if (!u.checkoutVersions.length) return 0;
      // current if the declared checkout version matches the profile's own
      return u.version && u.checkoutVersions.includes(u.version) ? 100 : 40;
    })(),
    // v2 spec: binary. A parseable acceptedPaymentMethod on the Offer or
    // nothing, payment options rendered as page text earn no credit.
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
    // measured and reported, not scored, see LAYER3_SPEC
    shippingPolicy: graded((raw.policyShipping || {}).len || 0),
  };

  // ---------------------------------------------------------------- Layer 4
  const uniqueDesc = new Set(live.map((p) => p.descKey)).size;
  /**
   * Layer 4, v2 spec structure, answer-first, factual density, entity
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
    // case or spacing = 70; the name missing from some pages, or non-equivalent forms = 40.
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
      return `${blocked.map(([b]) => b).join(' and ')} cannot load the site: ${blocked[0] ? blocked[0][1] : 'blocked'}. These are requests from this scanner using crawler user-agent strings, not requests from the actual AI providers.`;
    },
    robots: () => `robots.txt explicitly disallows ${raw.robots.blocked.join(', ')}.`,
    endpoints: () => raw.catalogOpen
      ? 'The sitemap is unavailable, so agents have no reliable list of product URLs to crawl.'
      : `The public product feed is closed (products.json returned nothing), so this scanner could not enumerate products through that endpoint. Other discovery channels were not tested.`,
    indexability: () => `${cnt((p) => p.noindex)} of ${n} sampled products carry a noindex tag, and ${cnt((p) => !p.hasCanonical)} have no canonical URL.`,
    pageWeight: () => {
      const kb = Math.round(median(live.map((p) => p.htmlBytes)) / 1024);
      const ms = median(live.map((p) => p.ttfb || 0));
      return `Product pages average ${kb}KB and take ${ms}ms to first byte, slow enough that crawlers sample fewer pages per visit.`;
    },
    productSchema: (v) => `${n - Math.round((v / 100) * n)} of ${n} sampled products have incomplete structured data: ${missingSchemaField()}. Agents read price and stock from this, not from the page.`,
    orgSchema: () => raw.org && raw.org.present
      ? `The homepage has brand data but only ${raw.org.sameAs} linked profile${raw.org.sameAs === 1 ? '' : 's'}. Agents use these to confirm ${raw.brandName} is a real business.`
      : `${raw.brandName} has no Organization markup on the homepage, so this check did not find a homepage Organization declaration. This does not establish seller legitimacy or Catalog visibility.`,
    reviewSchema: (v) => v === 25
      ? `${reviewAppLabel} is displaying reviews, but none are exposed as structured data, so this scanner did not find those ratings in the checked structured data.`
      : (() => {
        const missing = cnt((p) => !p.schema.rating);
        const shown = live.filter((p) => !p.schema.rating && p.schema.renderedRating?.status === 'found');
        const untraceable = live.filter((p) => !p.schema.rating && p.schema.renderedRating?.status === 'untraceable');
        const tail = ' Reviews are one of the five signals Shopify ranks agentic listings on.';
        if (shown.length) return `${missing} of ${n} products have no machine-readable rating, though ${shown.length} show review counts on the page that only load as widget markup.${tail}`;
        if (untraceable.length) return `${missing} of ${n} products have no machine-readable rating. A review widget runs on ${untraceable.length} of them, but this audit could not read a rating from the page, so any reviews there may load only in a browser.${tail}`;
        return `${missing} of ${n} products have no machine-readable rating.${tail}`;
      })(),
    variantSchema: () => `${cnt((p) => p.variantCount > 1 && !p.schema.variantLevelOffers)} of ${n} products have multiple variants but expose only one price, so an agent asked for a specific size can't confirm it exists.`,
    faqSchema: (v) => v === 30
      ? 'FAQ content was detected but no FAQ or HowTo JSON-LD was found on the checked pages. Plain text may still be usable.'
      : 'No FAQ or HowTo JSON-LD was found on the checked pages. This does not test whether an assistant can answer from prose or other sources.',
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
      // Only say COD where COD is a real purchase path. Elsewhere the finding is
      // the same -- no machine-readable payment method -- without the framing.
      const closing = (raw.country ? raw.country === 'IN' : reportCurrency(live, raw.currency) === 'INR')
        ? ' This is a public markup gap, not proof that COD or prepaid checkout is unavailable.'
        : ' Shopify Catalog and live checkout payment options were not tested.';
      return `No product declares acceptedPaymentMethod in its Offer${inText ? `, though ${inText} of ${n} name payment options in page text; this check only scores Offer markup` : ''}.${closing}`;
    },
    serviceability: () => {
      const widget = cnt((p) => p.pincodeWidget);
      // "pincode" is Indian usage; say postcode elsewhere.
      const area = (raw.country ? raw.country === 'IN' : reportCurrency(live, raw.currency) === 'INR') ? 'pincode' : 'postcode';
      return `No product publishes OfferShippingDetails${widget ? `, a ${area} or delivery checker was detected on ${widget} of ${n} pages; its live behavior was not tested` : ''}. This scanner did not verify delivery to a specific address or information supplied through Shopify Catalog.`;
    },
    returnPolicy: (v) => v === 0
      ? 'No return policy page was found at the URLs checked. Other policy locations were not verified.'
      : v === 70
        ? 'The return policy is published as structured data but states no return window, the one field an agent needs most.'
        : `The return policy exists as ${(raw.policyReturn || {}).len} characters of prose with no MerchantReturnPolicy markup, so the structured-data check is incomplete. The prose may still state usable return terms.`,
    shippingPolicy: (v) => v === 0
      ? 'No shipping policy page was found at the URLs checked. This is not a test of delivery availability.'
      : `The shipping policy is only ${(raw.policyShipping || {}).len} characters, not enough for an agent to quote delivery terms.`,
    factualDensity: () => `Sampled descriptions average ${(live.reduce((a, p) => a + p.unitMentions, 0) / n).toFixed(1)} concrete measurements each, and ${cnt((p) => !p.hasSpecWord)} of ${n} never mention material, ingredients or dimensions.`,
    descriptionDepth: () => {
      const empty = cnt((p) => p.descWords === 0);
      const thin = cnt((p) => p.descWords > 0 && p.descWords < 60);
      return `${empty} of ${n} sampled products have no description at all and ${thin} have fewer than 60 words. Word count is an informational heuristic, not a measured ranking factor.`;
    },
    answerFirst: () => {
      const worst = ANSWER_PROBES.map(([label, re]) => [label, cnt((p) => !re.test(p.descFull || ''))])
        .sort((a, b) => b[1] - a[1])[0];
      return `Sampled descriptions answer ${Math.round(l4.answerFirst / 25)} of the 4 questions an agent asks: ${worst[1]} of ${n} never cover ${worst[0]}.`;
    },
    entityConsistency: (v) => v === 40
      ? `The brand name isn't rendered consistently across sampled pages, according to this deterministic name-matching check.`
      : `The brand name appears in more than one written form across sampled pages, which this name-matching heuristic penalizes; AI entity recognition was not tested.`,
    productFeed: () => raw.catalogOpen
      ? `${cnt((p) => p.noindex)} of ${n} sampled products carry a noindex tag, and ${cnt((p) => !p.hasCanonical)} have no canonical URL.`
      : `The public product feed is closed (products.json returned nothing), so this scanner could not enumerate products through that endpoint. Other discovery channels were not tested.`,
    uniqueness: () => `${n - new Set(live.map((p) => p.descKey)).size} of ${n} sampled products reuse another product's description, under the description-prefix comparison used by this check.`,
    imageCoverage: () => `${cnt((p) => p.imageCount <= 1)} of ${n} products have one image or none. Image count is informational; recommendation behavior was not tested.`,
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
      // time, theme logic and app blocks, and payload is what the theme and
      // its apps emit. Both are fixable by the brand; "upgrade your server" is
      // not the advice.
      verdict: sizePenalty === 0 && timePenalty === 0
        ? 'Inside both thresholds, no penalty applied.'
        : timePenalty > sizePenalty
          ? 'Shopify takes longer to render these pages than to send them, theme logic and app blocks, not page size.'
          : 'The pages are heavy. Every store here sits on the same Shopify infrastructure, so this is theme and app payload rather than hosting.',
      slowest,
      thresholds: 'Free below 600KB and 800ms to first byte, then graded.',
      caveat: 'Time to first byte and HTML payload, measured from this machine, not Core Web Vitals. The spec asks for LCP via PageSpeed Insights, which needs an API key and around 30 seconds per URL.',
    };
  })() : null;

  // ------------------------------------------------ Layer 2, check by check
  // Each check carries three things the summary row can't: what it measured,
  // WHICH products failed, and the exact JSON-LD this store would need to fix
  // it, built from its own catalogue, so no two stores get the same block.
  //
  // `basis` is deliberate and load-bearing. 'measured' means the number is a
  // percentage of the sample. 'state' means it is one of a fixed set of graded
  // outcomes. 'baseline' means no fault was found and the check declines to
  // punish the store, the only two baselines in this layer are "no reviews
  // anywhere" and "no FAQ content anywhere", both at 50. They are floors by
  // choice, not defaults papering over a failed measurement, and the screen
  // labels them as such so nobody reads 50 as a measurement.
  const layer2Report = (() => {
    const currency = reportCurrency(live, raw.currency);
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
    const renderedNote = (r) => {
      if (r?.status === 'found') return `${r.count ? `${r.count} reviews` : 'A rating'} on the page${r.value ? `, rated ${r.value}` : ''}, but no AggregateRating`;
      if (r?.status === 'none') return 'No reviews on this product yet, and no AggregateRating';
      if (r?.status === 'untraceable') return 'A review widget is present, but this audit could not read a rating from the page, and there is no AggregateRating';
      return 'no AggregateRating';
    };
    const reviewFails = live.filter((p) => !p.schema.rating)
      .map((p) => ({title: p.title, url: p.url, note: renderedNote(p.schema.renderedRating)}));
    // these two lists are things the store got RIGHT, flagged so the screen
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
        problemCount: o.problemCount ?? null,
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
        why: 'Built as specified. Real variance across stores, 0% to 100%.',
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
          snippet: productFix(pFix, brand),
        } : null,
      }),
      build('variantSchema', {
        value: l2.variantSchema,
        // A store whose whole catalogue is single-variant passes this check
        // vacuously, every product trivially satisfies it. Calling that
        // "measured 100" overstates what we know, so it is labelled a baseline.
        basis: live.some((p) => p.variantCount > 1) ? 'measured' : 'baseline',
        basisNote: live.some((p) => p.variantCount > 1)
          ? `${live.filter((p) => p.variantCount > 1).length} of ${n} sampled products have more than one variant`
          : `No product in the sample has more than one variant, so this check had nothing to evaluate on this store. It scores 100 because no fault was found, not because anything was verified, and it still takes ${Math.round(layer2Weight('variantSchema') * 100)}% of the layer.`,
        result: `${variantFails.length} of ${n} multi-variant products expose only one price`,
        why: 'Redefined. Checking whether option names appear in HTML returned 100 everywhere, so it now checks variant-level offers.',
        evidence: {
          headline: variantFails.length
            ? `${variantFails.length} products publish one offer for several buyable variants`
            : live.some((p) => p.variantCount > 1)
              ? 'Every multi-variant product publishes offers per variant'
              : 'No multi-variant products in the sample, nothing to structure',
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
          snippet: variantFix(vFix, brand),
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
              : `${brand} has no Organization block, so this check did not find a homepage Organization declaration.`,
            'Use the profiles you actually run, Instagram, LinkedIn, Wikipedia, Amazon brand store.',
          ],
          snippet: orgFix(brand, raw.domain, raw.orgLogo, raw.orgSameAs || []),
        } : null,
      }),
      build('faqSchema', {
        value: l2.faqSchema,
        basis: l2.faqSchema === 50 ? 'baseline' : 'state',
        basisNote: l2.faqSchema === 50
          ? 'No FAQ content found anywhere. Scored 50 by choice, a store without an FAQ page is not committing a markup error, so it is neither credited nor punished.'
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
              ? 'The answers are already written, they are just not machine-readable. This is markup around copy you have.'
              : 'There is no FAQ content to mark up yet. Write the delivery and returns answers first.',
            'Reuse your real question-and-answer text verbatim; inventing answers here would misrepresent the store.',
          ],
          snippet: faqFix(brand),
        } : null,
      }),
      {
        ...build('agentMd', {
          value: raw.agentMd?.value ?? null,
          basis: 'state',
          basisNote: 'Informational only: a non-empty text response at /agents.md is present (100). A missing or empty file is absent (0). Blocked, failed or HTML responses are recorded as unverified and carry no score. This check has no scoring weight.',
          result: raw.agentMd?.status === 'present' ? 'Present' : raw.agentMd?.status === 'absent' ? 'Absent' : 'Not verified',
          why: 'Checks the exact /agents.md path, not /agents.md or another endpoint. File presence does not establish agent support or checkout compatibility. Absence does not require a fix.',
          evidence: {
            headline: raw.agentMd?.detail || 'This saved scan did not check /agents.md.',
            items: [{title: '/agents.md', url: raw.domain + '/agents.md', note: raw.agentMd?.detail || 'Not checked'}],
            total: 1, more: 0,
          },
          fix: null,
        }),
        informationalOnly: true,
      },
      build('llmsTxt', {
        value: raw.llmsTxt?.exists ? 100 : raw.llmsTxt?.status === 'absent' ? 0 : null,
        basis: 'state',
        basisNote: 'Measured and shown, excluded from the score. Its 10% is redistributed across the other five checks.',
        result: raw.llmsTxt && raw.llmsTxt.exists
          ? (raw.llmsTxt.shopifyGenerated ? 'Present, contains Shopify-related instruction references; authorship unverified' : 'Present, authorship unverified')
          : raw.llmsTxt?.status === 'absent' ? 'Absent' : 'Not verified',
        why: 'Presence is informational and excluded from scoring. This request does not verify authorship, accuracy or whether an AI system uses the file.',
        evidence: {
          headline: raw.llmsTxt && raw.llmsTxt.exists
            ? `${raw.llmsTxt.bytes} bytes served at /llms.txt`
            : raw.llmsTxt?.detail || 'Not verified in this saved scan',
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
            ? 'A review app is displaying ratings but none are machine-readable. Scored 25, reviews exist, agents just cannot read them.'
            : 'No reviews found anywhere on the store. Scored 50 by choice, having no reviews yet is not a markup fault, so it is neither credited nor punished.',
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
              ? `${namedApps[0] || 'The review widget'} renders ratings in JavaScript. This scanner reads initial HTML without executing JavaScript; other systems may have additional access.`
              : 'Collect reviews first, this block must reflect real ratings.',
            'Most review apps have this as a single toggle; it does not need theme code.',
            'Never publish a rating you cannot substantiate.',
          ],
          snippet: reviewFix(rFix),
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
    const currency = reportCurrency(live, raw.currency);
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
        problemCount: o.problemCount ?? null,
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
          ? `Profile lists dev.ucp.shopping.checkout at ${((raw.ucp || {}).checkoutVersions || []).join(', ') || 'no version'} · ${(raw.ucp || {}).capabilities.length} capabilities`
          : `No parseable UCP profile verified (${(raw.ucp || {}).status || 'no response'})`,
        why: 'Checks a public UCP capability declaration, not a completed transaction. Detected checkout apps do not establish whether an AI purchase succeeds. Shopify Catalog access and live checkout must be verified separately.',
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
            'Check current Agentic settings and supported checkout channels in Shopify admin. Do not infer purchase failure from this endpoint alone.',
          ],
          snippet: null,
        } : null,
      }),
      build('codPayment', {
        value: l3.codPayment,
        basis: 'state',
        basisNote: 'Binary presence rule: at least one sampled product declares acceptedPaymentMethod on an Offer = 100; none = 0. A score of 100 is not full catalogue coverage. Payment options rendered as page text earn no credit, they are shown below as context, not as partial marks.',
        result: paySchemaPct > 0
          ? `${Math.round((paySchemaPct / 100) * n)} of ${n} products declare acceptedPaymentMethod`
          : codPct > 0
            ? `No acceptedPaymentMethod anywhere: ${PAY_SIGNAL} appears only as page text on ${cnt((p) => p.codInText)} of ${n} products`
            : `No acceptedPaymentMethod, and no ${PAY_WORDS} signal in page text either`,
        why: 'Not in the previous build. The spec asks for payment options structured rather than buried in JS widgets, so this separates a parseable field from prose a human reads.',
        evidence: {
          headline: paySchemaPct > 0
            ? `${cnt(p => p.paymentSchema)} of ${n} products declare acceptedPaymentMethod`
            : codPct > 0
            ? `${PAY_SIGNAL} named in the page text of ${cnt((p) => p.codInText)} of ${n} products; acceptedPaymentMethod on 0`
            : `No ${PAY_SIGNAL} signal on any of ${n} sampled products`,
          ...cap(live.filter((p) => p.codInText || p.prepaidInText).map((p) => ({
            title: p.title, url: p.url,
            note: [p.codInText && `${PAY_SIGNAL} in text`, p.prepaidInText && 'prepaid in text'].filter(Boolean).join(' · '),
          }))),
        },
        fix: l3.codPayment < 100 && payExample ? {
          headline: `Declare payment methods on the Offer for ${payExample.title}`,
          where: 'Theme editor → product template, in the existing Product JSON-LD Offer',
          steps: [
            IN_MARKET
              ? 'Payment methods were not found in sampled Offer markup. That does not establish whether COD or prepaid methods work in checkout.'
              : 'Payment methods were not found in sampled Offer markup. Shopify Catalog and live checkout were not tested.',
            'If you publish an Offer, add verified fields to it; otherwise review your product markup first.',
            'Confirm accepted methods in your payment settings. Replace every placeholder before publishing; payment availability can vary by market.',
          ],
          snippet: ld({
            '@context': 'https://schema.org', '@type': 'Offer',
            url: payExample.url, ...observedOfferPrice(payExample),
            availability: availUrl(payExample.available),
            acceptedPaymentMethod: [{ '@type': 'PaymentMethod', name: 'REPLACE_WITH_VERIFIED_ACCEPTED_METHOD' }],
          }),
        } : null,
      }),
      build('serviceability', {
        value: l3.serviceability,
        basis: 'state',
        basisNote: `Binary presence rule: at least one sampled product has shippingDetails in its Offer = 100; none = 0. A score of 100 is not full catalogue coverage. A detected ${AREA} or delivery widget is informational; its live API access and checkout behavior were not tested.`,
        result: shipSchemaPct > 0
          ? `${Math.round((shipSchemaPct / 100) * n)} of ${n} products publish OfferShippingDetails`
          : pincodePct > 0
            ? `No OfferShippingDetails, a ${AREA} or delivery checker appears on ${cnt((p) => p.pincodeWidget)} of ${n} pages`
            : `No OfferShippingDetails and no ${AREA} checker found`,
        why: `Not in the previous build. The old shipping check measured the policy page's text length, which is a different question from ${AREA}-level serviceability. That measurement is kept below as an extra, unscored.`,
        evidence: {
          headline: pincodePct > 0
            ? `${AREA} or delivery-estimate widget found on ${cnt((p) => p.pincodeWidget)} of ${n} product pages`
            : `No ${AREA} or delivery-estimate widget found on any sampled product page`,
          ...cap(live.filter((p) => p.pincodeWidget).map((p) => ({
            title: p.title, url: p.url, note: `${AREA} or delivery checker detected; live behavior not tested`,
          }))),
        },
        fix: l3.serviceability < 100 && shipExample ? {
          headline: `Publish delivery windows as shippingDetails for ${shipExample.title}`,
          where: 'Theme editor → product template, in the existing Product JSON-LD Offer',
          steps: [
            'Confirm your actual delivery destinations and windows in your shipping settings. Replace every placeholder before publishing this template.',
            'This exposes public delivery declarations, but does not verify actual delivery eligibility or checkout success.',
            'Publish your real handling and transit times; a wrong promise here is worse than none.',
          ],
          snippet: ld({
            '@context': 'https://schema.org', '@type': 'Offer',
            url: shipExample.url,
            shippingDetails: {
              '@type': 'OfferShippingDetails',
              shippingDestination: { '@type': 'DefinedRegion', addressCountry: 'REPLACE_WITH_VERIFIED_DESTINATION_COUNTRY' },
              deliveryTime: {
                '@type': 'ShippingDeliveryTime',
                handlingTime: { '@type': 'QuantitativeValue', minValue: 'VERIFIED_MIN_HANDLING_DAYS', maxValue: 'VERIFIED_MAX_HANDLING_DAYS', unitCode: 'DAY' },
                transitTime: { '@type': 'QuantitativeValue', minValue: 'VERIFIED_MIN_TRANSIT_DAYS', maxValue: 'VERIFIED_MAX_TRANSIT_DAYS', unitCode: 'DAY' },
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
          : 'No return markup anywhere. Prose caps at 40 however long the page is, this checklist assigns heuristic credit to prose length, not verified AI comprehension. Over 1200 characters = 40, over 400 = 30, any text = 20, missing = 0.',
        result: returnSchema
          ? returnSchema.linkOnly
            ? `Only a link to the policy page, hasMerchantReturnPolicy on ${returnSchemaWhere} carries no window, fees or method`
            : [`MerchantReturnPolicy on ${returnSchemaWhere}`,
               returnSchema.days != null ? `${returnSchema.days}-day window` : 'no return window stated',
               returnSchema.fees ? returnSchema.fees.replace(/([A-Z])/g, ' $1').trim().toLowerCase() : null,
               returnSchema.country ? `for ${returnSchema.country}` : null].filter(Boolean).join(' · ')
          : (raw.policyReturn || {}).len
            ? `Prose only: ${(raw.policyReturn || {}).len} characters at ${(raw.policyReturn || {}).path}, no schema`
            : 'No return policy page found at any standard path',
        // no `why`, this check matches the spec, so there is nothing to explain.
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
                ? 'hasMerchantReturnPolicy currently holds only a URL. This links to a prose page rather than declaring structured return terms; prose may still be usable.'
                : 'The schema is there but states no return window, which is the one field an agent needs most.'
              : `The policy is written${(raw.policyReturn || {}).len ? `: ${(raw.policyReturn || {}).len} characters at ${raw.policyReturn.path}` : ''}, it just isn't machine-readable.`,
            'An agent asked "can I return this, by when, at what cost" reads these five fields. Prose gives it nothing.',
            'Use your real window and fees, this markup is a promise to the customer.',
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
          : 'Plan tier not exposed in public HTML, cannot be determined without admin access',
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
      note: `Rebuilt to the v2 spec. The checkout-stack penalty is retired: ${stack.length ? `this store runs ${stack.join(' + ')}, shown for context only and not scored` : 'no third-party checkout detected'}. Return/exchange policy and Agentic Storefronts eligibility are held back for the next review, so the spec's 35/20/15 renormalise across the three checks below.`,
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
        problemCount: o.problemCount ?? null,
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
        basisNote: `Each sampled description is checked for four facts an agent needs, material or composition, primary use case, size or dimension guidance, and one specific factual attribute. A product scores 25 per fact it covers, and the check is the average across ${n} products. ${
          llmUsed
            ? `Graded by ${(raw.llm || {}).model}, which reads the text and judges whether each fact is actually stated, vague copy like "premium materials" is marked as not covering material.`
            : `Graded by keyword detection${(raw.llm || {}).error ? ` (${raw.llm.error})` : ''}, which errs in both directions: "premium materials" counts as covering material when a reader would not, and a use case phrased outside the matched vocabulary is missed. Treat it as an indicator, not a verdict.`
        }`,
        result: `Descriptions cover ${(l4.answerFirst / 25).toFixed(1)} of the 4 facts on average · ${worstProbe[1]} of ${n} never mention ${worstProbe[0]}`,
        why: llmUsed
          ? `Built to the v2 spec structure. The spec names Claude Haiku; this runs on ${(raw.llm || {}).model} via the free Gemini tier, one request per scan with all descriptions batched. Verdicts are cached by description hash and graded at temperature 0, but model versions, cache lifetime and sampling can still change the result.`
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
          where: 'Product descriptions, Shopify admin → Products, or your PIM',
          steps: [
            `${worstProbe[1]} of ${n} sampled descriptions never mention ${worstProbe[0]}.`,
            'Put factual product information early so it is easier to find; this check does not measure AI answer quality.',
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
          where: 'Product descriptions, Shopify admin → Products',
          steps: [
            `Sampled descriptions average ${(live.reduce((a, p) => a + p.unitMentions, 0) / Math.max(1, n)).toFixed(1)} concrete measurements.`,
            'Concrete measurements make product attributes explicit. This scan does not measure search or AI ranking.',
            'One line of specifications per product moves this more than rewriting the prose.',
          ],
          snippet: null,
        } : null,
      }),
      build('entityConsistency', {
        value: l4.entityConsistency,
        basis: 'state',
        basisNote: `One rendered form of the brand name across all sampled pages = 100; several forms that match once case and spacing are normalised = 70; the name missing from some pages, or non-equivalent forms = 40. Matching is anchored on "${raw.brandName}".`,
        result: noBrand.length
          ? `The brand name is absent from ${noBrand.length} of ${n} sampled product pages`
          : allForms.length <= 1
            ? `One consistent form across all ${n} pages: "${allForms[0] || raw.brandName}"`
            : `${allForms.length} written forms in use: ${allForms.slice(0, 4).map((f) => `"${f}"`).join(', ')}${allForms.length > 4 ? '…' : ''}`,
        why: 'Deterministic name matching on sampled pages, not a measure of recognition by an AI system. One form scores 100; equivalent spelling variants score 70; missing names or non-equivalent forms score 40.',
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
        problemCount: live.filter(p => p.imageCount <= 1).length,
        basis: 'measured',
        basisNote: 'Not in the spec. Graded per product on image count: 7+ = 100, 5-6 = 90, 3-4 = 70, 2 = 45, 1 = 20, none = 0.',
        result: `${live.filter((p) => p.imageCount <= 1).length} of ${n} products have one image or none`,
        why: '',
        evidence: {
          headline: 'Products with one image or none',
          ...cap(live.slice().sort((a, b) => a.imageCount - b.imageCount).filter((p) => p.imageCount <= 1)
            .map((p) => ({ title: p.title, url: p.url, note: `${p.imageCount} image${p.imageCount === 1 ? '' : 's'}` }))),
        },
        fix: live.some(p => p.imageCount <= 1) ? {"headline": "Add useful product images", "where": "Shopify admin → Products → Select product → Media", "steps": ["Start with the products listed in the evidence. Add a clear main image, alternate angles, close-up details and a scale or in-use view where relevant. Use genuine product images and match variant images to the right variants.", "Add concise alternative text describing each image. Confirm that images load on the public product page, then rescan. Image count is informational and does not change the weighted score."], "snippet": null} : null,
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
      currency: reportCurrency(live, raw.currency),
      note: `${llmUsed ? `Answer-first is graded by ${(raw.llm || {}).model}; factual density and entity naming stay deterministic, because counting and string matching do not need a model.` : `The spec computes the first two checks with an LLM call; they are measured here by keyword detection instead, so a scan needs no API key and costs nothing.`} Description length, uniqueness and image coverage are not in the spec, they are measured and shown, never scored.`,
      checks: shown,
    };
  })();

  const specDetail = {
    layer1: {
      name: 'Crawler & Technical Access',
      specWeight: 20,
      checks: [
        { spec: 'robots.txt allows AI crawlers', specSub: 30, scored: false,
          result: !raw.robots?.fetched ? 'robots.txt could not be verified' : raw.robots.blocked.length === 0
            ? `No root-path disallow found for ${AI_BOTS.length} tested AI user agents` : `Root path disallowed: ${raw.robots.blocked.join(', ')}`,
          value: raw.robots?.fetched ? l1.robots : null,
          why: 'Informational check of root-path disallow rules for the listed user agents. Other paths, access controls and actual provider traffic are not tested.' },
        { spec: 'JS-independent content render', specSub: 35, scored: false,
          result: `${renderPct}% of title/price/stock visible without JavaScript`,
          value: renderPct,
          why: 'Informational string matching on initial HTML. Matching text can appear in scripts and does not establish what an AI provider rendered.' },
        { spec: 'Page load speed', specSub: 15, scored: true,
          result: hasProducts ? `${Math.round(median(live.map((p) => p.htmlBytes)) / 1024)}KB, ${median(live.map((p) => p.ttfb || 0))}ms to first byte` : 'no pages loaded',
          value: l1.pageWeight,
          why: 'Measured as response time and payload size rather than PageSpeed Insights, no API key, no 30s wait per scan.' },
        { spec: 'Sitemap present & current', specSub: 20, scored: false,
          result: raw.sitemapOk ? `Present, ${raw.sitemapProductCount || 0} product URLs` : 'Missing',
          value: raw.sitemapOk ? 100 : 0,
          why: 'Reports the sitemap response observed during this scan, not freshness of every URL.' },
        { spec: 'AI crawler access by user-agent', specSub: null, scored: true, added: true,
          result: Object.entries(botVerdicts).map(([b, v]) => `${b}: ${v}`).join(' · '),
          value: l1.botWall,
          why: 'Not in the spec. Fetches the store as each crawler and compares, catches edge blocking that robots.txt cannot show.' },
        { spec: 'Product feed & indexability', specSub: null, scored: true, added: true,
          result: `products.json ${raw.catalogOpen ? 'open' : 'closed'} · ${pctOf(live, (p) => p.noindex)}% noindex · ${staticPct((p) => !p.hasCanonical)}% no canonical`,
          value: l1.productFeed,
          why: 'Not in the spec. Checks this public feed, noindex directives and canonical links; it does not test Shopify Catalog discovery.' },
      ],
    },
    // One source of truth. The overview row and the deep Layer 2 section are the
    // same objects, so they cannot drift, the previous version duplicated these
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

  const technicalKeys = {'Page load speed':'pageWeight', 'AI crawler access by user-agent':'botWall', 'Product feed & indexability':'productFeed'};
  specDetail.layer1.checks = specDetail.layer1.checks.map(c => {
    const key = technicalKeys[c.spec];
    if (!key) return c;
    return {...c, key, costOfTotal: Math.round((100 - c.value) * SUB.layer1[key] * WEIGHTS.layer1 / totalWeight * 10) / 10};
  });

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
      { label: 'Price', value: money(worst), visible: worst.schema.price && money(worst) !== null,
        action: 'Expose price in the product schema' },
      { label: 'In stock', value: worst.available ? 'Yes' : 'No', visible: worst.schema.availability,
        action: 'Add availability to the offer' },
      { label: 'SKU', value: worst.schema.sku ? 'Present' : null, visible: worst.schema.sku,
        action: 'Publish the SKU field' },
      { label: 'Rating',
        value: worst.schema.ratingCount ? `${worst.schema.ratingCount} reviews`
          : worst.schema.renderedRating?.status === 'found'
            ? `${worst.schema.renderedRating.count} reviews on the page${worst.schema.renderedRating.value ? `, rated ${worst.schema.renderedRating.value}` : ''}, not in schema`
            : worst.schema.renderedRating?.status === 'none'
              ? 'No reviews on this product yet'
              : worst.schema.renderedRating?.status === 'untraceable'
                ? 'A review widget is present, but no rating could be read from the page'
                : null,
        visible: worst.schema.rating,
        // What the storefront already shows every visitor is not paid detail.
        public: !worst.schema.rating && Boolean(worst.schema.renderedRating),
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
    scanStatus: live.length === (raw.products || []).length && raw.homeStatus === 200 ? 'complete' : 'partial',
    sampleManifest: (raw.products || []).map(p => ({url: p.url, finalUrl: p.finalUrl || p.url, readable: !!p.pageOk, status: p.status ?? null, issue: p.pageIssue || null, descriptionHash: createHash('sha256').update(p.descFull || p.descSnippet || '').digest('hex')})),
    samplingBasis: raw.samplingBasis || 'catalogue-spread',
    samplingRanked: raw.samplingRanked || 0,
    sampleAttempted: (raw.products || []).length,
    homeStatus: raw.homeStatus,
    checkoutStack: raw.checkoutStack || [],
    productPages: raw.productPages || null,
    country: raw.country || null,
    currency: reportCurrency(live, raw.currency),
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

// Conditions under which a store cannot be scored at all. Returning a score
// anyway would publish zeros that were never measured: every schema check reads
// a product page, and pctOf() over an empty sample is 0, indistinguishable from
// a store that genuinely publishes nothing.
const FATAL = new Set(['NO_RESPONSE', 'NOT_SHOPIFY', 'NO_CATALOG', 'NO_PRODUCT_PAGES']);

// True when the scan cannot honestly produce a score. Exported so the rule is
// testable without a network round trip.
export function unscannable(raw) {
  const products = Array.isArray(raw.products) ? raw.products : null;
  const errors = raw.errors || [];
  if (products && products.length && !products.some((p) => p.pageOk)) return 'NO_PRODUCT_PAGES';
  return errors.find((e) => FATAL.has(e)) || (errors.length && !products ? errors[0] : null);
}

export async function scanStore(domain, onProgress, options = {}) {
  const raw = await collect(domain, onProgress, options);
  // Product pages can 404 or be blocked even when the catalogue feed is fine --
  // shop.truvani.com serves 78 products from products.json and 404s every
  // /products/<handle> page.
  const fatal = unscannable(raw);
  if (fatal === 'NO_PRODUCT_PAGES' && !raw.errors.includes(fatal)) raw.errors.push(fatal);
  if (fatal) {
    return { domain: raw.domain, errors: raw.errors, finalScore: null, grade: null,
      productPages: {attempted: (raw.products || []).length, readable: 0} };
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
    console.log(`\n${r.brandName}: ${r.domain}`);
    console.log(`${r.finalScore}/100   ${r.grade}`);
    console.log(`${r.gradeNote}\n`);
    for (const [, l] of Object.entries(r.layers)) {
      console.log(`  ${String(l.score).padStart(3)}  ${l.name.padEnd(30)} ${'█'.repeat(Math.round(l.score / 5))}`);
    }
    console.log('\n  Top gaps:');
    r.gaps.forEach((g, i) => console.log(`   ${i + 1}. ${g.message}`));
    console.log(`\n  Checkout: ${r.checkoutStack.length ? r.checkoutStack.join(' + ') : 'No checkout app detected; checkout type unconfirmed'}`);
  }
}
