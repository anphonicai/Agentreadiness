import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

// The sampler is internal to the scan, so exercise it directly from source
// rather than reshaping engine.js around the test.
const source = readFileSync(new URL('../engine.js', import.meta.url), 'utf8');
const pick = name => {
  let start = source.indexOf(`function ${name}(`);
  assert.ok(start > -1, `${name} not found`);
  // Keep the async keyword when the declaration carries one.
  if (source.slice(Math.max(0, start - 6), start) === 'async ') start -= 6;
  const open = source.indexOf('{', start);
  let depth = 0, i = open;
  for (; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}' && (depth -= 1) === 0) break;
  }
  return source.slice(start, i + 1);
};
const context = {};
runInNewContext(`${pick('bestSellingHandles')}\n${pick('bestSellerSample')}`, context);
const {bestSellingHandles, bestSellerSample} = context;

const catalogue = Array.from({length: 40}, (_, i) => ({handle: `product-${i + 1}`}));
const page = handles => ({ok: true, body: handles.map(h => `<a href="/products/${h}">x</a>`).join('')});

test('bestseller handles are read in page order, without duplicates', () => {
  const html = '<a href="/products/beta">b</a><a href="/products/alpha">a</a><a href="/products/beta">b again</a>';
  assert.deepEqual(Array.from(bestSellingHandles(html)), ['beta', 'alpha']);
  assert.deepEqual(Array.from(bestSellingHandles('<p>no products here</p>')), []);
});

test('sampling follows the store sales order and stops at the sample size', async () => {
  const order = ['product-9','product-3','product-40','product-1','product-22','product-7'];
  const sample = await bestSellerSample('https://s.test', catalogue, 4, async () => page(order));
  assert.deepEqual(Array.from(sample, p => p.handle), ['product-9','product-3','product-40','product-1']);
});

test('a second page is read only when the first does not fill the sample', async () => {
  const seen = [];
  const sample = await bestSellerSample('https://s.test', catalogue, 8, async url => {
    seen.push(url);
    return page(url.includes('page=2') ? ['product-11','product-12','product-13'] : ['product-1','product-2','product-3','product-4','product-5']);
  });
  assert.equal(seen.length, 2);
  assert.ok(seen[1].includes('page=2'));
  assert.equal(sample.length, 8);

  const once = [];
  await bestSellerSample('https://s.test', catalogue, 3, async url => {
    once.push(url);
    return page(['product-1','product-2','product-3','product-4']);
  });
  assert.equal(once.length, 1, 'a full first page must not trigger pagination');
});

test('unreadable, empty or unmatched listings fall back rather than guessing', async () => {
  const blocked = await bestSellerSample('https://s.test', catalogue, 20, async () => ({ok: false, body: ''}));
  assert.equal(blocked, null);

  const jsRendered = await bestSellerSample('https://s.test', catalogue, 20, async () => ({ok: true, body: '<div id="app"></div>'}));
  assert.equal(jsRendered, null);

  // Links that match no catalogue product (a themed listing of other pages).
  const foreign = await bestSellerSample('https://s.test', catalogue, 20, async () => page(['not-in-catalogue','also-missing']));
  assert.equal(foreign, null);

  const empty = await bestSellerSample('https://s.test', [], 20, async () => page(['product-1']));
  assert.equal(empty, null);
});

test('a small catalogue still samples by sales order', async () => {
  const tiny = [{handle: 'a'}, {handle: 'b'}, {handle: 'c'}, {handle: 'd'}, {handle: 'e'}];
  const sample = await bestSellerSample('https://s.test', tiny, 20, async () => page(['e','d','c','b','a']));
  assert.deepEqual(Array.from(sample, p => p.handle), ['e','d','c','b','a']);
});
