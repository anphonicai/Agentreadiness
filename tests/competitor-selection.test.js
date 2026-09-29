import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openReportStore,freeReport} from '../report-access.js';
import {validateCompetitors,createCompetitorWorker,queueConfiguredCompetitors} from '../competitor-selection.js';
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
    assert.throws(()=>store.queueCompetitors('scan',['https://c.example','https://d.example']),/before checkout/);
  } finally {store.close();rmSync(dir,{recursive:true,force:true});}
});

test('checkout locks competitor selection before the external Stripe request',()=>{
  const dir=mkdtempSync(join(tmpdir(),'competitor-lock-'));
  const store=openReportStore(join(dir,'reports.sqlite'));
  try {
    store.save('scan',fixture,{email:'test@example.com'});
    store.lockCompetitors('scan');
    assert.throws(()=>store.queueCompetitors('scan',['https://a.example','https://b.example']),/before starting checkout/);
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
    assert.throws(()=>store.queueCompetitors('scan',['https://c.example','https://d.example']),/already saved/);
    store.save('previously-paid',fixture,{email:'test@example.com'});
    const token=store.issue('previously-paid',{paymentReference:'existing-payment'});
    assert.throws(()=>store.queueCompetitors('previously-paid',domains),/before checkout/);
    assert.equal(store.resolve(token).result.finalScore,fixture.finalScore);
  } finally {store.close();rmSync(dir,{recursive:true,force:true});}
});


test('configured brand lists are queued automatically and new brands keep manual selection',()=>{
  const dir=mkdtempSync(join(tmpdir(),'competitor-defaults-'));
  const store=openReportStore(join(dir,'reports.sqlite'));
  const configured=JSON.parse(readFileSync(new URL('../competitors.json',import.meta.url)));
  try {
    for(const [domain,peers] of Object.entries(configured)) {
      store.save(domain,{...fixture,domain:'https://'+domain});
      assert.equal(queueConfiguredCompetitors(store,domain,'https://www.'+domain),true);
      assert.deepEqual(store.competitors(domain).domains,peers.map(p=>'https://'+p));
      assert.equal(queueConfiguredCompetitors(store,domain,domain),false);
    }
    store.save('new',fixture);
    assert.equal(queueConfiguredCompetitors(store,'new','new-client.example'),false);
    assert.equal(store.competitors('new'),null);
    store.queueCompetitors('new',validateCompetitors(['first.example','second.example'],'new-client.example'));
    assert.deepEqual(store.competitors('new').domains,['https://first.example','https://second.example']);
    store.save('custom',fixture);
    store.queueCompetitors('custom',['https://first.example','https://second.example']);
    assert.equal(queueConfiguredCompetitors(store,'custom','superyou.in'),false);
    assert.deepEqual(store.competitors('custom').domains,['https://first.example','https://second.example']);
  } finally {store.close();rmSync(dir,{recursive:true,force:true});}
});
