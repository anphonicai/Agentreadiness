import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import { openLeadStore, validateLead, handleLeadRequest } from '../leads.js';

const input = { name: ' Alex Morgan ', email: 'Alex@Example.com', url: 'https://example.com/products/test', consent: true };

test('lead survives reopening; repeat submission updates without duplicates or false verification', () => {
  const dir = mkdtempSync(join(tmpdir(), 'leads-test-'));
  const filename = join(dir, 'leads.sqlite');
  let store;
  let db;
  try {
    store = openLeadStore(filename);
    store.save(input);
    store.close();
    store = openLeadStore(filename);
    store.save({ ...input, name: "Alex O'Connor", email: 'alex@example.com' });
    db = new DatabaseSync(filename);
    const rows = db.prepare('SELECT * FROM leads').all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, "Alex O'Connor");
    assert.equal(rows[0].email, 'alex@example.com');
    assert.equal(rows[0].store_url, 'https://example.com');
    assert.equal(rows[0].email_verified, 0);
    assert.equal(rows[0].consent_version, 'lead-capture-v1');
    assert.ok(Date.parse(rows[0].consent_at));
    assert.ok(Date.parse(rows[0].created_at));
    store.save({ ...input, url: 'https://another.example.com' });
    assert.equal(db.prepare('SELECT count(*) AS n FROM leads').get().n, 2);
  } finally { db?.close(); store?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('invalid lead data cannot be stored', () => {
  for (const override of [{name:''}, {name:'x'.repeat(121)}, {email:'bad'}, {email:[]}, {consent:false}, {consent:'true'}, {url:'invalid'}, {url:'https://user:pass@example.com'}, {url:'file:///tmp/test'}]) {
    assert.throws(() => validateLead({...input, ...override}));
  }
  assert.throws(() => validateLead(null));
});

async function request(body, store, type = 'application/json') {
  const req = Readable.from([Buffer.from(body)]);
  req.headers = {'content-type': type};
  const result = {};
  const res = { writeHead(status) { result.status = status; }, end(text) { result.body = JSON.parse(text); } };
  await handleLeadRequest(req, res, store);
  return result;
}

test('lead endpoint validates requests, limits size, and contains storage errors', async () => {
  let saved = 0;
  const store = {save() { saved++; }};
  assert.equal((await request('{', store)).status, 400);
  assert.equal((await request(JSON.stringify({...input,consent:false}), store)).status, 400);
  assert.equal((await request('x'.repeat(4097), store)).status, 413);
  assert.equal((await request(JSON.stringify(input), store, 'text/plain')).status, 415);
  assert.equal(saved, 0);
  assert.deepEqual(await request(JSON.stringify(input), store), {status:200, body:{saved:true}});
  assert.equal(saved, 1);
  const failed = await request(JSON.stringify(input), {save() {throw new Error('private database path');}});
  assert.equal(failed.status, 503);
  assert.ok(!failed.body.error.includes('private database path'));
});

test('contact enquiries persist company and email, reject invalid input, and contain database errors', async () => {
  const {handleEnquiryRequest} = await import('../leads.js');
  const dir = mkdtempSync(join(tmpdir(), 'enquiry-test-'));
  const filename = join(dir, 'leads.sqlite');
  let store = openLeadStore(filename);
  const enquiry = {...input, company:"Northstar & Co.", message:'Please review our store.'};
  const send = async (value, target = store) => {
    const req = Readable.from([Buffer.from(JSON.stringify(value))]);
    req.headers = {'content-type':'application/json'};
    const response = {};
    await handleEnquiryRequest(req, {writeHead(code) {response.code = code;}, end(body) {response.body = JSON.parse(body);}}, target);
    return response;
  };
  let db;
  try {
    assert.equal((await send(enquiry)).code, 201);
    assert.equal((await send({...enquiry, company:''})).code, 400);
    assert.equal((await send({...enquiry, email:'invalid'})).code, 400);
    assert.equal((await send(enquiry, {saveEnquiry() {throw new Error('private database details');}})).code, 503);
    store.close();
    store = openLeadStore(filename);
    db = new DatabaseSync(filename);
    const rows = db.prepare('SELECT * FROM contact_enquiries').all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].company_name, enquiry.company);
    assert.equal(rows[0].email, 'alex@example.com');
    assert.equal(rows[0].store_url, 'https://example.com');
    assert.equal(rows[0].message, enquiry.message);
    assert.equal(rows[0].status, 'new');
  } finally { db?.close(); store.close(); rmSync(dir, {recursive:true, force:true}); }
});
