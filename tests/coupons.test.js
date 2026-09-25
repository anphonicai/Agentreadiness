import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCoupons,parseCodes,normalizeCode} from '../coupons.js';
import {createPayments} from '../stripe-payment.js';
import {openReportStore} from '../report-access.js';

const ENV = {PUBLIC_APP_URL:'https://commerce.anphonic.ai',STRIPE_SECRET_KEY:'test',STRIPE_WEBHOOK_SECRET:'test',RESEND_API_KEY:'test',REPORT_EMAIL_FROM:'reports@example.com'};
function fixture(codes) {
  const dir = mkdtempSync(join(tmpdir(),'coupon-test-'));
  const store = openReportStore(join(dir,'reports.sqlite'));
  store.save('scan',{domain:'https://superyou.in',finalScore:70},{email:'buyer@example.com',name:'Ada'});
  return {dir, store, env:{...ENV, REPORT_ACCESS_CODES:codes}};
}

test('code parsing applies defaults and drops malformed entries',()=>{
 const codes = parseCodes('FOUNDER, partner50:50:25, PRESS:100:10, AB, BAD:0, BAD2:120, BAD3:50:0, BAD4:33.5, FOUNDER:10');
 assert.deepEqual([...codes.keys()],['FOUNDER','PARTNER50','PRESS']);
 assert.deepEqual(codes.get('FOUNDER'),{code:'FOUNDER',percent:100,maxUses:Infinity});
 assert.deepEqual(codes.get('PARTNER50'),{code:'PARTNER50',percent:50,maxUses:25});
 assert.deepEqual(codes.get('PRESS'),{code:'PRESS',percent:100,maxUses:10});
 assert.equal(parseCodes(undefined).size,0);
 assert.equal(normalizeCode('  founder '),'FOUNDER');
});

test('a full-access code unlocks the report once, idempotently, and honours its cap',async()=>{
 const {dir,store,env} = fixture('PRESS:100:1');
 let sent = 0;
 try {
  const coupons = createCoupons(store,{env,send:async()=>{sent++;return 'email-id';}});
  assert.equal(coupons.enabled,true);

  const first = await coupons.redeem('scan','  press  ');       // case and space insensitive
  assert.match(first.token,/^[a-f0-9]{64}$/);
  assert.equal(first.emailStatus,'accepted');
  assert.equal(store.resolve(first.token).result.finalScore,70); // full report, not the preview
  assert.equal(store.resolve(first.token).preview,false);

  // Re-redeeming the same code for the same report returns the same link and
  // does not send a second email or consume another use.
  const [a,b] = await Promise.all([coupons.redeem('scan','PRESS'),coupons.redeem('scan','PRESS')]);
  assert.equal(a.token,first.token);
  assert.equal(b.token,first.token);
  assert.equal(sent,1);

  // The cap of 1 is now spent, so a different report cannot use it.
  store.save('scan2',{domain:'https://superyou.in',finalScore:80},{email:'other@example.com'});
  await assert.rejects(coupons.redeem('scan2','PRESS'),/not valid or has already been used/);
 } finally { store.close(); rmSync(dir,{recursive:true,force:true}); }
});

test('unknown codes and unscanned reports are refused without leaking which failed',async()=>{
 const {dir,store,env} = fixture('FOUNDER');
 try {
  const coupons = createCoupons(store,{env,send:async()=>'id'});
  for (const bad of ['NOPE','','   ',null,undefined,'F'.repeat(60),{}]) {
    await assert.rejects(coupons.redeem('scan',bad),/not valid or has already been used/);
  }
  // A scan with no verified email cannot be unlocked by a code.
  store.save('anon',{domain:'https://superyou.in',finalScore:50},{});
  await assert.rejects(coupons.redeem('anon','FOUNDER'),/Complete a scan with your email/);
  await assert.rejects(coupons.redeem('missing','FOUNDER'),/Complete a scan with your email/);
  assert.equal(createCoupons(store,{env:{...env,REPORT_ACCESS_CODES:''}}).enabled,false);
 } finally { store.close(); rmSync(dir,{recursive:true,force:true}); }
});

test('a partial code is reported for checkout, not redeemed for a free link',async()=>{
 const {dir,store,env} = fixture('PARTNER50:50:25');
 try {
  const coupons = createCoupons(store,{env,send:async()=>{throw new Error('must not email');}});
  assert.deepEqual(await coupons.redeem('scan','partner50'),{discount:true,percent:50,code:'PARTNER50'});
  assert.equal(store.redemptionCount('PARTNER50'),0); // no use consumed until paid
 } finally { store.close(); rmSync(dir,{recursive:true,force:true}); }
});

test('checkout turns a partial code into a Stripe coupon and fulfils the discounted session',async()=>{
 const {dir,store,env} = fixture('PARTNER50:50:25');
 const calls = [];
 let session = {id:'cs_test_disc',url:'https://checkout.stripe.com/x',client_reference_id:'scan',mode:'payment',
   amount_subtotal:24900,amount_total:12450,currency:'usd',payment_status:'paid',status:'complete'};
 try {
  const coupons = createCoupons(store,{env,send:async()=>'id'});
  const payments = createPayments(store,{env,send:async()=>'id',coupons,fetchImpl:async(url,request)=>{
    calls.push([url,request.method==='POST'?new URLSearchParams(request.body):null]);
    if (url.endsWith('/v1/coupons')) return {ok:true,json:async()=>({id:'co_generated'})};
    return {ok:true,json:async()=>({...session})};
  }});

  await payments.checkout('scan','partner50');
  const [couponCall,sessionCall] = calls;
  assert.equal(couponCall[0],'https://api.stripe.com/v1/coupons');
  assert.equal(couponCall[1].get('percent_off'),'50');
  assert.equal(couponCall[1].get('max_redemptions'),'1');
  // The discount is applied by Stripe; the browser never dictates the amount.
  assert.equal(sessionCall[1].get('line_items[0][price_data][unit_amount]'),'24900');
  assert.equal(sessionCall[1].get('discounts[0][coupon]'),'co_generated');
  assert.equal(sessionCall[1].get('allow_promotion_codes'),null);

  const paid = await payments.fulfill('cs_test_disc');
  assert.match(paid.token,/^[a-f0-9]{64}$/);
  assert.ok(store.resolve(paid.token));

  // A tampered subtotal is still refused, and a 100% code must not buy anything.
  session = {...session,id:'cs_test_bad',amount_subtotal:100,amount_total:50};
  store.saveCheckout('cs_test_bad','scan');
  await assert.rejects(payments.fulfill('cs_test_bad'),/does not match this report/);
  await assert.rejects(payments.checkout('scan','NOPE'),/not valid or has already been used/);
 } finally { store.close(); rmSync(dir,{recursive:true,force:true}); }
});

test('with no code, checkout leaves Stripe promotion codes available',async()=>{
 const {dir,store,env} = fixture('');
 let form;
 try {
  const payments = createPayments(store,{env,send:async()=>'id',coupons:createCoupons(store,{env}),
    fetchImpl:async(url,request)=>{ if(request.method==='POST') form=new URLSearchParams(request.body);
      return {ok:true,json:async()=>({id:'cs_test_plain',url:'https://checkout.stripe.com/x'})}; }});
  await payments.checkout('scan');
  assert.equal(form.get('allow_promotion_codes'),'true');
  assert.equal(form.get('discounts[0][coupon]'),null);
 } finally { store.close(); rmSync(dir,{recursive:true,force:true}); }
});
