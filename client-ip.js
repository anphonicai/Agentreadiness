import {isIP} from 'node:net';
export function clientIp(req, trusted=process.env.TRUST_LOCAL_PROXY==='1') {
 const peer=req.socket.remoteAddress || 'unknown';
 const forwarded=req.headers['x-real-ip'];
 if(trusted && ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(peer) && typeof forwarded==='string' && isIP(forwarded)) return forwarded;
 return peer;
}
