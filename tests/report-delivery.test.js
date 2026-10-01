import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { openReportStore, freeReport, reportPreview } from '../report-access.js';
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

test('free value preview exposes observed fields and a headline but protects paid instructions', () => {
  const result=freeReport({...fixture,agentView:{title:'Sample product',fields:[
    {label:'Price',visible:true,value:'₹100',secret:'private'},
    {label:'Rating',visible:false,value:'private'},
    {label:'Private evidence',visible:true,value:'private'}
  ]},layer2Report:{checks:[{value:0,fix:{headline:'Improve product data',steps:['paid steps'],snippet:'paid code'}}]},layer3Report:null,layer4Report:null});
  assert.equal(result.preview.recommendationCount,1);
  assert.equal(result.preview.recommendationTitle,'Improve product data');
  assert.deepEqual(result.preview.product.fields,[{label:'Price',visible:true,value:'₹100'},{label:'Rating',visible:false,value:null}]);
  assert.ok(!JSON.stringify(result.preview).includes('private'));
  assert.ok(!JSON.stringify(result.preview).includes('paid steps'));
  assert.ok(!JSON.stringify(result.preview).includes('paid code'));
  assert.equal(freeReport({...fixture,agentView:null}).preview.product,null);
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

test('paid summary keeps the free report sections and stops selling the report', () => {
  const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
  const context={document:{getElementById:()=>({addEventListener(){}})},fetch:async()=>{throw new Error('offline');}};
  runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1],context);
  runInNewContext(readFileSync(new URL('../public/report.js',import.meta.url),'utf8'),context);
  const free=context.renderReport(freeReport(fixture));
  // The paid view carries the same summary block the free report renders from.
  const paid=context.renderReport({...fixture,preview:reportPreview(fixture)},{full:true});
  for(const section of ['report-product-preview','agent-gap','agent-thread']) {
    assert.ok(free.includes(section),`free report is missing ${section}`);
    assert.ok(paid.includes(section),`paid summary is missing ${section}`);
  }
  assert.match(free,/\$249/);
  assert.ok(!paid.includes('$249'));
  assert.ok(!paid.includes('report-deliverables'));
  assert.ok(!paid.includes('class="agent-fix"'));
  assert.match(paid,/Open full report/);
});

test('paid report shows informational fixes, readable schema labels and intact JSON-LD', () => {
  const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
  const context={document:{getElementById:()=>({addEventListener(){}})},fetch:async()=>{throw new Error('offline');}};
  runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1],context);
  const layer={checks:[{key:'imageCoverage',label:'Image coverage',value:20,scored:false,basis:'measured',result:'One image',evidence:{items:[]},fix:null}],score:50,sampleSize:1};
  const image=context.renderLayer2(layer);
  assert.match(image,/Add useful product images/);
  assert.match(image,/needs-attention/);
  assert.ok(!image.includes('nothing here to fix'));
  assert.ok(!image.includes('spec null'));
  assert.equal(context.reportText('FAQ/HowTo schema'), 'FAQ / How To Schema');
  const snippet='{"acceptedPaymentMethod":"Cash"}';
  layer.checks=[{key:'codPayment',label:'acceptedPaymentMethod',value:0,scored:true,basis:'state',fix:{headline:'Add acceptedPaymentMethod',where:'Offer',steps:['Declare acceptedPaymentMethod'],snippet}}];
  const payment=context.renderLayer2(layer);
  assert.match(payment,/Accepted Payment Method/);
  assert.match(payment,/&quot;acceptedPaymentMethod&quot;/);
  layer.checks=[{key:'faqSchema',label:'FAQ',value:50,scored:true,basis:'baseline'}];
  assert.ok(!context.renderLayer2(layer).includes('needs-attention'));
});

test('competitor entry belongs to free reports and never exposes benchmark results',()=>{
  const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
  const context={document:{getElementById:()=>({addEventListener(){}})},fetch:async()=>{throw new Error('offline');}};
  runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1],context);
  runInNewContext(readFileSync(new URL('../public/report.js',import.meta.url),'utf8'),context);
  const free=context.renderReport(freeReport(fixture));
  assert.match(free,/id="competitor-form"/);
  assert.match(free,/Results unlock after payment/);
  assert.ok(!free.includes('class="benchmark-stats"'));
  assert.ok(!context.renderReport(fixture,{full:true}).includes('id="competitor-form"'));
});

test('agent question is built from the scan, stays stable per store and varies between stores', () => {
  const scan = (domain, check, title = 'Detan and Soothe') => ({
    domain, finalScore: 60, layers: {}, gaps: [{layer: 'layer3', check}],
    agentView: {title, fields: [
      {label: 'Price', visible: true}, {label: 'SKU', visible: false},
      {label: 'Rating', visible: false}, {label: 'Images', visible: false},
    ]},
  });
  const ask = (domain, check) => freeReport(scan(domain, check)).preview.agentAsk;

  // The product name comes from the scan, never a fixture.
  assert.match(ask('https://a.com', 'codPayment').question, /Detan and Soothe/);

  // Same store always reads the same question.
  assert.equal(ask('https://a.com', 'codPayment').question, ask('https://a.com', 'codPayment').question);

  // Different stores with the same gap do not all read identical copy.
  const domains = ['a.com','b.com','c.com','d.com','e.com','f.com','g.com','h.com','i.com','j.com','k.com','l.com'];
  const asked = new Set(domains.map(d => ask(`https://${d}`, 'codPayment').question));
  assert.ok(asked.size >= 2, `expected varied phrasing, got ${asked.size}`);

  // Each gap type asks about its own failure, and unknown keys fall back safely.
  assert.match(ask('https://a.com', 'serviceability').question, /deliver|reach|ship/i);
  assert.match(ask('https://a.com', 'factualDensity').question, /made of|dimensions|made from/i);
  assert.equal(ask('https://a.com', 'nonexistentCheck').missing, 'complete Product schema');
  assert.equal(freeReport({...scan('https://a.com','codPayment'), gaps: []}).preview.agentAsk.missing, 'complete Product schema');

  // The note may only name fields the free evidence table also lists.
  assert.deepEqual(ask('https://a.com', 'codPayment').unreadable, ['SKU', 'Rating']);

  // No sampled product means no fabricated conversation.
  assert.equal(freeReport({domain: 'https://a.com', finalScore: 60, layers: {}, gaps: []}).preview.agentAsk, null);
});

test('the sampled product links back only to the scanned store', () => {
  const scan = url => reportPreview({
    domain: 'https://shop.example', gaps: [], layer2Report: {checks: []},
    agentView: {title: 'A product', url, fields: [{label: 'Price', value: '10', visible: true}]},
  }).product;

  // A real product page on the scanned store is linked.
  assert.equal(scan('https://shop.example/products/thing').url, 'https://shop.example/products/thing');
  // www is the same store.
  assert.equal(scan('https://www.shop.example/products/thing').url, 'https://www.shop.example/products/thing');

  // Anything pointing elsewhere, or not a web URL, is dropped rather than rendered.
  for (const bad of ['https://evil.example/products/x', 'javascript:alert(1)', 'data:text/html,<script>', 'not a url', '', null, undefined]) {
    assert.equal(scan(bad).url, null, `expected ${String(bad)} to be rejected`);
  }

  // The title still renders when no usable link exists.
  assert.equal(scan(null).title, 'A product');
});

test('a live private report link authorises competitor changes for that report only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'owns-link-'));
  const store = openReportStore(join(dir, 'reports.sqlite'));
  try {
    store.save('scan-a', {domain:'https://a.test', finalScore:70}, {email:'a@example.com'});
    store.save('scan-b', {domain:'https://b.test', finalScore:60}, {email:'b@example.com'});
    const paid = store.issue('scan-a', {paymentReference:'pay_1'});
    const preview = store.issue('scan-a', {preview:true});

    // The report's own paid link authorises it. Reports prepared for a client
    // have no owner token in that client's browser.
    assert.equal(store.ownsViaLink('scan-a', paid), true);
    assert.equal(store.owns('scan-a', paid), false);

    // It must not reach another report, and a preview link is not enough.
    assert.equal(store.ownsViaLink('scan-b', paid), false);
    assert.equal(store.ownsViaLink('scan-a', preview), false);

    // Nothing malformed, expired or revoked gets through.
    for (const bad of ['', 'nope', null, undefined, 'z'.repeat(64)]) {
      assert.equal(store.ownsViaLink('scan-a', bad), false, `expected ${String(bad)} to be refused`);
    }
    assert.equal(store.ownsViaLink('scan-a', paid, {now: Date.now() + 31 * 24 * 60 * 60 * 1000}), false);
    store.revoke(paid);
    assert.equal(store.ownsViaLink('scan-a', paid), false);
  } finally { store.close(); rmSync(dir, {recursive:true, force:true}); }
});
