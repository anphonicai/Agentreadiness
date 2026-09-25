import {lookup} from 'node:dns';
import {isIP} from 'node:net';
import {request as httpRequest} from 'node:http';
import {request as httpsRequest} from 'node:https';

export function isPublicAddress(address) {
  if(isIP(address)===4) {
    const [a,b,c]=address.split('.').map(Number);
    return !(a===0 || a===10 || a===127 || a>=224 || (a===100&&b>=64&&b<=127) ||
      (a===169&&b===254) || (a===172&&b>=16&&b<=31) || (a===192&&(b===168 || b===0 || (b===88&&c===99))) ||
      (a===198&&(b===18 || b===19 || (b===51&&c===100))) || (a===203&&b===0&&c===113));
  }
  // Only global-unicast IPv6; exclude special-purpose 2001 and 6to4 ranges.
  if(isIP(address)===6) return /^[23][0-9a-f]{3}:/i.test(address) && !/^200[12]:/i.test(address) && !/^3fff:/i.test(address);
  return false;
}
export function publicLookup(host, options, callback) {
  lookup(host,{all:true,verbatim:true},(error,addresses)=>{
    if(error) return callback(error);
    if(!addresses.length || addresses.some(a=>!isPublicAddress(a.address))) return callback(new Error('Private destination blocked'));
    const compatible=options.family ? addresses.filter(a=>a.family===options.family) : addresses;
    if(!compatible.length) return callback(new Error('No compatible public address'));
    if(options.all) callback(null,compatible);
    else callback(null,compatible[0].address,compatible[0].family);
  });
}
export async function publicFetch(input,{headers={},signal}={},redirects=0) {
  const url=new URL(input);
  const host=url.hostname.replace(/^\[|\]$/g,'');
  if(!['http:','https:'].includes(url.protocol) || url.username || url.password || url.port ||
     (isIP(host)&&!isPublicAddress(host))) throw new Error('Unsafe destination');
  if(redirects>5) throw new Error('Too many redirects');
  return new Promise((resolve,reject)=>{
    const request=(url.protocol==='https:'?httpsRequest:httpRequest)(url,{
      headers:{...headers,'Accept-Encoding':'identity'},signal,lookup:publicLookup,agent:false,
    },response=>{
      const headersAt=Date.now();
      const status=response.statusCode;
      if([301,302,303,307,308].includes(status) && response.headers.location) {
        response.destroy();
        publicFetch(new URL(response.headers.location,url),{headers,signal},redirects+1).then(resolve,reject);
        return;
      }
      let length=0;const chunks=[];
      response.on('data',chunk=>{length+=chunk.length;if(length>8*1024*1024) response.destroy(new Error('Page too large'));else chunks.push(chunk);});
      response.on('error',reject);
      response.on('end',()=>resolve({ok:status>=200&&status<300,status,url:url.href,headersAt,
        headers:new Headers(Object.entries(response.headers).filter(([,v])=>v!==undefined).map(([k,v])=>[k,Array.isArray(v)?v.join(', '):v])),
        text:async()=>Buffer.concat(chunks).toString('utf8')}));
    });
    request.on('error',reject);request.end();
  });
}
