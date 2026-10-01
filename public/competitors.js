let competitorBusy = false;
const scanOwners = new Map();
let competitorTimer;
function saveScanOwner(id, token) {
  scanOwners.set(id, token);
  try {sessionStorage.setItem('scan-owner:'+id,token);} catch {}
}
// report-delivery.js declares reportLinkToken and loads after this file, so a
// direct read can hit the temporal dead zone if a scan restores early.
function reportLink() {
  try { return typeof reportLinkToken === 'string' ? reportLinkToken : null; } catch { return null; }
}
function scanOwner(id) {
  try {return scanOwners.get(id) || sessionStorage.getItem('scan-owner:'+id);} catch {return scanOwners.get(id);}
}
async function competitorRequest(path, competitors) {
  const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({scanId:currentScanId,ownerToken:scanOwner(currentScanId),reportToken:reportLink()||undefined,competitors}),signal:AbortSignal.timeout(20000)});
  const data=await response.json();
  if(!response.ok) throw new Error(data.error || 'Unable to save competitors. Please try again.');
  return data;
}
function showCompetitorStatus(data) {
  const form=document.getElementById('competitor-form');
  if(!form) return;
  const busy=['queued','running'].includes(data.status);
  // Only a comparison that is actually running locks the form. A saved or
  // finished one stays editable so the merchant can correct a rival and run it
  // again, which the backend allows.
  competitorBusy=busy;
  const runsUsed=Number(data.runsUsed||0), runsAllowed=Number(data.runsAllowed||0);
  const spent=runsAllowed>0 && runsUsed>=runsAllowed;
  const inputs=[...form.querySelectorAll('input')];
  inputs.forEach(input=>{input.disabled=busy||spent;input.closest('label').hidden=false;});
  document.getElementById('competitor-add').hidden=busy||spent||inputs.length>=5;
  const save=document.getElementById('competitor-save');
  save.disabled=busy||spent;
  save.textContent=busy?'Preparing your comparison…'
    :spent?'No reruns left'
    :data.status==='ready'?'Compare again →'
    :data.status==='failed'?'Retry comparison →'
    :'Compare →';
  const left=runsAllowed>0 && !spent ? ` You can rerun the comparison ${runsAllowed-runsUsed} more time${runsAllowed-runsUsed===1?'':'s'}.` : '';
  document.getElementById('competitor-status').textContent=
    busy?'We’re scanning these stores. This can take several minutes. Checkout opens once the comparison is prepared.'
    :spent?'You have used every rerun for this report. Start a new scan to compare a different set of stores.'
    :data.status==='ready'
      ?(data.comparisonStatus==='unavailable'
        ?'These stores could not produce a usable comparison. Your full audit can still be purchased, but a competitor benchmark is unavailable for this selection.'+left
        :`Comparison prepared for ${data.comparedCount} usable competitors${data.comparisonStatus==='provisional'?' (provisional)':''}. Purchase the full report to see the results.`+left)
    :data.status==='failed'?'We couldn’t prepare the comparison. Edit the stores and run it again before continuing to checkout.'+left
    :'';
  form.dataset.selected=JSON.stringify(data.competitors);
  // Checkout waits only while a comparison is mid-flight.
  document.querySelectorAll('#paid-preview [data-view="full"]').forEach(button=>{button.disabled=busy;});
  clearTimeout(competitorTimer);
  if(busy) competitorTimer=setTimeout(restoreCompetitorSelection,5000);
}
async function restoreCompetitorSelection() {
  clearTimeout(competitorTimer);
  const form=document.getElementById('competitor-form');
  if(!form) return;
  competitorBusy=false;
  // A private report link authorises changes just as an owner token does, so a
  // client reading a report prepared for them can still pick competitors.
  if(!scanOwner(currentScanId) && !reportLink()) {
    form.querySelectorAll('input,button').forEach(el=>{el.disabled=true;});
    document.getElementById('competitor-status').textContent='Open this report from its private link to choose competitors, or start a new scan in this browser.';
    return;
  }
  form.querySelectorAll('input,button').forEach(el=>{el.disabled=false;});
  const id=currentScanId;
  try {
    const data=await competitorRequest('/api/competitors/status');
    if(id!==currentScanId || form!==document.getElementById('competitor-form'))return;
    while(form.querySelectorAll('input').length<data.competitors.length) addCompetitorField();
    if(data.competitors.length) form.querySelectorAll('input').forEach((input,i)=>{input.value=data.competitors[i] || '';});
    showCompetitorStatus(data);
  } catch(error) {
    if(id!==currentScanId || form!==document.getElementById('competitor-form'))return;
    document.getElementById('competitor-status').textContent=error.message;
    competitorTimer=setTimeout(restoreCompetitorSelection,10000);
  }
}
function addCompetitorField() {
  const fields=document.querySelector('.competitor-fields');
  const count=fields.querySelectorAll('input').length;
  if(count>=5)return;
  const label=document.createElement('label');
  const title=document.createElement('span');
  title.className='competitor-field-label';
  const number=document.createElement('span');
  number.className='competitor-number';number.textContent=`0${count+1}`;
  title.append(number,` Competitor ${count+1} (optional)`);label.append(title);
  const input=document.createElement('input');
  Object.assign(input,{name:'competitor',type:'text',inputMode:'url',placeholder:'e.g. anotherstore.com',maxLength:2048});
  label.append(input);fields.append(label);
  document.getElementById('competitor-add').hidden=count+1>=5;
}
document.getElementById('report').addEventListener('click',event=>{
  if(event.target.closest('#competitor-add')){addCompetitorField();document.querySelector('.competitor-fields label:last-child input').focus();}
});
document.getElementById('report').addEventListener('submit',async event=>{
  if(event.target.id!=='competitor-form')return;
  event.preventDefault();
  const form=event.target;
  const button=document.getElementById('competitor-save');
  if(button.disabled)return;
  // Read the fields as they stand, so an edit is what gets compared.
  const competitors=[...form.querySelectorAll('input')].map(input=>input.value.trim()).filter(Boolean);
  const id=currentScanId;
  button.disabled=true;competitorBusy=true;
  document.getElementById('competitor-status').textContent='Starting your comparison…';
  try {const data=await competitorRequest('/api/competitors',competitors);if(id===currentScanId && form===document.getElementById('competitor-form'))showCompetitorStatus(data);}
  catch(error) {if(id!==currentScanId || form!==document.getElementById('competitor-form'))return;button.disabled=false;competitorBusy=false;document.getElementById('competitor-status').textContent=error.message;}
});
