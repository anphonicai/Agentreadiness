import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { openReportStore, freeReport } from '../report-access.js';
import { reportEmail, sendReportEmail } from '../report-email.js';
const fixture = JSON.parse(readFileSync(new URL('../reports/layer5/superyou.in.json',import.meta.url)));

test('free response excludes paid details at every level and ignores future fields', () => {
  const result = freeReport({...fixture, secretFutureField:'private'});
  assert.equal(result.finalScore,fixture.finalScore);
  assert.equal(result.gaps.length,Math.min(3,fixture.gaps.length));
  for(const key of ['layer2Report','layer3Report','layer4Report','layer5Report','agentView','speed','specDetail','secretFutureField']) assert.equal(result[key],undefined);
  assert.ok(Object.values(result.layers).every(l=>!l.checks));
  assert.ok(result.gaps.every(g=>Object.keys(g).sort().join(',')==='layer,message'));
});

test('private links survive restart, enforce preview isolation, expiry and revocation', () => {
  const dir=mkdtempSync(join(tmpdir(),'report-delivery-'));
  let store;
  try {
    const filename=join(dir,'reports.sqlite');
    store=openReportStore(filename);
    store.save('scan',fixture,{name:'Alex',email:'alex@example.com'});
    assert.throws(()=>store.issue('scan'),/payment reference/);
    const preview=store.issue('scan',{preview:true});
    const paid=store.issue('scan',{paymentReference:'verified-test-payment'});
    assert.equal(store.resolve(preview),null);
    assert.equal(store.resolve(preview,{allowPreview:true}).preview,true);
    assert.equal(store.resolve('scan'),null);
    assert.equal(store.resolve('a'.repeat(64)),null);
    store.close();store=openReportStore(filename);
    assert.equal(store.resolve(paid).result.domain,fixture.domain);
    assert.equal(store.resolve(paid,{now:Date.now()+31*86400000}),null);
    store.revoke(paid);assert.equal(store.resolve(paid),null);
  }finally{store?.close();rmSync(dir,{recursive:true,force:true});}
});

test('email is branded, escapes contact data, and contains private report CTA', () => {
  const mail=reportEmail({name:'<script>alert(1)</script>',domain:'https://superyou.in',reportUrl:'https://commerce.anphonic.ai/?report=secret',preview:true});
  assert.ok(mail.html.includes('Commerce.Anphonic.ai'));
  assert.ok(mail.html.includes('View your report'));
  assert.ok(mail.html.includes('LOCAL EMAIL PREVIEW'));
  assert.ok(!mail.html.includes('<script>'));
  assert.ok(mail.text.includes('https://commerce.anphonic.ai/?report=secret'));
  assert.throws(()=>reportEmail({domain:'https://superyou.in',reportUrl:'javascript:alert(1)'}));
});

test('email provider requires configuration and handles rejected delivery', async () => {
  const args={to:'alex@example.com',email:{subject:'Report',text:'Text',html:'<p>Report</p>'},idempotencyKey:'test'};
  await assert.rejects(sendReportEmail(args,{apiKey:'',from:''}),/Configure/);
  let payload;
  const opts={apiKey:'test-key',from:'reports@example.com',fetchImpl:async(url,request)=>{payload=JSON.parse(request.body);return {ok:true,json:async()=>({id:'message-id'})};}};
  assert.equal(await sendReportEmail(args,opts),'message-id');
  assert.equal(payload.from,'Commerce.Anphonic.ai <reports@example.com>');
  assert.deepEqual(payload.to,['alex@example.com']);
  await assert.rejects(sendReportEmail(args,{...opts,fetchImpl:async()=>({ok:false,json:async()=>({error:'rejected'})})}),/did not accept/);
});

test('free UI never renders the hidden paid report; authorized view renders saved findings', () => {
  const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
  const context={document:{getElementById:()=>({addEventListener(){}})},fetch:async()=>{throw new Error('offline');}};
  runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1],context);
  runInNewContext(readFileSync(new URL('../public/report.js',import.meta.url),'utf8'),context);
  const free=context.renderReport(freeReport(fixture));
  assert.ok(!free.includes('id="full-detail"'));
  const full=context.renderReport(fixture,{full:true});
  assert.ok(full.includes('id="full-detail"'));
  assert.ok(full.includes('Private report · Commerce.Anphonic.ai'));
});
