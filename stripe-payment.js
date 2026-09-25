import {createHmac, timingSafeEqual} from 'node:crypto';
import {reportEmail, sendReportEmail} from './report-email.js';

export function verifyStripeEvent(raw, signature, secret, now=Date.now()) {
  if (!secret || typeof signature !== 'string') throw new Error('Invalid signature');
  const parts = signature.split(',').map(p => p.split('='));
  const timestamp = parts.find(([k]) => k === 't')?.[1];
  if (!/^\d+$/.test(timestamp || '') || Math.abs(now/1000-Number(timestamp)) > 300) throw new Error('Invalid timestamp');
  const expected = createHmac('sha256',secret).update(`${timestamp}.${raw}`).digest();
  if (!parts.some(([k,v]) => k==='v1' && /^[a-f0-9]{64}$/.test(v || '') && timingSafeEqual(expected,Buffer.from(v,'hex')))) throw new Error('Invalid signature');
  return JSON.parse(raw);
}

export const PRICE_CENTS = 24900;

export function createPayments(store, {env=process.env, fetchImpl=fetch, send=sendReportEmail, coupons}={}) {
  let origin;
  try { const u=new URL(env.PUBLIC_APP_URL); if(u.protocol==='https:' || (env.NODE_ENV!=='production' && u.protocol==='http:' && u.hostname==='localhost')) origin=u.origin; } catch {}
  const ready=Boolean(origin && env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET && env.RESEND_API_KEY && env.REPORT_EMAIL_FROM);
  const active = new Map();
  async function stripe(path, body) {
    const response=await fetchImpl(`https://api.stripe.com/v1${path}`, {
      method:body?'POST':'GET', headers:{Authorization:`Bearer ${env.STRIPE_SECRET_KEY}`, ...(body?{'Content-Type':'application/x-www-form-urlencoded'}:{})},
      body:body ? new URLSearchParams(body).toString():undefined, signal:AbortSignal.timeout(15000),
    });
    const data=await response.json();
    if(!response.ok) throw new Error('Payment service unavailable. Please try again.');
    return data;
  }
  return {ready,
    async checkout(id, code) {
      if(!ready) throw new Error('Payments are not configured yet.');
      const report=store.get(id);
      if(!report?.email || !Number.isFinite(report.result.finalScore)) throw new Error('Complete a scan with your email before payment.');
      // A supplied code is validated here, then minted as a single-use Stripe
      // coupon so the discount is applied by Stripe rather than trusted from
      // the browser. Without one, Stripe's own promotion codes stay available.
      let discount;
      if(code!==undefined && code!==null && String(code).trim()!=='') {
        const coupon=coupons?.lookup(code,id);
        if(!coupon) throw new Error('That code is not valid or has already been used.');
        if(coupon.percent>=100) throw new Error('This code unlocks the full report — redeem it instead of paying.');
        const created=await stripe('/coupons',{percent_off:String(coupon.percent),duration:'once',name:coupon.code,max_redemptions:'1'});
        if(!created.id) throw new Error('Unable to apply that code.');
        discount={'discounts[0][coupon]':created.id};
      }
      const session=await stripe('/checkout/sessions',{mode:'payment',client_reference_id:id,customer_email:report.email,payment_method_collection:'if_required',
        'payment_method_types[0]':'card','line_items[0][quantity]':'1',
        'line_items[0][price_data][currency]':'usd','line_items[0][price_data][unit_amount]':String(PRICE_CENTS),
        'line_items[0][price_data][product_data][name]':'Commerce.Anphonic.ai — Full report',
        ...(discount ?? {allow_promotion_codes:'true'}),
        success_url:`${origin}/?checkout={CHECKOUT_SESSION_ID}`,cancel_url:`${origin}/?cancelled=${encodeURIComponent(id)}`});
      if(!session.id || !session.url?.startsWith('https://checkout.stripe.com/')) throw new Error('Unable to open checkout.');
      store.saveCheckout(session.id,id);
      return {url:session.url};
    },
    async fulfill(id) {
      if(!ready || typeof id!=='string' || !/^cs_[a-zA-Z0-9_]+$/.test(id) || !store.getCheckout(id)) throw new Error('Unknown payment.');
      if(active.has(id)) return active.get(id);
      const task=(async()=>{
        const session=await stripe('/checkout/sessions/'+encodeURIComponent(id));
        const checkout=store.getCheckout(id);
        // The subtotal is the price we set and never moves; only the total is
        // reduced by a discount, so that is what may legitimately vary.
        if(session.id!==id || session.client_reference_id!==checkout.report_id || session.mode!=='payment' || session.amount_subtotal!==PRICE_CENTS || session.currency!=='usd') throw new Error('Payment does not match this report.');
        if(!Number.isInteger(session.amount_total) || session.amount_total<0 || session.amount_total>PRICE_CENTS) throw new Error('Payment does not match this report.');
        const discount=session.total_details?.amount_discount ?? 0;
        if(!Number.isInteger(discount) || discount<0 || discount>PRICE_CENTS ||
           (session.total_details?.amount_tax ?? 0)!==0 || (session.total_details?.amount_shipping ?? 0)!==0 ||
           session.amount_total!==PRICE_CENTS-discount) throw new Error('Invalid checkout totals.');
        const settled=session.payment_status==='paid' || (session.amount_total===0 && session.payment_status==='no_payment_required');
        if(!settled || session.status!=='complete') return {pending:true};
        const report=store.get(checkout.report_id);
        const token=checkout.token || store.issue(checkout.report_id,{paymentReference:id});
        store.checkoutToken(id,token);
        if(checkout.email_status!=='accepted') {
          try {
            const email=reportEmail({name:report.name,domain:report.result.domain,reportUrl:`${origin}/?report=${token}`});
            await send({to:report.email,email,idempotencyKey:`report-${id}`},{apiKey:env.RESEND_API_KEY,from:env.REPORT_EMAIL_FROM});
            store.checkoutEmail(id,'accepted');
          } catch { store.checkoutEmail(id,'failed'); }
        }
        return {token,emailStatus:store.getCheckout(id).email_status};
      })();
      active.set(id,task);
      try {return await task;} finally {active.delete(id);}
    },
  };
}
