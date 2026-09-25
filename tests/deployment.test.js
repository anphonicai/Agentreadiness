import test from 'node:test';
import assert from 'node:assert/strict';
import {isPublicAddress,publicFetch} from '../public-fetch.js';
import {clientIp} from '../client-ip.js';
test('scanner blocks private and special addresses including mapped IPv6',async()=>{
 for(const ip of ['127.0.0.1','10.1.1.1','169.254.169.254','172.16.0.1','192.168.1.1','100.64.0.1','::1','::ffff:127.0.0.1','fc00::1','fe80::1','2002:7f00:1::']) assert.equal(isPublicAddress(ip),false,ip);
 for(const ip of ['8.8.8.8','1.1.1.1','2606:4700:4700::1111']) assert.equal(isPublicAddress(ip),true,ip);
 for(const url of ['http://127.0.0.1','http://0x7f000001','http://[::ffff:127.0.0.1]','file:///etc/passwd','https://example.com:123']) await assert.rejects(publicFetch(url));
});
test('client IP headers are trusted only through configured local proxy',()=>{
 const req={socket:{remoteAddress:'8.8.8.8'},headers:{'x-real-ip':'1.1.1.1'}};
 assert.equal(clientIp(req,true),'8.8.8.8');req.socket.remoteAddress='127.0.0.1';
 assert.equal(clientIp(req,false),'127.0.0.1');assert.equal(clientIp(req,true),'1.1.1.1');
 req.headers['x-real-ip']='spoof';assert.equal(clientIp(req,true),'127.0.0.1');
});
