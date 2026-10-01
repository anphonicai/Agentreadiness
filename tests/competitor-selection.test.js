import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openReportStore,freeReport} from '../report-access.js';
import {validateCompetitors,createCompetitorWorker,suggestedCompetitors} from '../competitor-selection.js';
const fixture=JSON.parse(readFileSync(new URL('../reports/layer5/superyou.in.json',import.meta.url)));

test('competitor input rejects duplicate, self, nonpublic and out-of-range selections',()=>{
  assert.deepEqual(validateCompetitors(['a.example','https://b.example/products/x'],'client.example'),['https://a.example','https://b.example']);
  for(const values of [[],['a.example'],Array(6).fill('a.example'),['a.example','www.a.example'],['client.example','b.example'],['127.0.0.1','b.example'],['file:///etc/passwd','b.example']]) assert.throws(()=>validateCompetitors(values,'client.example'));
});

test('selection ownership and pending jobs persist; completed comparison stays paid-only',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'competitors-'));
  const file=join(dir,'reports.sqlite');
  let store=openReportStore(file);
  try {
    store.save('scan',fixture,{email:'test@example.com'});
    const token=store.createOwner('scan');
    assert.equal(store.owns('scan','wrong'),false);
    assert.equal(store.owns('different',token),false);
    store.queueCompetitors('scan',['https://a.example','https://b.example']);
    assert.throws(()=>store.issue('scan',{paymentReference:'test'}),/not ready/);
    store.close();store=openReportStore(file);
    assert.equal(store.owns('scan',token),true);
    assert.equal(store.pendingCompetitors().length,1);
    let scanned=0;
    const worker=createCompetitorWorker(store,{scan:async domain=>{scanned++;return {...fixture,domain};}});
    await worker();
    assert.equal(scanned,2);
    assert.equal(store.competitors('scan').status,'ready');
    assert.ok(store.get('scan').result.layer5Report);
    assert.equal(freeReport(store.get('scan').result).layer5Report,undefined);
    const paid=store.issue('scan',{paymentReference:'test'});
    assert.ok(store.resolve(paid).result.layer5Report);
    // Reselection after payment is allowed: a merchant who named the wrong
    // rival should not have to rescan their whole store to correct it.
    store.queueCompetitors('scan',['https://c.example','https://d.example']);
    assert.deepEqual(store.competitors('scan').domains,['https://c.example','https://d.example']);
    assert.equal(store.competitors('scan').status,'queued');
    // The already-delivered report still resolves while the rerun is pending.
    assert.ok(store.resolve(paid).result);
  } finally {store.close();rmSync(dir,{recursive:true,force:true});}
});

test('checkout refuses to proceed while a comparison is still running',()=>{
  const dir=mkdtempSync(join(tmpdir(),'competitor-lock-'));
  const store=openReportStore(join(dir,'reports.sqlite'));
  try {
    store.save('scan',fixture,{email:'test@example.com'});
    // Selecting competitors no longer freezes at checkout, but paying while a
    // comparison is mid-flight would buy a report that is still changing.
    store.queueCompetitors('scan',['https://a.example','https://b.example']);
    assert.throws(()=>store.lockCompetitors('scan'),/not ready yet/);
    store.competitorStatus('scan','ready');
    store.lockCompetitors('scan');
    // A locked report can still be recompared afterwards.
    store.queueCompetitors('scan',['https://c.example']);
    assert.deepEqual(store.competitors('scan').domains,['https://c.example']);
  } finally {store.close();rmSync(dir,{recursive:true,force:true});}
});

test('worker includes requests queued mid-scan and records unavailable peers without blocking paid access',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'competitor-worker-'));
  const store=openReportStore(join(dir,'reports.sqlite'));
  try {
    for(const id of ['first','second'])store.save(id,fixture,{email:'test@example.com'});
    store.queueCompetitors('first',['https://a.example','https://b.example']);
    let calls=0;
    const worker=createCompetitorWorker(store,{scan:async domain=>{
      calls++;
      if(calls===1)store.queueCompetitors('second',['https://c.example','https://d.example']);
      throw new Error('Store unavailable');
    }});
    await worker();
    assert.equal(calls,4);
    for(const id of ['first','second']){
      assert.equal(store.competitors(id).status,'ready');
      assert.equal(store.get(id).result.layer5Report.status,'unavailable');
      assert.doesNotThrow(()=>store.issue(id,{paymentReference:'test-payment'}));
    }
  } finally {store.close();rmSync(dir,{recursive:true,force:true});}
});

test('failed comparison can retry the same selection but existing paid reports cannot be changed',()=>{
  const dir=mkdtempSync(join(tmpdir(),'competitor-retry-'));
  const store=openReportStore(join(dir,'reports.sqlite'));
  try {
    store.save('scan',fixture,{email:'test@example.com'});
    const domains=['https://a.example','https://b.example'];
    store.queueCompetitors('scan',domains);
    store.competitorStatus('scan','failed');
    assert.throws(()=>store.issue('scan',{paymentReference:'paid'}),/not ready/);
    store.queueCompetitors('scan',domains);
    assert.equal(store.competitors('scan').status,'queued');
    // A different set cannot displace one that is still queued.
    assert.throws(()=>store.queueCompetitors('scan',['https://c.example','https://d.example']),/already running/);
    store.save('previously-paid',fixture,{email:'test@example.com'});
    const token=store.issue('previously-paid',{paymentReference:'existing-payment'});
    store.queueCompetitors('previously-paid',domains);
    assert.deepEqual(store.competitors('previously-paid').domains,domains);
    assert.equal(store.resolve(token).result.finalScore,fixture.finalScore);
  } finally {store.close();rmSync(dir,{recursive:true,force:true});}
});


test('configured brand lists are offered as suggestions and never scanned on their own',()=>{
  const dir=mkdtempSync(join(tmpdir(),'competitor-defaults-'));
  const store=openReportStore(join(dir,'reports.sqlite'));
  const configured=JSON.parse(readFileSync(new URL('../competitors.json',import.meta.url)));
  try {
    for(const [domain,peers] of Object.entries(configured)) {
      store.save(domain,{...fixture,domain:'https://'+domain});
      // The names are offered for the form to prefill, however the client
      // domain is written.
      assert.deepEqual(suggestedCompetitors('https://www.'+domain),peers.map(p=>'https://'+p));
      assert.deepEqual(suggestedCompetitors(domain),peers.map(p=>'https://'+p));
      // Nothing is queued: a scan must not crawl other people's storefronts
      // until the merchant presses Compare.
      assert.equal(store.competitors(domain),null);
    }
    // A brand with no configured list simply has no suggestions.
    assert.deepEqual(suggestedCompetitors('new-client.example'),[]);
    store.save('new',fixture);
    assert.equal(store.competitors('new'),null);

    // Pressing Compare is what queues a run, and the merchant's own choices win.
    store.queueCompetitors('new',validateCompetitors(['first.example','second.example'],'new-client.example'));
    assert.deepEqual(store.competitors('new').domains,['https://first.example','https://second.example']);
    assert.equal(store.competitors('new').status,'queued');
  } finally {store.close();rmSync(dir,{recursive:true,force:true});}
});


test('the comparison form stays editable and only a running comparison locks it', () => {
  const source = readFileSync(new URL('../public/competitors.js', import.meta.url), 'utf8');

  // Inputs were disabled the moment a selection existed, so a merchant could
  // never correct a rival even though the store allows reruns.
  assert.doesNotMatch(source, /input\.disabled\s*=\s*selected/,
    'inputs must not be disabled merely because a selection was saved');
  assert.match(source, /input\.disabled\s*=\s*busy\s*\|\|\s*spent/,
    'inputs lock only while running, or once reruns are spent');

  // The submitted set was read from a cached copy, so edits were discarded.
  assert.doesNotMatch(source, /form\.dataset\.selected && JSON\.parse/,
    'the submitted set must come from the fields, not a cached copy');
  assert.match(source, /const competitors=\[\.\.\.form\.querySelectorAll\('input'\)\]/,
    'the fields are the source of truth on submit');

  // Comparing is an explicit action, and checkout waits only while it runs.
  assert.match(source, /'Compare →'/);
  assert.match(source, /'Compare again →'/);
  assert.match(source, /\[data-view="full"\]'\)\.forEach\(button=>\{button\.disabled=busy;\}\)/,
    'checkout unlocks as soon as the comparison finishes');
});
