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

export function createPayments(store, {env=process.env, fetchImpl=fetch, send=sendReportEmail}={}) {
  let origin;
  try { const u=new URL(env.PUBLIC_APP_URL); if(u.protocol==='https:' || (env.NODE_ENV!=='production' && u.protocol==='http:' && u.hostname==='localhost')) origin=u.origin; } catch {}
  const ready=Boolean(origin && env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET && env.RESEND_API_KEY && env.REPORT_EMAIL_FROM);
  const active = new Map();
  async function stripe(path, body) {
    const response=await fetchImpl(`https://api.stripe.com/v1/checkout/sessions${path}`, {
      method:body?'POST':'GET', headers:{Authorization:`Bearer ${env.STRIPE_SECRET_KEY}`, ...(body?{'Content-Type':'application/x-www-form-urlencoded'}:{})},
      body:body ? new URLSearchParams(body).toString():undefined, signal:AbortSignal.timeout(15000),
    });
    const data=await response.json();
    if(!response.ok) throw new Error('Payment service unavailable. Please try again.');
    return data;
  }
  return {ready,
    async checkout(id) {
      if(!ready) throw new Error('Payments are not configured yet.');
      const report=store.get(id);
      if(!report?.email || !Number.isFinite(report.result.finalScore)) throw new Error('Complete a scan with your email before payment.');
      const session=await stripe('',{mode:'payment',client_reference_id:id,customer_email:report.email,
        'payment_method_types[0]':'card','line_items[0][quantity]':'1',
        'line_items[0][price_data][currency]':'usd','line_items[0][price_data][unit_amount]':'24900',
        'line_items[0][price_data][product_data][name]':'Commerce.Anphonic.ai — Full report',
        success_url:`${origin}/?checkout={CHECKOUT_SESSION_ID}`,cancel_url:`${origin}/?cancelled=${encodeURIComponent(id)}`});
      if(!session.id || !session.url?.startsWith('https://checkout.stripe.com/')) throw new Error('Unable to open checkout.');
      store.saveCheckout(session.id,id);
      return {url:session.url};
    },
    async fulfill(id) {
      if(!ready || typeof id!=='string' || !/^cs_[a-zA-Z0-9_]+$/.test(id) || !store.getCheckout(id)) throw new Error('Unknown payment.');
      if(active.has(id)) return active.get(id);
      const task=(async()=>{
        const session=await stripe('/'+encodeURIComponent(id));
        const checkout=store.getCheckout(id);
        if(session.id!==id || session.client_reference_id!==checkout.report_id || session.mode!=='payment' || session.amount_total!==24900 || session.currency!=='usd') throw new Error('Payment does not match this report.');
        if(session.payment_status!=='paid' || session.status!=='complete') return {pending:true};
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
