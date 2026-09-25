import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { normalizeStoreUrl, handleStoreRequest } from '../store-url.js';

test('normalizes storefront URLs; rejects unsupported input', () => {
  assert.equal(normalizeStoreUrl('  Example.com/products/test?q=1#details  '), 'https://example.com');
  assert.equal(normalizeStoreUrl('https://shop.myshopify.com/'), 'https://shop.myshopify.com');
  for (const value of [null, {}, '', 'not a url', 'localhost', '127.0.0.1', 'http://127.1', 'https://shop.local', 'ftp://example.com', 'https://user:pass@example.com', 'https://example.com:8080', 'https://-bad.example.com', 'a'.repeat(2049)]) {
    assert.throws(() => normalizeStoreUrl(value));
  }
});

test('first-page API validates JSON and returns only normalized URL', async () => {
  async function request(body, type = 'application/json') {
    const req = Readable.from([Buffer.from(body)]);
    req.headers = {'content-type':type};
    const result = {};
    await handleStoreRequest(req, {
      writeHead(status) {result.status = status;},
      end(body) {result.body = JSON.parse(body);},
    });
    return result;
  }
  assert.deepEqual(await request(JSON.stringify({url:'example.com/path'})), {status:200, body:{url:'https://example.com'}});
  assert.equal((await request('{')).status, 400);
  assert.equal((await request('{}')).status, 400);
  assert.equal((await request('x'.repeat(4097))).status, 413);
  assert.equal((await request('{}', 'text/plain')).status, 415);
});

test('first page waits for backend, prevents duplicate submits, and recovers from errors', async () => {
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) elements.set(id, {value:'',disabled:false,textContent:'',attrs:{},classList:{add(){},remove(){}},addEventListener(){},setAttribute(k,v){this.attrs[k]=v;},removeAttribute(k){delete this.attrs[k];},focus(){this.focused=true;}});
    return elements.get(id);
  };
  let resolveRequest;
  let calls = 0;
  let screen = 'home';
  const context = {
    $:get, document:{querySelectorAll:()=>[]},
    clearError(){}, showError(msg){get('err').textContent=msg;screen='home';},
    setScreen(value){screen=value;}, AbortSignal,
    fetch:()=>{calls++;return new Promise(resolve=>{resolveRequest=resolve;});},
  };
  runInNewContext(await readFile(new URL('../public/journey.js',import.meta.url),'utf8'),context);
  const first = context.beginJourney('example.com');
  await context.beginJourney('example.com');
  assert.equal(calls,1);
  assert.equal(screen,'home');
  assert.equal(get('go').disabled,true);
  resolveRequest({ok:true,json:async()=>({url:'https://example.com'})});
  await first;
  assert.equal(screen,'consent');
  assert.equal(get('url').value,'https://example.com');
  assert.equal(get('go').disabled,false);
  context.fetch = async()=>({ok:false,json:async()=>({error:'Invalid store URL'})});
  await context.beginJourney('bad');
  assert.equal(screen,'home');
  assert.equal(get('err').textContent,'Invalid store URL');
  assert.equal(get('go').disabled,false);
  assert.equal(get('url').attrs['aria-invalid'],'true');
  assert.equal(get('url').focused,true);
});

test('names match known stores; unknown names require explicit URL confirmation', async () => {
  const {resolveStoreInput} = await import('../store-url.js');
  const stores = [{domain:'https://homeecstasy.com',brandName:'Home Ecstasy'}, {domain:'https://auravedic.com',brandName:'Auravedic'}];
  assert.deepEqual(resolveStoreInput('Home Ecstasy',stores), {url:'https://homeecstasy.com'});
  assert.deepEqual(resolveStoreInput('auravedic',stores), {url:'https://auravedic.com'});
  assert.deepEqual(resolveStoreInput('New Brand',stores), {url:'https://newbrand.com',needsConfirmation:true});
  assert.deepEqual(resolveStoreInput('https://example.in',stores), {url:'https://example.in'});
  assert.throws(()=>resolveStoreInput('Auravedic',[...stores,{domain:'https://auravedic.in',brandName:'Auravedic'}]), /More than one/);
});
