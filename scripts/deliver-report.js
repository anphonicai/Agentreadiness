// Trusted operator command. Do not expose this as an unauthenticated route.
// Payment integration should call fulfillment only after verifying its webhook.
import { fileURLToPath } from 'node:url';
import { openReportStore } from '../report-access.js';
import { reportEmail, sendReportEmail } from '../report-email.js';
const [id, paymentReference] = process.argv.slice(2);
if (!id || !paymentReference) throw new Error('Usage: node scripts/deliver-report.js SCAN_ID VERIFIED_PAYMENT_REFERENCE');
const origin = new URL(process.env.PUBLIC_APP_URL || '');
if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') throw new Error('PUBLIC_APP_URL must be your live HTTPS origin.');
if (!process.env.RESEND_API_KEY || !process.env.REPORT_EMAIL_FROM) throw new Error('Set RESEND_API_KEY and REPORT_EMAIL_FROM.');
const store = openReportStore(process.env.REPORTS_DB_PATH || fileURLToPath(new URL('../data/reports.sqlite',import.meta.url)));
let token;
try {
  const saved = store.get(id);
  if (!saved) throw new Error('Saved report not found.');
  token = store.issue(id, {paymentReference});
  const brand = new URL(saved.result.domain).hostname.replace(/^www\./,'').split('.')[0];
  const email = reportEmail({name:saved.name,domain:saved.result.domain,reportUrl:`${origin.origin}/?report=${token}&store=${encodeURIComponent(brand)}`});
  store.delivery(token, 'sending');
  const providerId = await sendReportEmail({to:saved.email,email,idempotencyKey:`report-${token}`});
  store.delivery(token,'accepted',providerId);
  console.log(`Report email accepted by provider (${providerId}). Inbox delivery is not yet confirmed.`);
} catch (error) {
  if (token) { store.delivery(token,'failed'); store.revoke(token); }
  throw error;
} finally { store.close(); }
