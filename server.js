// Helix Onboarding — local Node server with SQLite storage
// - Serves static files from this folder
// - POST   /api/submissions       → store a new submission
// - GET    /api/submissions       → list submission metadata
// - GET    /api/submissions/:id   → single submission (full record)
// - DELETE /api/submissions/:id   → remove a submission
// - GET    /api/plans             → flat list of every plan across submissions
// - GET    /api/export.csv        → CSV export of submission metadata
// - GET    /admin                 → submissions viewer UI (Helix staff only)
//
// Accounts:
// - POST   /api/auth/register     → create an account + sign in
// - POST   /api/auth/login        → sign in (HttpOnly session cookie)
// - POST   /api/auth/logout       → sign out
// - GET    /api/auth/me           → current signed-in user
//
// Shared drafts (a coworker can pick up where someone else stopped):
// - GET    /api/drafts            → drafts you own or were invited into
// - POST   /api/drafts            → start one
// - GET    /api/drafts/:id        → open one
// - PUT    /api/drafts/:id        → save (version-checked so edits aren't clobbered)
// - DELETE /api/drafts/:id        → discard (owner only)
// - POST   /api/drafts/:id/share  → invite a coworker by email
// - DELETE /api/drafts/:id/share  → revoke
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

  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT NOT NULL UNIQUE,
    name          TEXT,
    company       TEXT,
    password_hash TEXT NOT NULL,
    is_admin      INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL,
    last_login_at TEXT
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

`);

// Drafts started life as one-per-user. They are now shared documents a
// coworker can be invited into, so move any v1 rows across.
const draftCols = db.prepare(`PRAGMA table_info(drafts)`).all();
if (draftCols.length && !draftCols.some(c => c.name === 'id')) {
  db.exec(`ALTER TABLE drafts RENAME TO drafts_v1`);
}

db.exec(`
  CREATE TABLE IF NOT EXISTS drafts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    title      TEXT,
    owner_id   INTEGER NOT NULL,
    payload    TEXT NOT NULL,
    version    INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by INTEGER,
    FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_drafts_owner ON drafts(owner_id);

  -- Invited collaborators. Stored by email so you can invite a coworker
  -- who has not created an account yet.
  CREATE TABLE IF NOT EXISTS draft_shares (
    draft_id INTEGER NOT NULL,
    email    TEXT NOT NULL,
    added_by INTEGER,
    added_at TEXT NOT NULL,
    PRIMARY KEY (draft_id, email),
    FOREIGN KEY (draft_id) REFERENCES drafts(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_shares_email ON draft_shares(email);
`);

if (db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='drafts_v1'`).get()) {
  const now = new Date().toISOString();
  for (const old of db.prepare(`SELECT * FROM drafts_v1`).all()) {
    db.prepare(`INSERT INTO drafts (title, owner_id, payload, version, created_at, updated_at, updated_by)
                VALUES (?, ?, ?, 1, ?, ?, ?)`)
      .run(null, old.user_id, old.payload, old.updated_at || now, old.updated_at || now, old.user_id);
  }
  db.exec(`DROP TABLE drafts_v1`);
  console.log('Migrated per-user drafts to shared drafts');
}

// Link submissions to the account that sent them (added after initial release)
try { db.exec(`ALTER TABLE submissions ADD COLUMN user_id INTEGER`); } catch (e) { /* already exists */ }

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
         user_id, length(payload) AS size
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

// ============== Auth: statements & helpers ==============
const SESSION_COOKIE = 'helix_session';
const SESSION_DAYS = 30;

const stmtCreateUser = db.prepare(`
  INSERT INTO users (email, name, company, password_hash, is_admin, created_at)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const stmtUserByEmail = db.prepare(`SELECT * FROM users WHERE email = ?`);
const stmtUserById    = db.prepare(`SELECT * FROM users WHERE id = ?`);
const stmtTouchLogin  = db.prepare(`UPDATE users SET last_login_at = ? WHERE id = ?`);
const stmtInsertSession = db.prepare(`INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`);
const stmtGetSession = db.prepare(`
  SELECT s.token, s.expires_at, u.id AS user_id, u.email, u.name, u.company, u.is_admin
  FROM sessions s JOIN users u ON u.id = s.user_id
  WHERE s.token = ?
`);
const stmtDeleteSession = db.prepare(`DELETE FROM sessions WHERE token = ?`);
const stmtPurgeSessions = db.prepare(`DELETE FROM sessions WHERE expires_at < ?`);
const stmtDraftById = db.prepare(`
  SELECT d.*, o.email AS owner_email, o.name AS owner_name, e.name AS editor_name, e.email AS editor_email
  FROM drafts d
  JOIN users o ON o.id = d.owner_id
  LEFT JOIN users e ON e.id = d.updated_by
  WHERE d.id = ?
`);
const stmtCreateDraft = db.prepare(`
  INSERT INTO drafts (title, owner_id, payload, version, created_at, updated_at, updated_by)
  VALUES (?, ?, ?, 1, ?, ?, ?)
`);
const stmtUpdateDraft = db.prepare(`
  UPDATE drafts SET payload = ?, title = ?, version = version + 1, updated_at = ?, updated_by = ?
  WHERE id = ?
`);
const stmtDeleteDraftById = db.prepare(`DELETE FROM drafts WHERE id = ?`);
const stmtShareEmails = db.prepare(`SELECT email FROM draft_shares WHERE draft_id = ? ORDER BY added_at`);
const stmtAddShare = db.prepare(`
  INSERT INTO draft_shares (draft_id, email, added_by, added_at) VALUES (?, ?, ?, ?)
  ON CONFLICT(draft_id, email) DO NOTHING
`);
const stmtRemoveShare = db.prepare(`DELETE FROM draft_shares WHERE draft_id = ? AND email = ?`);
const stmtIsShared = db.prepare(`SELECT 1 AS ok FROM draft_shares WHERE draft_id = ? AND email = ?`);
// Everything this user may open: their own, anything shared to their address
const stmtDraftsForUser = db.prepare(`
  SELECT d.*, o.email AS owner_email, o.name AS owner_name, e.name AS editor_name, e.email AS editor_email
  FROM drafts d
  JOIN users o ON o.id = d.owner_id
  LEFT JOIN users e ON e.id = d.updated_by
  WHERE d.owner_id = ?
     OR d.id IN (SELECT draft_id FROM draft_shares WHERE email = ?)
  ORDER BY d.updated_at DESC
`);
const stmtAllDrafts = db.prepare(`
  SELECT d.*, o.email AS owner_email, o.name AS owner_name, e.name AS editor_name, e.email AS editor_email
  FROM drafts d
  JOIN users o ON o.id = d.owner_id
  LEFT JOIN users e ON e.id = d.updated_by
  ORDER BY d.updated_at DESC
`);

// A draft is reachable by its owner, anyone it was shared with, or Helix staff.
function draftAccess(user, draftId) {
  const d = stmtDraftById.get(Number(draftId));
  if (!d) return null;
  if (d.owner_id === user.id) return { draft: d, role: 'owner' };
  if (stmtIsShared.get(d.id, user.email.toLowerCase())) return { draft: d, role: 'editor' };
  if (user.isAdmin) return { draft: d, role: 'helix' };
  return null;
}
function draftSummary(d, user) {
  return {
    id: d.id,
    title: d.title || 'Untitled onboarding',
    version: d.version,
    owner: { name: d.owner_name, email: d.owner_email },
    isOwner: d.owner_id === user.id,
    lastEditedBy: d.editor_name || d.editor_email || d.owner_name,
    lastEditedByYou: d.updated_by === user.id,
    updatedAt: d.updated_at,
    createdAt: d.created_at,
    sharedWith: stmtShareEmails.all(d.id).map(r => r.email)
  };
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const known = Buffer.from(hash, 'hex');
  const test = crypto.scryptSync(String(password), salt, 64);
  if (known.length !== test.length) return false;
  return crypto.timingSafeEqual(known, test);
}
function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_DAYS * 86400000);
  stmtInsertSession.run(token, userId, now.toISOString(), expires.toISOString());
  stmtPurgeSessions.run(now.toISOString());
  return { token, expires };
}
function sessionCookie(token, expires) {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Expires=${expires.toUTCString()}`
  ];
  if (process.env.COOKIE_SECURE === 'true') parts.push('Secure');
  return parts.join('; ');
}
function clearCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}
function currentUser(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  const row = stmtGetSession.get(token);
  if (!row) return null;
  if (new Date(row.expires_at) < new Date()) { stmtDeleteSession.run(token); return null; }
  return { id: row.user_id, email: row.email, name: row.name, company: row.company, isAdmin: !!row.is_admin, token };
}
function publicUser(u) {
  return u && { id: u.id, email: u.email, name: u.name, company: u.company, isAdmin: u.isAdmin };
}
function isValidEmail(e) {
  return typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim()) && e.length <= 254;
}
// Anyone with a Helix address administers submissions; everyone else is a client user.
function adminEmail(email) {
  return /@helixbenefits\.net$/i.test(String(email || '').trim());
}

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
    if (record._userId) {
      db.prepare(`UPDATE submissions SET user_id = ? WHERE id = ?`).run(record._userId, id);
    }
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
function listMeta(user) {
  // Helix staff see every submission; a client account only sees its own.
  const rows = stmtListSubmissions.all();
  const scoped = (user && user.isAdmin) ? rows : rows.filter(r => r.user_id === user.id);
  return scoped.map(r => ({
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

  // ============== Auth routes ==============

  // POST /api/auth/register  { email, password, name, company }
  if (req.method === 'POST' && pathname === '/api/auth/register') {
    try {
      let body; try { body = JSON.parse(await readBody(req)); } catch { return sendJson(res, 400, { error: 'Invalid JSON' }); }
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      const name = String(body.name || '').trim();
      if (!isValidEmail(email)) return sendJson(res, 400, { error: 'Please enter a valid email address.' });
      if (password.length < 8) return sendJson(res, 400, { error: 'Password must be at least 8 characters.' });
      if (!name) return sendJson(res, 400, { error: 'Please enter your name.' });
      if (stmtUserByEmail.get(email)) return sendJson(res, 409, { error: 'An account with that email already exists. Try signing in instead.' });

      const info = stmtCreateUser.run(email, name, String(body.company || '').trim(), hashPassword(password),
        adminEmail(email) ? 1 : 0, new Date().toISOString());
      const userId = Number(info.lastInsertRowid);
      const { token, expires } = createSession(userId);
      res.setHeader('Set-Cookie', sessionCookie(token, expires));
      console.log(`[auth] registered ${email}${adminEmail(email) ? ' (admin)' : ''}`);
      return sendJson(res, 201, { ok: true, user: publicUser(currentUser({ headers: { cookie: `${SESSION_COOKIE}=${token}` } })) });
    } catch (e) {
      console.error('register error:', e);
      return sendJson(res, 500, { error: 'Could not create the account.' });
    }
  }

  // POST /api/auth/login  { email, password }
  if (req.method === 'POST' && pathname === '/api/auth/login') {
    try {
      let body; try { body = JSON.parse(await readBody(req)); } catch { return sendJson(res, 400, { error: 'Invalid JSON' }); }
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      const user = stmtUserByEmail.get(email);
      // Same message either way so we don't reveal which emails have accounts
      if (!user || !verifyPassword(password, user.password_hash)) {
        return sendJson(res, 401, { error: 'Email or password is incorrect.' });
      }
      stmtTouchLogin.run(new Date().toISOString(), user.id);
      const { token, expires } = createSession(user.id);
      res.setHeader('Set-Cookie', sessionCookie(token, expires));
      console.log(`[auth] login ${email}`);
      return sendJson(res, 200, { ok: true, user: { id: user.id, email: user.email, name: user.name, company: user.company, isAdmin: !!user.is_admin } });
    } catch (e) {
      console.error('login error:', e);
      return sendJson(res, 500, { error: 'Could not sign in.' });
    }
  }

  // POST /api/auth/logout
  if (req.method === 'POST' && pathname === '/api/auth/logout') {
    const u = currentUser(req);
    if (u) stmtDeleteSession.run(u.token);
    res.setHeader('Set-Cookie', clearCookie());
    return sendJson(res, 200, { ok: true });
  }

  // GET /api/auth/me
  if (req.method === 'GET' && pathname === '/api/auth/me') {
    const u = currentUser(req);
    if (!u) return sendJson(res, 401, { error: 'Not signed in' });
    return sendJson(res, 200, { user: publicUser(u) });
  }

  // ============== Draft routes (shared documents) ==============
  if (pathname === '/api/drafts' || pathname.startsWith('/api/drafts/')) {
    const u = currentUser(req);
    if (!u) return sendJson(res, 401, { error: 'Not signed in' });

    // GET /api/drafts — everything this person can open
    if (req.method === 'GET' && pathname === '/api/drafts') {
      const rows = u.isAdmin ? stmtAllDrafts.all() : stmtDraftsForUser.all(u.id, u.email.toLowerCase());
      return sendJson(res, 200, { drafts: rows.map(d => draftSummary(d, u)) });
    }

    // POST /api/drafts — start a new one
    if (req.method === 'POST' && pathname === '/api/drafts') {
      let body; try { body = JSON.parse(await readBody(req)); } catch { return sendJson(res, 400, { error: 'Invalid JSON' }); }
      const now = new Date().toISOString();
      const info = stmtCreateDraft.run(String(body.title || '').slice(0, 200) || null,
        u.id, JSON.stringify(body.draft || {}), now, now, u.id);
      const d = stmtDraftById.get(Number(info.lastInsertRowid));
      return sendJson(res, 201, { ok: true, draft: draftSummary(d, u) });
    }

    const dm = pathname.match(/^\/api\/drafts\/(\d+)(\/share)?$/);
    if (dm) {
      const access = draftAccess(u, dm[1]);
      if (!access) return sendJson(res, 404, { error: 'Not found, or not shared with you' });
      const { draft, role } = access;

      // Share management — owner (or Helix) decides who else gets in
      if (dm[2] === '/share') {
        if (role === 'editor') return sendJson(res, 403, { error: 'Only the person who started this can invite others.' });
        if (req.method === 'POST') {
          let body; try { body = JSON.parse(await readBody(req)); } catch { return sendJson(res, 400, { error: 'Invalid JSON' }); }
          const email = String(body.email || '').trim().toLowerCase();
          if (!isValidEmail(email)) return sendJson(res, 400, { error: 'Please enter a valid email address.' });
          if (email === draft.owner_email.toLowerCase()) return sendJson(res, 400, { error: 'That person already owns this onboarding.' });
          stmtAddShare.run(draft.id, email, u.id, new Date().toISOString());
          console.log(`[draft ${draft.id}] shared with ${email} by ${u.email}`);
          return sendJson(res, 200, { ok: true, sharedWith: stmtShareEmails.all(draft.id).map(r => r.email) });
        }
        if (req.method === 'DELETE') {
          let body; try { body = JSON.parse(await readBody(req)); } catch { return sendJson(res, 400, { error: 'Invalid JSON' }); }
          stmtRemoveShare.run(draft.id, String(body.email || '').trim().toLowerCase());
          return sendJson(res, 200, { ok: true, sharedWith: stmtShareEmails.all(draft.id).map(r => r.email) });
        }
      }

      if (req.method === 'GET') {
        return sendJson(res, 200, {
          meta: draftSummary(draft, u),
          draft: JSON.parse(draft.payload)
        });
      }

      if (req.method === 'PUT') {
        let body; try { body = JSON.parse(await readBody(req)); } catch { return sendJson(res, 400, { error: 'Invalid JSON' }); }
        // Two people editing the same onboarding must not silently overwrite
        // each other — the client sends the version it started from.
        if (body.version != null && Number(body.version) !== draft.version) {
          return sendJson(res, 409, {
            error: 'conflict',
            message: `${draft.editor_name || draft.editor_email || 'Someone else'} saved changes to this onboarding after you opened it.`,
            meta: draftSummary(draft, u)
          });
        }
        const now = new Date().toISOString();
        stmtUpdateDraft.run(JSON.stringify(body.draft || {}),
          String(body.title || draft.title || '').slice(0, 200) || null, now, u.id, draft.id);
        const fresh = stmtDraftById.get(draft.id);
        return sendJson(res, 200, { ok: true, meta: draftSummary(fresh, u) });
      }

      if (req.method === 'DELETE') {
        if (role === 'editor') return sendJson(res, 403, { error: 'Only the person who started this can delete it.' });
        stmtDeleteDraftById.run(draft.id);
        return sendJson(res, 200, { ok: true });
      }
    }
    return sendJson(res, 404, { error: 'Unknown draft route' });
  }

  // Everything below this line requires a signed-in user
  if (pathname.startsWith('/api/')) {
    const u = currentUser(req);
    if (!u) return sendJson(res, 401, { error: 'Not signed in' });
    req.user = u;
  }

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
      const record = { _id: id, _receivedAt: ts.toISOString(), _userId: req.user.id, ...body };
      // Trust the signed-in account over whatever the browser posted
      record.submitter = Object.assign({}, record.submitter, {
        email: req.user.email,
        name: (record.submitter && record.submitter.name) || req.user.name
      });

      // Write JSON backup (handy for offline review / git diff)
      const file = path.join(SUBMISSIONS_DIR, id + '.json');
      fs.writeFileSync(file, JSON.stringify(record, null, 2), 'utf8');

      // Insert into DB
      insertSubmission(record);
      // The form is submitted — the working draft is no longer needed
      if (body._draftId && draftAccess(req.user, body._draftId)) {
        stmtDeleteDraftById.run(Number(body._draftId));
      }

      console.log(`[${ts.toISOString()}] Stored submission ${id} (user ${req.user.email})`);

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
    try { return sendJson(res, 200, listMeta(req.user)); }
    catch (e) { return sendJson(res, 500, { error: e.message }); }
  }

  // GET /api/plans
  if (req.method === 'GET' && pathname === '/api/plans') {
    if (!req.user.isAdmin) return sendJson(res, 403, { error: 'Helix staff only' });
    try { return sendJson(res, 200, stmtListAllPlans.all()); }
    catch (e) { return sendJson(res, 500, { error: e.message }); }
  }

  // GET /api/export.csv
  if (req.method === 'GET' && pathname === '/api/export.csv') {
    const rows = listMeta(req.user);
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
    // A client account may only touch its own submissions
    const owner = db.prepare(`SELECT user_id FROM submissions WHERE id = ?`).get(id);
    if (owner && !req.user.isAdmin && owner.user_id !== req.user.id) {
      return sendJson(res, 403, { error: 'Not your submission' });
    }
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

  // Pages that require a signed-in user — bounce to the login screen
  const GATED_PAGES = ['/', '/index.html', '/benefit-plan-setup.html', '/admin', '/admin.html'];
  if (GATED_PAGES.includes(pathname) && !currentUser(req)) {
    const next = encodeURIComponent(pathname === '/' ? '/benefit-plan-setup.html' : pathname);
    res.writeHead(302, { Location: `/login.html?next=${next}` });
    return res.end();
  }

  // /admin → admin.html (Helix staff only)
  if (pathname === '/admin' || pathname === '/admin.html') {
    const u = currentUser(req);
    if (!u.isAdmin) {
      res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<h2 style="font-family:Segoe UI,Arial,sans-serif;padding:40px">403 — Helix staff only.</h2>'
        + '<p style="font-family:Segoe UI,Arial,sans-serif;padding:0 40px"><a href="/benefit-plan-setup.html">Back to the onboarding form</a></p>');
    }
    req.url = '/admin.html';
    return serveStatic(req, res);
  }

  return serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`Helix Onboarding server listening on http://localhost:${PORT}`);
  console.log(`  Form:   http://localhost:${PORT}/benefit-plan-setup.html`);
  console.log(`  Admin:  http://localhost:${PORT}/admin`);
  console.log(`  DB:     ${DB_PATH}`);
  console.log(`  JSON:   ${SUBMISSIONS_DIR} (kept as backup)`);
});
