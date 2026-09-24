const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const PRODUCT_NAME = 'Commerce.Anphonic.ai';
export function reportEmail({name, domain, reportUrl, preview=false}) {
  const link = new URL(reportUrl);
  if (!['http:','https:'].includes(link.protocol)) throw new Error('Invalid report URL');
  const brand = new URL(domain).hostname.replace(/^www\./,'').split('.')[0];
  const subject = `Your Agent Readiness Report is ready — ${brand}`;
  const text = `${PRODUCT_NAME}\n\nHi ${name || 'there'},\nYour Agent Readiness Report for ${brand} is ready.\nView your report: ${reportUrl}\n\nIncludes readiness scores, product evidence, recommendations and available competitor comparisons.\nThis private link expires in 30 days. Keep it private.\n${preview ? 'LOCAL PREVIEW — no email was sent and no payment was collected.' : ''}`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(subject)}</title></head><body style="margin:0;background:#f5f7f7;color:#14161a;font-family:Arial,sans-serif"><div style="display:none;max-height:0;overflow:hidden">Your store’s readiness scores, evidence and recommendations are ready.</div><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:40px 16px"><table role="presentation" width="640" cellpadding="0" cellspacing="0" style="width:100%;max-width:640px;background:white;border-radius:16px"><tr><td align="center" style="padding:40px 28px"><p style="font-size:22px;font-weight:bold">${PRODUCT_NAME}</p><div style="width:80px;height:3px;background:#30b4b7;margin:32px auto"></div>${preview ? '<p style="font-size:12px;color:#6e747d">LOCAL EMAIL PREVIEW · NOT SENT</p>' : ''}<h1 style="font-size:36px;line-height:1.2;margin:32px 0">Your Agent Readiness<br>Report is ready!</h1><p style="font-size:16px;line-height:1.7;color:#607070">Hi ${escape(name || 'there')},<br>We’ve finished analysing <b>${escape(brand)}</b>.<br>Your detailed report is ready to explore.</p><div style="background:#f3f7f7;border-radius:12px;padding:28px 16px;margin:32px 0"><a target="_top" href="${escape(reportUrl)}" style="display:inline-block;padding:18px 24px;background:#080a0a;color:#fff;text-decoration:none;border-radius:8px;font-size:18px;font-weight:bold">View your report →</a><p style="font-size:13px;color:#607070">Explore your scores, findings and next steps.</p></div><p style="font-size:14px;line-height:1.7;color:#607070">Your report includes product evidence, per-check recommendations and available competitor comparisons.</p><p style="font-size:14px;line-height:1.7">Cheers,<br>The <a href="https://www.anphonic.ai/" style="color:inherit;text-decoration:underline;">${PRODUCT_NAME}</a> team</p><div style="width:80px;height:3px;background:#30b4b7;margin:32px auto"></div><p style="font-size:12px;color:#6e747d">This private report link expires in 30 days. Please don’t forward it.</p><p style="font-size:12px;color:#6e747d">© ${new Date().getFullYear()} Anphonic</p></td></tr></table></td></tr></table></body></html>`;
  return {subject, text, html};
}

// Called only by a trusted fulfillment process after payment verification.
export async function sendReportEmail({to, email, idempotencyKey}, {apiKey=process.env.RESEND_API_KEY, from=process.env.REPORT_EMAIL_FROM, fetchImpl=fetch} = {}) {
  if (!apiKey || !from) throw new Error('Configure RESEND_API_KEY and REPORT_EMAIL_FROM before sending.');
  const response = await fetchImpl('https://api.resend.com/emails', {
    method:'POST', headers:{Authorization:`Bearer ${apiKey}`, 'Content-Type':'application/json', 'Idempotency-Key':idempotencyKey},
    body:JSON.stringify({from:`${PRODUCT_NAME} <${from}>`,to:[to],...email}), signal:AbortSignal.timeout(15000),
  });
  const result = await response.json();
  if (!response.ok || !result.id) throw new Error('Email provider did not accept delivery.');
  return result.id;
}
