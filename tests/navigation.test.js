import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

test('history revisits public screens, preserves forward steps and excludes paid reports', () => {
  const nodes = new Map();
  function node(id) {
    if (!nodes.has(id)) {
      const classes = new Set(['hidden']);
      nodes.set(id, {innerHTML:'', handlers:{}, classList:{contains:c=>classes.has(c),add:c=>classes.add(c),remove:c=>classes.delete(c)}, addEventListener(type, handler) {this.handlers[type]=handler;}});
    }
    return nodes.get(id);
  }
  const events = {};
  const body = {dataset:{screen:'home'}};
  let observe;
  let cursor = 0;
  const states = [];
  const history = {
    replaceState(s) {states[cursor]=s;},
    pushState(s) {states.splice(++cursor);states[cursor]=s;},
    go(delta) {cursor+=delta;events.popstate({state:states[cursor]});},
    back() {this.go(-1);},forward() {this.go(1);},
  };
  const context = vm.createContext({
    document:{body,getElementById:node,addEventListener() {}},
    window:{addEventListener(type, fn) {events[type]=fn;}},
    history,location:{href:'http://localhost/'},
    setScreen(screen) {body.dataset.screen=screen;},
    MutationObserver:class {constructor(fn) {observe=fn;} observe() {}},
  });
  vm.runInContext(readFileSync(new URL('../public/navigation.js', import.meta.url),'utf8'),context);
  context.setScreen('consent');
  context.setScreen('verification');
  history.back();
  assert.equal(body.dataset.screen,'consent');
  assert.equal(node('journey-forward').disabled,false);
  history.forward();
  assert.equal(body.dataset.screen,'verification');
  const count=states.length;
  context.setScreen('report', {privateReport:true});
  node('full-detail').classList.remove('hidden');observe();
  assert.equal(states.length,count);
  assert.equal(node('journey-back').hidden,true);
  history.back();
  assert.equal(body.dataset.screen,'consent');
  assert.equal(node('full-detail').classList.contains('hidden'),true);
  assert.equal(node('journey-back').hidden,false);
});
