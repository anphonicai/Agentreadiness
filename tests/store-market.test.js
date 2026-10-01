import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {storefrontMarket, reportCurrency, observedOfferPrice, score} from '../engine.js';

test('Shopify market detection reads explicit US and Indian currency, including single quotes', () => {
  assert.deepEqual(storefrontMarket(`Shopify.currency = {"active":"USD","rate":"1"}; Shopify.country = "US";`), {currency:'USD',country:'US'});
  assert.deepEqual(storefrontMarket(`Shopify.currency = {active:'INR'}; Shopify.country = 'IN';`), {currency:'INR',country:'IN'});
  assert.deepEqual(storefrontMarket(`{"countryCode":"IN"} $29.00`), {currency:null,country:null});
});

test('missing currency stays unknown and mixed offers do not inherit the first currency', () => {
  assert.equal(reportCurrency([], null), null);
  assert.equal(reportCurrency([], 'USD'), 'USD');
  assert.equal(reportCurrency([{offerCurrency:'USD'}], 'INR'), 'USD');
  assert.equal(reportCurrency([{offerCurrency:'USD'}, {offerCurrency:'INR'}], 'USD'), null);
});

test('prices and currency come from the same offer, never a differently priced catalogue', () => {
  assert.deepEqual(observedOfferPrice({price:'2400',offerPrice:'29',offerCurrency:'USD'}), {price:'29',priceCurrency:'USD'});
  assert.deepEqual(observedOfferPrice({price:'29',offerPrice:'2400',offerCurrency:'INR'}), {price:'2400',priceCurrency:'INR'});
  assert.deepEqual(observedOfferPrice({offerPrice:0,offerCurrency:'USD'}), {price:0,priceCurrency:'USD'});
  assert.equal(observedOfferPrice({price:'29',offerCurrency:'USD'}).priceCurrency, 'REPLACE_WITH_VERIFIED_CURRENCY');
});

test('unknown currency is explained in the rendered report', () => {
  const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
  const context={document:{getElementById:()=>({addEventListener(){}})}};
  runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1],context);
  const report=context.renderLayer2({checks:[],currency:null});
  assert.match(report,/Unknown or multiple currencies/);
  assert.ok(!report.includes('in null'));
});


test('generated US, Indian and unknown-market reports do not invent checkout settings', () => {
  for (const [country, currency] of [['US','USD'], ['IN','INR'], [null,null]]) {
    const result=score({domain:'https://example.com',brandName:'Example',country,currency,
      robots:{blocked:[]},errors:[],products:[{
        htmlBytes:10000,ttfb:100,unitMentions:0,variantCount:1,pageOk:true,title:'Example',url:'https://example.com/products/a',schema:{price:true},
        price:'999',offerPrice:currency ? '29' : null,offerCurrency:currency,
        optionNames:[],variantSample:[],brandForms:[],descFull:'',descSnippet:'',descWords:0,imageCount:0,
      }]});
    assert.equal(result.currency,currency);
    assert.equal(result.layer2Report.currency,currency);
    const price=result.agentView.fields.find(f=>f.label==='Price');
    assert.equal(price.value,currency ? `${currency} 29` : null);
    const payment=JSON.parse(result.layer3Report.checks.find(c=>c.key==='codPayment').fix.snippet);
    assert.equal(payment.priceCurrency,currency || 'REPLACE_WITH_VERIFIED_CURRENCY');
    assert.equal(payment.acceptedPaymentMethod[0].name,'REPLACE_WITH_VERIFIED_ACCEPTED_METHOD');
    const shipping=JSON.parse(result.layer3Report.checks.find(c=>c.key==='serviceability').fix.snippet);
    assert.equal(shipping.shippingDetails.shippingDestination.addressCountry,'REPLACE_WITH_VERIFIED_DESTINATION_COUNTRY');
    assert.equal(typeof shipping.shippingDetails.deliveryTime.handlingTime.minValue,'string');
  }
});
