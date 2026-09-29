// Use production application behavior with isolated local persistence.
import {loadEnvFile} from 'node:process';
import {fileURLToPath} from 'node:url';
try { loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url))); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
process.env.NODE_ENV = 'production';
process.env.REPORT_EMAIL_PREVIEW = '0';
process.env.TRUST_LOCAL_PROXY = '0';
process.env.LEADS_DB_PATH = fileURLToPath(new URL('../data/local/leads.sqlite', import.meta.url));
process.env.REPORTS_DB_PATH = fileURLToPath(new URL('../data/local/reports.sqlite', import.meta.url));
console.log('Local production-mode app. Local databases; real email verification; no report-preview bypass.');
await import('../server.js');
