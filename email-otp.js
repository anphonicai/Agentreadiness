import {randomBytes, randomInt, createHmac, timingSafeEqual} from 'node:crypto';
import {otpEmail} from './otp-email.js';
import {validateLead} from './leads.js';
import {sendReportEmail} from './report-email.js';

// Short-lived challenges intentionally expire on restart. Never log or return codes.
export function createEmailOtp(leads, {send=sendReportEmail, now=Date.now, configured=()=>Boolean(process.env.RESEND_API_KEY && process.env.REPORT_EMAIL_FROM)}={}) {
  const secret=randomBytes(32), challenges=new Map(), grants=new Map(), limits=new Map();
  const digest=(id,code)=>createHmac('sha256',secret).update(id+':'+code).digest();
  function prune() {
    for(const [id,c] of challenges) if(c.expires<=now()) challenges.delete(id);
    for(const [id,g] of grants) if(g.expires<=now()) grants.delete(id);
    for(const [email,l] of limits) if(l.start+3600000<=now()) limits.delete(email);
  }
  return {
    async request(input) {
      if(!configured()) throw new Error('Email verification is not configured. Please contact the team.');
      const contact=validateLead(input); prune();
      const previous=limits.get(contact.email);
      if(previous && (now()-previous.last<30000 || previous.count>=5)) throw new Error('Please wait before requesting another code. Limit: five emails per hour.');
      limits.set(contact.email,{start:previous?.start??now(),last:now(),count:(previous?.count||0)+1});
      const id=randomBytes(32).toString('hex'), code=String(randomInt(0,1000000)).padStart(6,'0');
      // Invalidate all older codes, including concurrent in-flight requests.
      for(const [key,c] of challenges) if(c.contact.email===contact.email) challenges.delete(key);
      const challenge={contact,hash:digest(id,code),expires:now()+300000,attempts:0,ready:false};
      challenges.set(id,challenge);
      try {
        leads.save(input);
        await send({to:contact.email,idempotencyKey:'otp-'+id,email:otpEmail(code)});
        challenge.ready=true;
        return {challengeId:id,resendAfter:30};
      } catch { challenges.delete(id); throw new Error('Unable to send your code. Please try again shortly.'); }
    },
    verify(id,code) {
      prune(); const c=challenges.get(id);
      if(!c?.ready || c.attempts>=5) throw new Error('Code expired or too many attempts. Request a new code.');
      c.attempts++;
      if(typeof code!=='string' || !/^\d{6}$/.test(code) || !timingSafeEqual(c.hash,digest(id,code))) throw new Error('Incorrect verification code.');
      leads.verify(c.contact.email,c.contact.storeUrl);
      challenges.delete(id);
      const token=randomBytes(32).toString('hex');
      grants.set(token,{contact:c.contact,expires:now()+1800000});
      return {verificationToken:token};
    },
    consume(token,url) {
      prune();const grant=grants.get(token);
      if(!grant || grant.contact.storeUrl!==url) throw new Error('Verify your email before starting this scan.');
      grants.delete(token);
      return grant.contact;
    },
  };
}
