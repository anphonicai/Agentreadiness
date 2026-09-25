import test from 'node:test';
import assert from 'node:assert/strict';
import {createEmailOtp} from '../email-otp.js';
const input={name:'Alex',email:'alex@example.com',url:'https://example.com',consent:true};
function setup() {
 let clock=1000000, code, verified=0;
 const otp=createEmailOtp({save(){},verify(){verified++;}}, {configured:()=>true,now:()=>clock,send:async({email})=>{code=email.text.match(/\d{6}/)[0];}});
 return {otp,get code(){return code;},get verified(){return verified;},advance(ms){clock+=ms;}};
}
test('OTP grants one scan for the verified store and cannot be reused',async()=>{
 const s=setup(), challenge=await s.otp.request(input);
 assert.equal(challenge.code,undefined);
 assert.throws(()=>s.otp.consume('fake',input.url));
 const {verificationToken}=s.otp.verify(challenge.challengeId,s.code);
 assert.equal(s.verified,1);
 assert.throws(()=>s.otp.verify(challenge.challengeId,s.code));
 assert.throws(()=>s.otp.consume(verificationToken,'https://other.com'));
 assert.equal(s.otp.consume(verificationToken,input.url).email,input.email);
 assert.throws(()=>s.otp.consume(verificationToken,input.url));
});
test('OTP limits attempts, resend frequency, and rejects old or expired codes',async()=>{
 const s=setup(), first=await s.otp.request(input);
 await assert.rejects(s.otp.request(input));
 for(let i=0;i<5;i++) assert.throws(()=>s.otp.verify(first.challengeId,'bad'));
 assert.throws(()=>s.otp.verify(first.challengeId,s.code));
 s.advance(31000);
 const second=await s.otp.request(input);
 assert.throws(()=>s.otp.verify(first.challengeId,s.code));
 s.advance(300001);
 assert.throws(()=>s.otp.verify(second.challengeId,s.code));
});
test('failed email delivery never produces a usable challenge',async()=>{
 const otp=createEmailOtp({save(){}},{configured:()=>true,send:async()=>{throw new Error('provider failed');}});
 await assert.rejects(otp.request(input),/Unable to send/);
});
