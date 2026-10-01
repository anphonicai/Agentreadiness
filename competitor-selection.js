import {normalizeStoreUrl} from './store-url.js';
import {domainKey, buildCompetitiveReport, COMPETITORS} from './competitive.js';
import {scanStore} from './engine.js';

export function validateCompetitors(values, client) {
  if (!Array.isArray(values) || values.length < 2 || values.length > 5) throw new Error('Enter 2–5 competitor store URLs.');
  const urls=values.map(normalizeStoreUrl);
  const names=urls.map(domainKey);
  if(new Set(names).size!==names.length) throw new Error('Enter a different store for each competitor.');
  if(names.includes(domainKey(client))) throw new Error('Your own store cannot be a competitor.');
  return urls;
}

// The configured rivals are a starting point for the merchant, not a decision
// taken for them. They are offered as prefilled, editable fields; nothing is
// scanned until Compare is pressed, because each run crawls other people's
// storefronts and the merchant may not want these stores at all.
export function suggestedCompetitors(client) {
  const defaults=COMPETITORS[domainKey(client)];
  if(!defaults) return [];
  try { return validateCompetitors(defaults,client); } catch { return []; }
}

export function createCompetitorWorker(store, {scan=scanStore}={}) {
  let running=false;
  return async function drain() {
    if(running) return;
    running=true;
    try {
      for(const {report_id:id} of store.pendingCompetitors()) {
        try {
          const request=store.competitors(id);
          const client=store.get(id).result;
          store.competitorStatus(id,'running');
          const peers=[];
          for(const url of request.domains) {
            try {peers.push(await scan(url,()=>{}, {contentMethod:'heuristic'}));}
            catch {peers.push({domain:url,finalScore:null,errors:['Competitor scan unavailable']});}
          }
          store.completeCompetitors(id,buildCompetitiveReport(client,peers,request.domains));
        } catch {store.competitorStatus(id,'failed');}
      }
    } finally {running=false;}
    // Include requests submitted while this batch was running.
    if(store.pendingCompetitors().length) return drain();
  };
}
