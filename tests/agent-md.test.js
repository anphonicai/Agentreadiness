import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectAgentMd, score} from '../engine.js';

const response = (status, body = '', contentType = 'text/plain') => ({status,body,contentType,ok:status >= 200 && status < 300});
test('agent.md distinguishes present, absent and unverifiable responses', () => {
  assert.equal(inspectAgentMd(response(200,'# Agent instructions')).status,'present');
  for (const status of [404,410]) assert.equal(inspectAgentMd(response(status)).status,'absent');
  assert.equal(inspectAgentMd(response(200,'  ')).status,'absent');
  for (const status of [0,403,429,500]) assert.equal(inspectAgentMd(response(status)).value,null);
  assert.equal(inspectAgentMd(response(200,'<!doctype html><html>Not found</html>')).value,null);
  assert.equal(inspectAgentMd(response(200,'Store home','text/html')).value,null);
  assert.equal(inspectAgentMd(response(200,'{}','application/json')).value,null);
});

test('agent.md appears in reports without changing any scores or recommendations', () => {
  const raw = {domain:'https://example.com',brandName:'Example',robots:{blocked:[]},errors:[],products:[{
    pageOk:true,title:'Example',url:'https://example.com/products/a',schema:{},
    htmlBytes:10000,ttfb:100,unitMentions:0,variantCount:1,
    optionNames:[],variantSample:[],brandForms:[],descFull:'',descSnippet:'',descWords:0,imageCount:0,
  }]};
  const baseline=score(raw);
  for (const agentMd of [inspectAgentMd(response(200,'# Instructions')),inspectAgentMd(response(404)),inspectAgentMd(response(403))]) {
    const result=score({...raw,agentMd});
    const check=result.layer2Report.checks.find(c=>c.key==='agentMd');
    assert.equal(check.value,agentMd.value);
    assert.equal(check.scored,false);
    assert.equal(check.informationalOnly,true);
    assert.equal(check.fix,null);
    assert.equal(check.costOfTotal,0);
    assert.equal(result.finalScore,baseline.finalScore);
    assert.deepEqual(result.layers,baseline.layers);
    assert.deepEqual(result.gaps,baseline.gaps);
  }
});
