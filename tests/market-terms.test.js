import test from 'node:test';
import assert from 'node:assert/strict';
import {marketTerms} from '../engine.js';

// cleolifestyle.com is a US storefront whose report read "No COD signal on any
// of 15 sampled products" and asked about a "pincode". This wording has been
// flattened to India-only once already, so it is pinned here.
test('a non-Indian storefront is never described in Indian market terms', () => {
  for (const [country, currency] of [['US','USD'], ['GB','GBP'], ['AE','AED'], [null,'USD'], [null,'EUR']]) {
    const t = marketTerms(country, currency);
    assert.equal(t.indian, false, `${country}/${currency} should not be treated as Indian`);
    assert.equal(t.area, 'postcode');
    assert.doesNotMatch(t.payWords, /COD/, `${country}/${currency} payWords must not mention COD`);
    assert.doesNotMatch(t.paySignal, /COD/, `${country}/${currency} paySignal must not mention COD`);
  }
});

test('an Indian storefront keeps the terms its shoppers use', () => {
  for (const [country, currency] of [['IN','INR'], ['IN','USD'], [null,'INR']]) {
    const t = marketTerms(country, currency);
    assert.equal(t.indian, true, `${country}/${currency} should be treated as Indian`);
    assert.equal(t.area, 'pincode');
    assert.match(t.payWords, /COD/);
    assert.equal(t.paySignal, 'COD');
  }
});

test('the declared country wins over currency, which is only a fallback', () => {
  // A US store pricing in rupees is still a US store.
  assert.equal(marketTerms('US', 'INR').indian, false);
  // An Indian store pricing in dollars is still Indian.
  assert.equal(marketTerms('IN', 'USD').indian, true);
  // With no country at all, currency decides.
  assert.equal(marketTerms(null, 'INR').indian, true);
  assert.equal(marketTerms(undefined, undefined).indian, false);
});
