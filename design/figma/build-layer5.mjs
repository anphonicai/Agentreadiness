import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const out = resolve('design/figma');
const domains = ['baccabucci.com', 'superyou.in', 'twobrothersindiashop.com', 'kalkifashion.com', 'dashanddot.com'];
const names = {'baccabucci.com':'Bacca Bucci','superyou.in':'SuperYou','twobrothersindiashop.com':'Two Brothers','kalkifashion.com':'Kalki Fashion','dashanddot.com':'Dash and Dot'};
const c = {ink:'#080a0a',muted:'#626b6b',line:'#e1e5e5',teal:'#157777',accent:'#30b4b7',pale:'#edf8f8',amber:'#806313',amberBg:'#fcf7e8',red:'#ab4840'};
const esc = s => String(s ?? '').replace(/[<>&"]/g,ch=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[ch]));
let parts=[];
function rect(x,y,w,h,fill='#fff',stroke='none',rx=0){parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}" stroke="${stroke}" rx="${rx}"/>`);}
function text(x,y,s,size=14,fill=c.ink,weight=400,anchor='start'){parts.push(`<text x="${x}" y="${y}" font-family="Rethink Sans, Arial, sans-serif" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}" fill="${fill}">${esc(s)}</text>`);}
function line(x,y,w){rect(x,y,w,1,c.line);}
function wrap(x,y,s,max=110,size=14,fill=c.muted,weight=400){let current='';for(const word of s.split(/\s+/)){if((current+' '+word).trim().length>max){text(x,y,current,size,fill,weight);y+=size*1.5;current=word;}else current=(current+' '+word).trim();}if(current)text(x,y,current,size,fill,weight);return y+size*1.5;}
function pill(x,y,label,complete=true){const w=label.length*7+24;rect(x,y,w,26,complete?c.pale:c.amberBg);text(x+12,y+17,label,10,complete?c.teal:c.amber,600);}
const num=n=>Number.isFinite(n)?Math.round(n*10)/10:'—';
const blocks=[];
for(const domain of domains){
 parts=[];
 const r=JSON.parse(await readFile(`reports/layer5/${domain}.json`,'utf8'));
 const L=r.layer5Report, complete=L.status==='complete';
 const width=1200, left=64, inner=1072;
 rect(0,0,width,2050,'#fff');
 text(left,60,'anphonic',32,c.ink,700);text(width-left,55,'AI COMMERCE INTELLIGENCE',11,c.muted,500,'end');line(left,90,inner);
 text(left,132,'AGENT READINESS REPORT',11,c.teal,600);
 text(left,175,`${names[domain]} · Paid audit`,32,c.ink,700);
 text(left,201,`${domain}   /   Scanned 18 September 2026`,13,c.muted);
 text(left,251,'Free report',14,c.muted);text(left+136,251,'Full audit',14,c.ink,700);pill(width-left-116,232,'PAID REPORT');line(left,265,inner);rect(left+136,263,64,3,c.accent);
 rect(left,290,inner,112,'#f6f8f8',c.line);text(left+22,321,'Layer 4 — Content clarity',17,c.ink,700);text(width-left-24,323,`${num(r.layers.layer4.score)}/100`,20,c.teal,700,'end');
 const l4Labels=['Answer-first descriptions','Factual density','Consistent entity naming'];const l4Values=['answerFirst','factualDensity','entityConsistency'];
 for(let i=0;i<3;i++){const x=left+22+i*345;text(x,355,l4Labels[i],12,c.muted);text(x,381,`${num(r.layers.layer4.checks[l4Values[i]])}/100`,16,c.ink,600);}
 text(left,454,'Layer 5 — Competitive Position',26,c.ink,700);pill(width-left-184,433,complete?'15% · COMPLETE':'15% · PROVISIONAL',complete);
 text(left,484,'How your storefront compares with your named competitors on the same checklist.',14,c.muted);
 const metrics=[[num(L.score),'Relative position /100'],[`${L.comparedCount} / ${L.namedCount}`,'Comparable competitors'],[num(L.contribution),'Contribution /15'],[num(L.combinedScore),'Combined audit /100']];
 for(let i=0;i<4;i++){const x=left+i*274;rect(x,514,250,112,i===0?'#0f1919':'#f7f9f9');text(x+20,564,metrics[i][0],36,i===0?'#6bd8d6':c.ink,700);text(x+20,596,metrics[i][1],12,i===0?'#c3d5d4':c.muted);}
 const status=complete?'Three comparable competitors. Layer 5 contributes 15% to the combined audit score.':`${L.comparedCount} comparable competitor${L.comparedCount===1?'':'s'}; at least 3 required. This provisional score does not contribute to the overall score.`;
 rect(left,646,inner,64,complete?c.pale:c.amberBg);rect(left,646,3,64,complete?c.accent:'#c7a549');wrap(left+20,673,status,131,14,complete?c.teal:c.amber,500);
 text(left,737,`Readiness (Layers 1–4): ${num(r.finalScore)}/100. Relative position is a separate measure; all ties = 50.`,12,c.muted);
 text(left,781,'Competitor scan coverage',17,c.ink,700);
 const coverY=808;rect(left,coverY,inner,36,'#f5f7f7');text(left+12,coverY+23,'STOREFRONT',10,c.muted,600);text(left+500,coverY+23,'SCAN STATUS',10,c.muted,600);text(width-left-12,coverY+23,'SAMPLED PRODUCTS',10,c.muted,600,'end');
 L.competitors.forEach((peer,i)=>{const y=coverY+36+i*39;text(left+12,y+25,peer.domain,13);text(left+500,y+25,peer.reason==='NO_CATALOG'?'Product catalogue unavailable':peer.reason||'Measured',12,peer.reason?c.amber:c.teal);text(width-left-12,y+25,peer.sampled||'—',13,c.ink,500,'end');line(left,y+38,inner);});
 let y=coverY+36+L.competitors.length*39+47;
 text(left,y,'Same checks, side by side',19,c.ink,700);y+=27;text(left,y,'Checklist scores /100. Not every score is a percentage of products. Gap is against the competitor median.',12,c.muted);y+=25;
 const tableY=y, labelW=306, colW=(inner-labelW-204)/(L.namedCount+1);
 rect(left,y,inner,50,'#f5f7f7');text(left+12,y+30,'CHECK',10,c.muted,600);text(left+labelW+colW/2,y+30,'YOUR STORE',10,c.teal,700,'middle');
 L.competitors.forEach((peer,i)=>{text(left+labelW+colW*(i+1.5),y+30,peer.domain,10,c.muted,500,'middle');});
 text(width-left-151,y+30,'MEDIAN',10,c.muted,600,'middle');text(width-left-57,y+30,'GAP',10,c.muted,600,'middle');y+=50;
 L.rows.forEach((row,i)=>{if(i%2===1)rect(left,y,inner,39,'#fafbfb');text(left+12,y+25,row.label,12);text(left+labelW+colW/2,y+25,num(row.client),13,c.ink,600,'middle');L.competitors.forEach((peer,j)=>text(left+labelW+colW*(j+1.5),y+25,num(row.competitors.find(v=>v.domain===peer.domain)?.value),13,c.muted,400,'middle'));text(width-left-151,y+25,num(row.median),13,c.ink,500,'middle');text(width-left-57,y+25,`${row.delta>0?'+':''}${num(row.delta)} ${row.delta<0?'↓':row.delta>0?'↑':'='}`,12,row.delta<0?c.red:row.delta>0?c.teal:c.muted,500,'middle');line(left,y+38,inner);y+=39;});
 y+=42;text(left,y,'What to fix first',19,c.ink,700);y+=19;
 for(const [i,gap] of L.gaps.entries()){rect(left,y,inner,68,'#fff',c.line);text(left+16,y+27,`0${i+1}`,12,c.teal,600);text(left+55,y+27,gap.label,14,c.ink,600);text(width-left-18,y+27,`${Math.abs(gap.delta)} points behind median`,12,c.red,500,'end');text(left+55,y+51,`Review affected products and ${gap.layer.replace('layer','Layer ')} recommendations  →`,12,c.muted);y+=80;}
 if(!L.gaps.length){text(left,y+23,'No measured checks below the competitor median.',14,c.muted);y+=56;}
 for(const label of ['Checkout detection — informational','How this is scored']){line(left,y,inner);text(left+2,y+30,label,14,c.teal,600);text(width-left-8,y+30,'+',18,c.teal,500,'end');y+=55;}
 y+=7;y=wrap(left,y,'Public storefront data · Up to 20 products sampled per store · No purchase attempted. Relative position does not measure AI recommendations or sales performance.',148,11,c.muted);
 text(left,y+18,`Engine ${L.engineVersion}   ·   ${L.methodVersion}`,10,c.muted);y+=52;
 parts[0]=`<rect width="${width}" height="${y}" fill="#fff"/>`;
 const body=parts.join('\n');
 const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${y}" viewBox="0 0 ${width} ${y}"><title>${esc(names[domain])} — Paid report, Layer 5</title>${body}</svg>`;
 await writeFile(`${out}/${domain}.svg`,svg);
 blocks.push({domain,width,height:y,body});
}
const boardWidth=blocks.length*1280+80,boardHeight=Math.max(...blocks.map(b=>b.height))+160;
let board=`<svg xmlns="http://www.w3.org/2000/svg" width="${boardWidth}" height="${boardHeight}" viewBox="0 0 ${boardWidth} ${boardHeight}"><title>Anphonic — Layer 5 paid report designs</title><rect width="${boardWidth}" height="${boardHeight}" fill="#e8eded"/>`;
blocks.forEach((b,i)=>{board+=`<g id="${esc(b.domain.replaceAll('.','-'))}" transform="translate(${80+i*1280},80)">${b.body}</g>`;});board+='</svg>';
await writeFile(`${out}/Layer-5-paid-reports.svg`,board);
console.log(blocks.map(b=>`${b.domain}: ${b.width} × ${b.height}`).join('\n'));
