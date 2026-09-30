import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {unscannable} from '../engine.js';

test('a store whose product pages all fail is never scored', () => {
  // shop.truvani.com served a full products.json while every /products/<handle>
  // returned 404. Scoring that produced zeros on every schema check.
  const allFailed = {products: [{pageOk: false}, {pageOk: false}], errors: []};
  assert.equal(unscannable(allFailed), 'NO_PRODUCT_PAGES');

  // One readable page is enough to score: the sample is thin, not absent.
  assert.equal(unscannable({products: [{pageOk: false}, {pageOk: true}], errors: []}), null);
  assert.equal(unscannable({products: [{pageOk: true}], errors: []}), null);
});

test('fatal collection errors stop a score being published', () => {
  for (const e of ['NO_RESPONSE', 'NOT_SHOPIFY', 'NO_CATALOG']) {
    assert.equal(unscannable({products: [{pageOk: true}], errors: [e]}), e);
  }
  // A non-fatal note alongside readable pages still scores.
  assert.equal(unscannable({products: [{pageOk: true}], errors: ['BLOCKED_403']}), null);
  // Nothing collected at all.
  assert.equal(unscannable({errors: ['NO_RESPONSE']}), 'NO_RESPONSE');
  assert.equal(unscannable({products: [], errors: []}), null);
});

test('review apps are detected by their asset, not their name in prose', () => {
  const source = readFileSync(new URL('../engine.js', import.meta.url), 'utf8');
  const cut = (a, b) => { const i = source.indexOf(a); return source.slice(i, source.indexOf(b, i) + b.length); };
  const ctx = {};
  runInNewContext([
    cut('const REVIEW_APPS = [', '];'),
    cut('const DISABLED_FLAG =', ';'),
    cut('const withoutDisabledFlags =', ';'),
    'this.REVIEW_APPS = REVIEW_APPS; this.withoutDisabledFlags = withoutDisabledFlags;',
  ].join('\n'), ctx);
  const detect = html => Array.from(ctx.REVIEW_APPS.filter(a => a.re.test(ctx.withoutDisabledFlags(html))), a => a.key);

  assert.deepEqual(detect('<script src="https://cdn.judge.me/loader.js"></script>'), ['Judge.me']);
  assert.deepEqual(detect('<script src="https://staticw2.yotpo.com/x/widget.js"></script>'), ['Yotpo']);
  // The app name is quoted back in the merchant's recommendation, so prose,
  // comparison links and disabled flags must not register as installed.
  assert.deepEqual(detect('We compared Yotpo and Junip before choosing.'), []);
  assert.deepEqual(detect('"growave_enabled":false'), []);
  assert.deepEqual(detect('Read our Trustpilot reviews policy page'), []);
});
