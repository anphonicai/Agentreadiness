/**
 * coupons.js — discount and full-access codes for the paid report
 *
 * Codes are configured out of band in REPORT_ACCESS_CODES so that issuing one
 * never needs a deploy of new logic:
 *
 *   REPORT_ACCESS_CODES="LAUNCH, PARTNER:50:25, FRIENDS:100:10"
 *                        ^code   ^code:percentOff:maxUses
 *
 * percentOff defaults to 100 and maxUses to unlimited. A 100% code unlocks the
 * report immediately and never touches Stripe; anything less is handed to
 * Stripe as a one-off coupon on the Checkout session, so the money path and its
 * webhook stay the single source of truth for partial discounts.
 */
import {reportEmail, sendReportEmail} from './report-email.js';

const MAX_CODE_LENGTH = 40;
// Deliberately narrow: codes travel in URLs, emails and support tickets.
const CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{2,39}$/;

export const normalizeCode = value => String(value ?? '').trim().toUpperCase();

export function parseCodes(raw) {
  const codes = new Map();
  for (const entry of String(raw ?? '').split(',').map(part => part.trim()).filter(Boolean)) {
    const [name, percentRaw = '', usesRaw = ''] = entry.split(':').map(part => part.trim());
    const code = normalizeCode(name);
    if (!CODE_PATTERN.test(code) || codes.has(code)) continue;
    const percent = percentRaw === '' ? 100 : Number(percentRaw);
    if (!Number.isInteger(percent) || percent <= 0 || percent > 100) continue;
    const maxUses = usesRaw === '' ? Infinity : Number(usesRaw);
    if (maxUses !== Infinity && (!Number.isInteger(maxUses) || maxUses <= 0)) continue;
    codes.set(code, {code, percent, maxUses});
  }
  return codes;
}

export function createCoupons(store, {env = process.env, send = sendReportEmail} = {}) {
  const codes = parseCodes(env.REPORT_ACCESS_CODES);
  let origin;
  try {
    const url = new URL(env.PUBLIC_APP_URL);
    if (url.protocol === 'https:' || (env.NODE_ENV !== 'production' && url.protocol === 'http:' && url.hostname === 'localhost')) origin = url.origin;
  } catch {}
  const canEmail = Boolean(origin && env.RESEND_API_KEY && env.REPORT_EMAIL_FROM);
  const active = new Map();

  // Every rejection reads the same to a caller guessing codes: valid-but-spent
  // and never-existed are indistinguishable from outside.
  const reject = () => { throw new Error('That code is not valid or has already been used.'); };

  function lookup(raw, reportId) {
    const code = normalizeCode(raw);
    if (!code || code.length > MAX_CODE_LENGTH) reject();
    const coupon = codes.get(code);
    if (!coupon) reject();
    // An already-redeemed report keeps working even once the code is exhausted.
    if (reportId && store.redemption(code, reportId)) return coupon;
    if (store.redemptionCount(code) >= coupon.maxUses) reject();
    return coupon;
  }

  async function deliver(coupon, scanId, report, token, previous) {
    if (!canEmail) return 'skipped';
    if (previous?.email_status === 'accepted') return 'accepted';
    try {
      const email = reportEmail({name: report.name, domain: report.result.domain, reportUrl: `${origin}/?report=${token}`});
      await send({to: report.email, email, idempotencyKey: `coupon-${coupon.code}-${scanId}`}, {apiKey: env.RESEND_API_KEY, from: env.REPORT_EMAIL_FROM});
      store.redemptionEmail(coupon.code, scanId, 'accepted');
      return 'accepted';
    } catch {
      store.redemptionEmail(coupon.code, scanId, 'failed');
      return 'failed';
    }
  }

  return {
    get enabled() { return codes.size > 0; },
    lookup,

    /**
     * Redeems a full-access (100%) code into a paid report link without Stripe.
     * A partial code is reported back rather than redeemed, so the caller can
     * carry it into checkout where Stripe applies the discount.
     */
    async redeem(scanId, raw) {
      const coupon = lookup(raw, scanId);
      if (coupon.percent < 100) return {discount: true, percent: coupon.percent, code: coupon.code};
      const report = store.get(scanId);
      if (!report?.email || !Number.isFinite(report.result.finalScore)) throw new Error('Complete a scan with your email before redeeming a code.');

      const key = `${coupon.code}|${scanId}`;
      if (active.has(key)) return active.get(key);
      const task = (async () => {
        const previous = store.redemption(coupon.code, scanId);
        let token = previous?.token;
        if (!token) {
          // Re-check under the in-process lock: the count may have filled while awaiting.
          if (store.redemptionCount(coupon.code) >= coupon.maxUses) reject();
          token = store.issue(scanId, {paymentReference: `coupon:${coupon.code}`});
          store.saveRedemption(coupon.code, scanId, token);
        }
        return {token, emailStatus: await deliver(coupon, scanId, report, token, previous)};
      })();
      active.set(key, task);
      try { return await task; } finally { active.delete(key); }
    },
  };
}
