// Helix Onboarding — local Node server with SQLite storage
// - Serves static files from this folder
// - POST   /api/submissions       → store a new submission
// - GET    /api/submissions       → list submission metadata
// - GET    /api/submissions/:id   → single submission (full record)
// - DELETE /api/submissions/:id   → remove a submission
// - GET    /api/plans             → flat list of every plan across submissions
// - GET    /api/export.csv        → CSV export of submission metadata
// - GET    /admin                 → submissions viewer UI
//
// Storage: SQLite database at ./helix.db (Node 24 built-in `node:sqlite`).
// Existing JSON files in ./submissions/ are auto-imported on first start.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const url = require('url');
const { DatabaseSync } = require('node:sqlite');
const nodemailer = require('nodemailer');

const ROOT = __dirname;
const SUBMISSIONS_DIR = path.join(ROOT, 'submissions'); // legacy + JSON backup
const OUTBOX_DIR = path.join(ROOT, 'outbox');           // fallback when SMTP not configured
const DB_PATH = path.join(ROOT, 'helix.db');
const PORT = Number(process.env.PORT) || 3000;

const HELIX_EMAIL = process.env.HELIX_EMAIL || 'service@helixbenefits.net';
const MAIL_FROM   = process.env.MAIL_FROM   || 'Helix Benefit Solutions <service@helixbenefits.net>';

if (!fs.existsSync(SUBMISSIONS_DIR)) fs.mkdirSync(SUBMISSIONS_DIR, { recursive: true });
if (!fs.existsSync(OUTBOX_DIR)) fs.mkdirSync(OUTBOX_DIR, { recursive: true });

// ============== Email transport ==============
// If SMTP_HOST/USER/PASS are set in env, use real SMTP.
// Otherwise: write the email as an .eml file in ./outbox/ so you can see/open it.
let mailTransport = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  mailTransport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
  console.log(`Email: SMTP transport configured (${process.env.SMTP_HOST})`);
} else {
  console.log(`Email: no SMTP env vars — emails will be written to ${OUTBOX_DIR}`);
  console.log(`       To send real email, set SMTP_HOST, SMTP_USER, SMTP_PASS, SMTP_PORT, SMTP_SECURE`);
}

async function sendMail({ to, subject, text, html }) {
  if (mailTransport) {
    try {
      const info = await mailTransport.sendMail({ from: MAIL_FROM, to, subject, text, html });
      console.log(`  → email sent to ${to} (messageId=${info.messageId})`);
      return { sent: true, to, messageId: info.messageId };
    } catch (e) {
      console.error(`  ✗ email FAILED to ${to}: ${e.message}`);
      return { sent: false, to, error: e.message };
    }
  }
  // Outbox fallback: write a readable .eml file
  const safe = String(to).replace(/[^a-z0-9@._-]/gi,'_');
  const file = path.join(OUTBOX_DIR, `${Date.now()}__${safe}.eml`);
  const eml = [
    `From: ${MAIL_FROM}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Date: ${new Date().toUTCString()}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/html; charset=utf-8`,
    ``,
    html || text || ''
  ].join('\r\n');
  fs.writeFileSync(file, eml, 'utf8');
  console.log(`  → email queued to outbox: ${path.basename(file)} (to=${to})`);
  return { sent: false, queued: true, file, to };
}

function escapeHtml(s){ return String(s==null?'':s).replace(/[&<>"']/g, c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }

function buildEmails(record) {
  const employer = (record.employer && record.employer.name) || 'unknown employer';
  const sub = record.submitter || {};
  const cobraCount = (record.cobra && record.cobra.plans && record.cobra.plans.length) || 0;
  const cdhTypes = (record.cdh && record.cdh.selectedPlanTypes) || [];
  const products = [];
  if (record.onboarding && record.onboarding.cobra) products.push(`COBRA (${cobraCount} plan${cobraCount===1?'':'s'})`);
  if (cdhTypes.length) products.push(`CDH: ${cdhTypes.join(', ').toUpperCase()}`);
  const productList = products.join(' · ') || 'none';
  const id = record._id;

  // Submitter confirmation
  const submitterHtml = `
    <div style="font-family:Segoe UI,Arial,sans-serif;color:#1e2a3a;max-width:620px;margin:0 auto">
      <div style="background:linear-gradient(135deg,#0d1b4b,#2557b7);color:#fff;padding:18px 24px;border-radius:8px 8px 0 0">
        <h2 style="margin:0;font-size:1.1rem">Helix Benefit Solutions — Onboarding Received</h2>
      </div>
      <div style="background:#fff;border:1px solid #d1d9e6;border-top:none;border-radius:0 0 8px 8px;padding:22px 24px">
        <p>Hi ${escapeHtml(sub.name || 'there')},</p>
        <p>Thanks for completing the onboarding form for <b>${escapeHtml(employer)}</b>. We've received your submission and our team will be in touch shortly.</p>
        <div style="background:#f0f4fa;border-left:3px solid #2557b7;padding:12px 16px;margin:18px 0;border-radius:4px">
          <div style="font-size:.78rem;color:#6b7c93;text-transform:uppercase;letter-spacing:.04em;margin-bottom:4px">Submission summary</div>
          <div><b>Employer:</b> ${escapeHtml(employer)}</div>
          <div><b>Products:</b> ${escapeHtml(productList)}</div>
          <div><b>Submitted by:</b> ${escapeHtml(sub.name)} &lt;${escapeHtml(sub.email)}&gt;</div>
          <div><b>Submission ID:</b> <code>${escapeHtml(id)}</code></div>
          <div><b>Date:</b> ${escapeHtml(new Date(record._receivedAt || Date.now()).toLocaleString())}</div>
        </div>
        <p>A copy has also been delivered to the Helix service team. If you have any questions in the meantime, reply to this email or contact us at <a href="mailto:${escapeHtml(HELIX_EMAIL)}">${escapeHtml(HELIX_EMAIL)}</a>.</p>
        <p style="margin-top:24px;font-size:.85rem;color:#6b7c93">— Helix Benefit Solutions</p>
      </div>
    </div>`;

  // Internal Helix notification
  const helixHtml = `
    <div style="font-family:Segoe UI,Arial,sans-serif;color:#1e2a3a;max-width:680px;margin:0 auto">
      <div style="background:linear-gradient(135deg,#0d1b4b,#2557b7);color:#fff;padding:16px 22px;border-radius:8px 8px 0 0">
        <h2 style="margin:0;font-size:1.05rem">New Onboarding Submission</h2>
      </div>
      <div style="background:#fff;border:1px solid #d1d9e6;border-top:none;border-radius:0 0 8px 8px;padding:20px 22px">
        <table cellpadding="6" style="font-size:.9rem;width:100%">
          <tr><td style="color:#6b7c93;width:160px"><b>Employer</b></td><td>${escapeHtml(employer)}</td></tr>
          <tr><td style="color:#6b7c93"><b>Products</b></td><td>${escapeHtml(productList)}</td></tr>
          <tr><td style="color:#6b7c93"><b>Submitter</b></td><td>${escapeHtml(sub.name || '')} &lt;<a href="mailto:${escapeHtml(sub.email)}">${escapeHtml(sub.email)}</a>&gt;</td></tr>
          <tr><td style="color:#6b7c93"><b>Submission ID</b></td><td><code>${escapeHtml(id)}</code></td></tr>
          <tr><td style="color:#6b7c93"><b>Received</b></td><td>${escapeHtml(new Date(record._receivedAt || Date.now()).toLocaleString())}</td></tr>
        </table>
        <p style="margin-top:18px"><b>Full submission JSON is attached below.</b> Open the admin viewer to manage submissions.</p>
        <pre style="background:#0d1b4b;color:#a5d8ff;padding:12px;border-radius:6px;font-size:.72rem;overflow:auto;max-height:420px">${escapeHtml(JSON.stringify(record, null, 2))}</pre>
      </div>
    </div>`;

  return {
    submitter: {
      to: sub.email,
      subject: `Helix Onboarding — submission received for ${employer}`,
      html: submitterHtml
    },
    helix: {
      to: HELIX_EMAIL,
      subject: `[Helix Onboarding] New submission — ${employer} (${productList})`,
      html: helixHtml
    }
  };
}

async function sendSubmissionEmails(record) {
  if (!record.submitter || !record.submitter.email) {
    console.warn('  ! submitter email missing — skipping confirmation');
    return { submitter: null, helix: null };
  }
  const emails = buildEmails(record);
  const [submitterRes, helixRes] = await Promise.all([
    sendMail(emails.submitter),
    sendMail(emails.helix)
  ]);
  return { submitter: submitterRes, helix: helixRes };
}

// ============== Database ==============
const db = new DatabaseSync(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS submissions (
    id              TEXT PRIMARY KEY,
    employer_name   TEXT,
    employer_ein    TEXT,
    onboarding_cobra INTEGER NOT NULL DEFAULT 0,
    onboarding_cdh   INTEGER NOT NULL DEFAULT 0,
    cobra_plan_count INTEGER NOT NULL DEFAULT 0,
    cdh_plan_count   INTEGER NOT NULL DEFAULT 0,
    submitted_at    TEXT,
    received_at     TEXT NOT NULL,
    payload         TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_submissions_employer ON submissions(employer_name);
  CREATE INDEX IF NOT EXISTS idx_submissions_received ON submissions(received_at);

  CREATE TABLE IF NOT EXISTS plans (
    submission_id   TEXT NOT NULL,
    kind            TEXT NOT NULL,
    plan_index      INTEGER NOT NULL,
    benefit_type    TEXT,
    carrier         TEXT,
    plan_name       TEXT,
    effective_start TEXT,
    group_number    TEXT,
    payload         TEXT NOT NULL,
    PRIMARY KEY (submission_id, kind, plan_index),
    FOREIGN KEY (submission_id) REFERENCES submissions(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_plans_carrier ON plans(carrier);
  CREATE INDEX IF NOT EXISTS idx_plans_kind    ON plans(kind);
`);

const stmtInsertSubmission = db.prepare(`
  INSERT INTO submissions
    (id, employer_name, employer_ein, onboarding_cobra, onboarding_cdh,
     cobra_plan_count, cdh_plan_count, submitted_at, received_at, payload)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const stmtInsertPlan = db.prepare(`
  INSERT INTO plans
    (submission_id, kind, plan_index, benefit_type, carrier, plan_name,
     effective_start, group_number, payload)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const stmtListSubmissions = db.prepare(`
  SELECT id, employer_name, employer_ein, onboarding_cobra, onboarding_cdh,
         cobra_plan_count, cdh_plan_count, submitted_at, received_at,
         length(payload) AS size
  FROM submissions
  ORDER BY received_at DESC
`);
const stmtGetSubmission    = db.prepare(`SELECT payload FROM submissions WHERE id = ?`);
const stmtDeleteSubmission = db.prepare(`DELETE FROM submissions WHERE id = ?`);
const stmtListAllPlans = db.prepare(`
  SELECT p.submission_id, s.employer_name, p.kind, p.plan_index,
         p.benefit_type, p.carrier, p.plan_name, p.effective_start,
         p.group_number, s.submitted_at
  FROM plans p
  JOIN submissions s ON s.id = p.submission_id
  ORDER BY s.received_at DESC, p.kind, p.plan_index
`);

function insertSubmission(record) {
  const id = record._id;
  const employer = record.employer || {};
  const onboarding = record.onboarding || {};
  const cobraPlans = (record.cobra && Array.isArray(record.cobra.plans)) ? record.cobra.plans : [];
  const cdhPlans   = (record.cdh   && Array.isArray(record.cdh.plans))   ? record.cdh.plans   : [];
  const payload = JSON.stringify(record);

  db.prepare('BEGIN').run();
  try {
    stmtInsertSubmission.run(
      id,
      employer.name || null,
      employer.ein || employer.fein || null,
      onboarding.cobra ? 1 : 0,
      onboarding.cdh   ? 1 : 0,
      cobraPlans.length,
      cdhPlans.length,
      record.submittedAt || null,
      record._receivedAt || new Date().toISOString(),
      payload
    );
    cobraPlans.forEach((p, i) => stmtInsertPlan.run(
      id, 'cobra', i,
      p.benefitType || null, p.carrier || null, p.planName || null,
      p.effectiveStart || null, p.groupNumber || null,
      JSON.stringify(p)
    ));
    cdhPlans.forEach((p, i) => stmtInsertPlan.run(
      id, 'cdh', i,
      p.planType || p.type || null, null, p.planName || null,
      p.effectiveStart || null, null,
      JSON.stringify(p)
    ));
    db.prepare('COMMIT').run();
  } catch (e) {
    db.prepare('ROLLBACK').run();
    throw e;
  }
}

// ============== One-time migration of legacy JSON files ==============
(function migrateLegacyJson() {
  const existing = new Set(stmtListSubmissions.all().map(r => r.id));
  let migrated = 0;
  for (const f of fs.readdirSync(SUBMISSIONS_DIR).filter(f => f.endsWith('.json'))) {
    const id = f.replace(/\.json$/, '');
    if (existing.has(id)) continue;
    try {
      const obj = JSON.parse(fs.readFileSync(path.join(SUBMISSIONS_DIR, f), 'utf8'));
      if (!obj._id) obj._id = id;
      if (!obj._receivedAt) obj._receivedAt = fs.statSync(path.join(SUBMISSIONS_DIR, f)).mtime.toISOString();
      insertSubmission(obj);
      migrated++;
    } catch (e) {
      console.warn('Skipped legacy file', f, e.message);
    }
  }
  if (migrated) console.log(`Migrated ${migrated} legacy submission(s) into ${path.basename(DB_PATH)}`);
})();

// ============== HTTP helpers ==============
const MIME = {
  '.html':'text/html; charset=utf-8', '.js':'application/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8', '.json':'application/json; charset=utf-8',
  '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg',
  '.webp':'image/webp', '.svg':'image/svg+xml', '.ico':'image/x-icon',
  '.txt':'text/plain; charset=utf-8', '.csv':'text/csv; charset=utf-8'
};

function sendJson(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type':'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}
function sendText(res, code, body, ctype='text/plain; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': ctype, 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function serveStatic(req, res) {
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  const safe = path.normalize(rel).replace(/^([/\\])+/, '');
  const full = path.join(ROOT, safe);
  if (!full.startsWith(ROOT)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.stat(full, (err, stat) => {
    if (err || !stat.isFile()) { res.writeHead(404); return res.end('Not found: ' + rel); }
    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Length': stat.size });
    fs.createReadStream(full).pipe(res);
  });
}
function readBody(req, limit = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('Payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s;
}

// ============== Routes ==============
function listMeta() {
  return stmtListSubmissions.all().map(r => ({
    id: r.id,
    employerName: r.employer_name || '',
    employerEIN:  r.employer_ein || '',
    onboarding: { cobra: !!r.onboarding_cobra, cdh: !!r.onboarding_cdh },
    cobraPlans: r.cobra_plan_count,
    cdhPlans:   r.cdh_plan_count,
    submittedAt: r.submitted_at,
    receivedAt:  r.received_at,
    size: r.size,
    modified: r.received_at  // back-compat for existing admin.html
  }));
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // POST /api/submissions
  if (req.method === 'POST' && pathname === '/api/submissions') {
    try {
      const raw = await readBody(req);
      let body; try { body = JSON.parse(raw); } catch { return sendJson(res, 400, { error: 'Invalid JSON' }); }
      const ts = new Date();
      const iso = ts.toISOString().replace(/[:.]/g, '-');
      const rand = crypto.randomBytes(3).toString('hex');
      const employerSlug = ((body.employer && body.employer.name) || 'unknown')
        .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'unknown';
      const id = `${iso}__${employerSlug}__${rand}`;
      const record = { _id: id, _receivedAt: ts.toISOString(), ...body };

      // Write JSON backup (handy for offline review / git diff)
      const file = path.join(SUBMISSIONS_DIR, id + '.json');
      fs.writeFileSync(file, JSON.stringify(record, null, 2), 'utf8');

      // Insert into DB
      insertSubmission(record);

      console.log(`[${ts.toISOString()}] Stored submission ${id}`);

      // Fire-and-forget emails; don't block the response
      let emailResults = null;
      try {
        emailResults = await sendSubmissionEmails(record);
      } catch (e) {
        console.error('  ✗ email pipeline error:', e.message);
      }

      return sendJson(res, 201, { ok: true, id, file: path.relative(ROOT, file), emails: emailResults });
    } catch (e) {
      console.error('POST /api/submissions error:', e);
      return sendJson(res, 500, { error: e.message });
    }
  }

  // GET /api/submissions
  if (req.method === 'GET' && pathname === '/api/submissions') {
    try { return sendJson(res, 200, listMeta()); }
    catch (e) { return sendJson(res, 500, { error: e.message }); }
  }

  // GET /api/plans
  if (req.method === 'GET' && pathname === '/api/plans') {
    try { return sendJson(res, 200, stmtListAllPlans.all()); }
    catch (e) { return sendJson(res, 500, { error: e.message }); }
  }

  // GET /api/export.csv
  if (req.method === 'GET' && pathname === '/api/export.csv') {
    const rows = listMeta();
    const header = ['id','employerName','employerEIN','cobra','cdh','cobraPlans','cdhPlans','submittedAt','receivedAt'];
    const lines = [header.join(',')];
    for (const r of rows) {
      lines.push([r.id, r.employerName, r.employerEIN, r.onboarding.cobra, r.onboarding.cdh,
                  r.cobraPlans, r.cdhPlans, r.submittedAt, r.receivedAt].map(csvEscape).join(','));
    }
    return sendText(res, 200, lines.join('\n'), 'text/csv; charset=utf-8');
  }

  // GET/DELETE /api/submissions/:id
  const m = pathname.match(/^\/api\/submissions\/([A-Za-z0-9_\-:.]+)$/);
  if (m) {
    const id = m[1];
    if (req.method === 'GET') {
      const row = stmtGetSubmission.get(id);
      if (!row) return sendJson(res, 404, { error: 'Not found' });
      res.writeHead(200, { 'Content-Type':'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(row.payload) });
      return res.end(row.payload);
    }
    if (req.method === 'DELETE') {
      const info = stmtDeleteSubmission.run(id);
      if (!info.changes) return sendJson(res, 404, { error: 'Not found' });
      const file = path.join(SUBMISSIONS_DIR, id + '.json');
      if (fs.existsSync(file)) { try { fs.unlinkSync(file); } catch {} }
      return sendJson(res, 200, { ok: true, deleted: id });
    }
  }

  // /admin → admin.html
  if (pathname === '/admin') { req.url = '/admin.html'; return serveStatic(req, res); }

  return serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`Helix Onboarding server listening on http://localhost:${PORT}`);
  console.log(`  Form:   http://localhost:${PORT}/benefit-plan-setup.html`);
  console.log(`  Admin:  http://localhost:${PORT}/admin`);
  console.log(`  DB:     ${DB_PATH}`);
  console.log(`  JSON:   ${SUBMISSIONS_DIR} (kept as backup)`);
});
