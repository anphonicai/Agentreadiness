// Shared server-side validation for URL entry, lead capture and scan requests.
export function normalizeStoreUrl(value) {
  try {
    if (typeof value !== 'string' || value.length > 2048) throw new Error();
    value = value.trim();
    if (!value || /\s/.test(value)) throw new Error();
    const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) throw new Error();
    const host = url.hostname;
    if (!host.includes('.') || host.endsWith('.local') || host.endsWith('.localhost') || /^[\d.]+$/.test(host)) throw new Error();
    if (!host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label))) throw new Error();
    return url.origin;
  } catch { throw new Error('Enter a valid public store URL, such as example.com.'); }
}

export function resolveStoreInput(value, stores = []) {
  if (typeof value !== 'string') return {url:normalizeStoreUrl(value)};
  const name = value.trim();
  if (/[.:/]/.test(name)) return {url:normalizeStoreUrl(name)};
  if (!/^[a-z0-9][a-z0-9 &'-]{0,119}$/i.test(name)) throw new Error('Enter a store name or website URL.');
  const key = text => text.toLowerCase().replace(/[^a-z0-9]/g, '');
  const matches = new Set();
  for (const store of stores) {
    try {
      const url = normalizeStoreUrl(store.domain);
      const domainName = new URL(url).hostname.replace(/^www\./, '').split('.')[0];
      if (key(store.brandName || '') === key(name) || key(domainName) === key(name)) matches.add(url);
    } catch { /* Ignore invalid historical entries. */ }
  }
  if (matches.size === 1) return {url:[...matches][0]};
  if (matches.size > 1) throw new Error('More than one store matches that name. Enter the website URL.');
  // A name alone cannot establish an official website. Let the user confirm
  // the suggested domain before consent or any scan request.
  const url = normalizeStoreUrl(key(name) + '.com');
  return {url, needsConfirmation:true};
}

export async function handleStoreRequest(req, res, stores = []) {
  const reply = (status, data) => {
    res.writeHead(status, {'Content-Type':'application/json', 'Cache-Control':'no-store'});
    res.end(JSON.stringify(data));
  };
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) return reply(415, {error:'Send the store URL as JSON.'});
  let body = '';
  let size = 0;
  try {
    for await (const chunk of req) {
      size += Buffer.byteLength(chunk);
      if (size > 4096) return reply(413, {error:'Store URL is too long.'});
      body += chunk;
    }
  } catch { return; }
  try {
    const input = JSON.parse(body);
    return reply(200, resolveStoreInput(input?.url, stores));
  } catch (error) {
    return reply(400, {error:error instanceof SyntaxError ? 'Invalid JSON.' : error.message});
  }
}
