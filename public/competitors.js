let competitorBusy = false;
const scanOwners = new Map();
let competitorTimer;
function saveScanOwner(id, token) {
  scanOwners.set(id, token);
  try {sessionStorage.setItem('scan-owner:'+id,token);} catch {}
}
function scanOwner(id) {
  try {return scanOwners.get(id) || sessionStorage.getItem('scan-owner:'+id);} catch {return scanOwners.get(id);}
}
async function competitorRequest(path, competitors) {
  const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({scanId:currentScanId,ownerToken:scanOwner(currentScanId),competitors}),signal:AbortSignal.timeout(20000)});
  const data=await response.json();
  if(!response.ok) throw new Error(data.error || 'Unable to save competitors. Please try again.');
  return data;
}
function showCompetitorStatus(data) {
  const form=document.getElementById('competitor-form');
  if(!form) return;
  const selected=data.status!=='none';
  const busy=['queued','running'].includes(data.status);
  competitorBusy=busy || data.status==='failed';
  form.querySelectorAll('input').forEach((input,index)=>{input.disabled=selected;input.closest('label').hidden=selected && index>=data.competitors.length;});
  document.getElementById('competitor-add').hidden=selected || form.querySelectorAll('input').length>=5;
  const save=document.getElementById('competitor-save');
  save.disabled=busy || data.status==='ready';
  save.textContent=data.status==='ready'?'Comparison ready':data.status==='failed'?'Retry comparison →':busy?'Preparing your comparison…':'Save competitors →';
  document.getElementById('competitor-status').textContent=busy?'Your competitors are saved. We’re scanning their stores. This can take several minutes. Checkout will be available when the comparison is prepared.':data.status==='ready'?(data.comparisonStatus==='unavailable'?'These stores could not produce a usable comparison. Your full audit can still be purchased, but a competitor benchmark is unavailable for this selection.':`Comparison prepared for ${data.comparedCount} usable competitors${data.comparisonStatus==='provisional'?' (provisional)':''}. Purchase the full report to see the results.`):data.status==='failed'?'We couldn’t prepare the comparison. Retry before continuing to checkout.':'';
  form.dataset.selected=JSON.stringify(data.competitors);
  document.querySelectorAll('#paid-preview [data-view="full"]').forEach(button=>{button.disabled=competitorBusy;});
  clearTimeout(competitorTimer);
  if(busy) competitorTimer=setTimeout(restoreCompetitorSelection,5000);
}
async function restoreCompetitorSelection() {
  clearTimeout(competitorTimer);
  const form=document.getElementById('competitor-form');
  if(!form) return;
  competitorBusy=false;
  if(!scanOwner(currentScanId)) {
    form.querySelectorAll('input,button').forEach(el=>{el.disabled=true;});
    document.getElementById('competitor-status').textContent='To choose competitors, start a new scan in this browser before checkout.';
    return;
  }
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
  const competitors=form.dataset.selected && JSON.parse(form.dataset.selected).length ? JSON.parse(form.dataset.selected) : [...form.querySelectorAll('input')].map(input=>input.value.trim()).filter(Boolean);
  const id=currentScanId;
  button.disabled=true;competitorBusy=true;
  document.getElementById('competitor-status').textContent='Saving your competitors…';
  try {const data=await competitorRequest('/api/competitors',competitors);if(id===currentScanId && form===document.getElementById('competitor-form'))showCompetitorStatus(data);}
  catch(error) {if(id!==currentScanId || form!==document.getElementById('competitor-form'))return;button.disabled=false;competitorBusy=false;document.getElementById('competitor-status').textContent=error.message;}
});
