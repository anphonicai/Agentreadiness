import {readFileSync} from 'node:fs';
import {PRODUCT_NAME} from './report-email.js';
const logo = readFileSync(new URL('./public/assets/flow/logo.png', import.meta.url)).toString('base64');

export function otpEmail(code) {
  if (!/^\d{6}$/.test(code)) throw new Error('A six-digit code is required.');
  return {
    subject: `[${PRODUCT_NAME}] Email verification code`,
    text: `${PRODUCT_NAME}\n\nPlease verify your email\n\nYour verification code is ${code}.\nReturn to the page where you requested this code and enter it to continue your store analysis.\n\nThis code expires in 5 minutes and can only be used once. Do not share it with anyone. If you did not request this email, you can ignore it.\n\nThe ${PRODUCT_NAME} team`,
    attachments: [{filename:'anphonic-logo.png',content:logo,content_id:'anphonic-logo'}],
    html: `<!doctype html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Verify your email</title>
<style>@media only screen and (max-width:480px){.email-body{padding:36px 20px!important}.email-title{font-size:32px!important;line-height:40px!important}.email-copy{font-size:16px!important;line-height:26px!important}}</style></head>
<body style="margin:0;padding:0;background:#ffffff;color:#1c2024;font-family:Arial,Helvetica,sans-serif;">
<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">Verify your email to continue your store analysis. Your code expires in 5 minutes.</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#ffffff;"><tr><td align="center">
<table role="presentation" width="640" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:640px;"><tr><td class="email-body" align="center" style="padding:56px 32px 40px;">
<img src="cid:anphonic-logo" alt="Anphonic" width="170" height="40" style="display:block;width:170px;height:40px;border:0;margin:0 auto;">
<p style="margin:16px 0 0;font-size:12px;line-height:20px;letter-spacing:2px;color:#617176;">COMMERCE INTELLIGENCE</p>
<table role="presentation" width="96" cellspacing="0" cellpadding="0" border="0" style="margin:36px auto 48px;"><tr><td height="3" style="height:3px;background:#1c2024;font-size:0;line-height:0;">&nbsp;</td></tr></table>
<h1 class="email-title" style="margin:0 0 28px;font-size:44px;line-height:52px;letter-spacing:-1.3px;font-weight:700;">Please verify<br>your email</h1>
<p class="email-copy" style="margin:0;font-size:18px;line-height:29px;">Here’s your one-time verification code.<br>Enter it on the page you left open<br>to continue your store analysis.</p>
<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:36px auto;"><tr><td align="center" style="padding:20px 24px 20px 32px;border:1px solid #cddddd;border-radius:6px;background:#f4fafa;font-family:'Courier New',monospace;font-size:34px;line-height:42px;font-weight:700;letter-spacing:8px;color:#102f30;white-space:nowrap;">${code}</td></tr></table>
<p style="margin:0;font-size:14px;line-height:24px;color:#677078;">This code is valid for <strong>5 minutes</strong> and can only be used once.<br>Please don’t share it with anyone.</p>
<p style="margin:30px 0 0;font-size:15px;line-height:25px;color:#677078;">Cheers,<br>The <a href="https://www.anphonic.ai/" style="color:inherit;text-decoration:underline;">Commerce.Anphonic.ai</a> team</p>
<table role="presentation" width="96" cellspacing="0" cellpadding="0" border="0" style="margin:40px auto 28px;"><tr><td height="3" style="height:3px;background:#1c2024;font-size:0;line-height:0;">&nbsp;</td></tr></table>
<p style="margin:0 0 16px;font-size:12px;line-height:20px;color:#7a8288;">Didn’t request this code? You can safely ignore this email.</p>
<p style="margin:0;font-size:12px;line-height:20px;color:#7a8288;">&copy; ${new Date().getFullYear()} Anphonic. All rights reserved.</p>
</td></tr></table></td></tr></table></body></html>`,
  };
}
