import { normalizeStoreUrl } from './store-url.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export function validateLead(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Enter your contact details.');
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
  if (!name || name.length > 120) throw new Error('Enter a name of up to 120 characters.');
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter a valid email address.');
  if (input.consent !== true) throw new Error('Consent is required to save your details and analyse the store.');
  return { name, email, storeUrl: normalizeStoreUrl(input.url) };
}

export function openLeadStore(filename) {
  mkdirSync(dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS leads (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      store_url TEXT NOT NULL,
      consent_at TEXT NOT NULL,
      consent_version TEXT NOT NULL,
      email_verified INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(email, store_url)
    );`);
  const save = db.prepare(`INSERT INTO leads
    (id, name, email, store_url, consent_at, consent_version, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'lead-capture-v1', ?, ?)
    ON CONFLICT(email, store_url) DO UPDATE SET
      name=excluded.name, consent_at=excluded.consent_at,
      consent_version=excluded.consent_version, updated_at=excluded.updated_at`);
  return {
    save(input) {
      const lead = validateLead(input);
      const now = new Date().toISOString();
      save.run(randomUUID(), lead.name, lead.email, lead.storeUrl, now, now, now);
    },
    close() { db.close(); },
  };
}

export async function handleLeadRequest(req, res, store) {
  const reply = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) return reply(415, { error: 'Send JSON contact details.' });
  let body = '';
  let size = 0;
  try {
    for await (const chunk of req) {
      size += Buffer.byteLength(chunk);
      if (size > 4096) return reply(413, { error: 'Contact details are too large.' });
      body += chunk;
    }
  } catch { return; }
  let input;
  try { input = JSON.parse(body); validateLead(input); }
  catch (error) { return reply(400, { error: error instanceof SyntaxError ? 'Invalid JSON.' : error.message }); }
  try {
    store.save(input);
    // Same response for a new or existing lead; never expose contact records publicly.
    return reply(200, { saved: true });
  } catch {
    return reply(503, { error: 'Unable to save your details right now. Please try again.' });
  }
}
