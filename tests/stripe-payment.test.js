import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPayments,verifyStripeEvent} from '../stripe-payment.js';
import {openReportStore} from '../report-access.js';
test('Stripe signatures reject modified bodies and stale events',()=>{
 const raw='{"type":"checkout.session.completed"}', now=Date.now(), t=Math.floor(now/1000);
 const sig=`t=${t},v1=${createHmac('sha256','secret').update(`${t}.${raw}`).digest('hex')}`;
 assert.equal(verifyStripeEvent(raw,sig,'secret',now).type,'checkout.session.completed');
 assert.throws(()=>verifyStripeEvent(raw+' ',sig,'secret',now));
 assert.throws(()=>verifyStripeEvent(raw,sig,'secret',now+301000));
});
test('server fixes price, denies unpaid/mismatched sessions, retries email and fulfills once across restart',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'stripe-test-')), path=join(dir,'reports.sqlite');
 let store=openReportStore(path), sent=0, fail=true;
 const env={PUBLIC_APP_URL:'https://commerce.anphonic.ai',STRIPE_SECRET_KEY:'test',STRIPE_WEBHOOK_SECRET:'test',RESEND_API_KEY:'test',REPORT_EMAIL_FROM:'reports@example.com'};
 let session={id:'cs_test_123',url:'https://checkout.stripe.com/test',client_reference_id:'scan',mode:'payment',amount_total:24900,currency:'usd',payment_status:'unpaid',status:'open'};
 const options={env,fetchImpl:async(url,request)=>{
   if(request.method==='POST') {const form=new URLSearchParams(request.body);assert.equal(form.get('line_items[0][price_data][unit_amount]'),'24900');assert.equal(form.get('customer_email'),'buyer@example.com');}
   return {ok:true,json:async()=>({...session})};
 },send:async()=>{sent++;if(fail) throw new Error('offline');return 'email-id';}};
 try {
 store.save('scan',{domain:'https://superyou.in',finalScore:70},{email:'buyer@example.com'});
 let payments=createPayments(store,options);
 await payments.checkout('scan');
 assert.deepEqual(await payments.fulfill(session.id),{pending:true});assert.equal(sent,0);
 session={...session,payment_status:'paid',status:'complete',amount_total:1};
 await assert.rejects(payments.fulfill(session.id));assert.equal(sent,0);
 session.amount_total=24900;
 const first=await payments.fulfill(session.id);assert.equal(first.emailStatus,'failed');assert.ok(store.resolve(first.token));
 fail=false;
 const [a,b]=await Promise.all([payments.fulfill(session.id),payments.fulfill(session.id)]);
 assert.equal(a.token,b.token);assert.equal(a.token,first.token);assert.equal(sent,2);
 store.close();store=openReportStore(path);payments=createPayments(store,options);
 assert.equal((await payments.fulfill(session.id)).token,a.token);assert.equal(sent,2);
 await assert.rejects(payments.fulfill('cs_test_unknown'));
 } finally {store.close();rmSync(dir,{recursive:true,force:true});}
});
