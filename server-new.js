#!/usr/bin/env node

/**
 * EmailBot API Server
 * REST API for EmailBot Dashboard frontend
 */

const path = require('path');

// Load environment variables from .env file (only in development)
if (process.env.NODE_ENV !== 'production' && process.env.RAILWAY_ENVIRONMENT !== 'production') {
  require('dotenv').config({ path: path.join(__dirname, '.env') });
}

// Normalize Google auth env vars (Railway can have either naming)
if (!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL && process.env.SERVICE_ACCOUNT_EMAIL) {
  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = process.env.SERVICE_ACCOUNT_EMAIL;
}
if (!process.env.SERVICE_ACCOUNT_EMAIL && process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL) {
  process.env.SERVICE_ACCOUNT_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
}

// Fix escaped newlines in private key (dotenv doesn't expand \n escapes)
if (process.env.GOOGLE_PRIVATE_KEY && process.env.GOOGLE_PRIVATE_KEY.includes('\\n')) {
  process.env.GOOGLE_PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n');
}

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const jsonfile = require('jsonfile');

const { Pool } = require('pg');

const EmailBot = require('./src/index');

// Configuration
const PORT = process.env.PORT || process.env.API_PORT || 3001;
// Data stored in api/emailbot/data/ directory ( Railway persistent )
const DATA_DIR = path.join(__dirname, 'data');
const STATE_DIR = process.env.STATE_PATH || path.join(DATA_DIR, 'state');
const DRAFTS_DIR = process.env.DRAFTS_PATH || path.join(DATA_DIR, 'drafts');
const ACTIVITY_LOG = path.join(STATE_DIR, 'activity.log');

// Ensure data directories exist
[DATA_DIR, STATE_DIR, DRAFTS_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Initialize EmailBot
const emailbot = new EmailBot();

// Optional PostgreSQL (recommended): store leads/emails/activity in DB
let pgPool = null;
if (process.env.DATABASE_URL) {
  pgPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
}

async function pgQuery(text, params = []) {
  if (!pgPool) throw new Error('DATABASE_URL not configured');
  return pgPool.query(text, params);
}

const app = express();

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

// Middleware
app.use(cors());
app.use(express.json());

// Helper: Load drafts
async function loadDrafts(status) {
  // Prefer Postgres when available
  if (pgPool) {
    const params = [];
    let where = '';
    if (status) {
      params.push(status);
      where = `WHERE status = $${params.length}`;
    }

    const { rows } = await pgQuery(
      `SELECT draft
         FROM drafts
         ${where}
        ORDER BY generated_at DESC`,
      params
    );

    return rows.map(r => (typeof r.draft === 'string' ? JSON.parse(r.draft) : r.draft));
  }

  // File fallback
  if (!fs.existsSync(DRAFTS_DIR)) return [];

  const files = fs.readdirSync(DRAFTS_DIR).filter(f => f.endsWith('.json'));
  const drafts = files.map(f => {
    try {
      return jsonfile.readFileSync(path.join(DRAFTS_DIR, f));
    } catch (e) { return null; }
  }).filter(Boolean);

  if (status) {
    return drafts.filter(d => d.status === status);
  }
  return drafts.sort((a, b) => new Date(b.generatedAt) - new Date(a.generatedAt));
}

// Helper: Get single draft
async function getDraft(id) {
  if (pgPool) {
    const { rows } = await pgQuery('SELECT draft FROM drafts WHERE id = $1 LIMIT 1', [id]);
    const d = rows?.[0]?.draft;
    return d ? (typeof d === 'string' ? JSON.parse(d) : d) : null;
  }

  const filepath = path.join(DRAFTS_DIR, `${id}.json`);
  if (fs.existsSync(filepath)) {
    return jsonfile.readFileSync(filepath);
  }
  return null;
}

// Helper: Save draft
async function saveDraft(draft) {
  if (pgPool) {
    const generatedAt = draft.generatedAt || new Date().toISOString();
    const updatedAt = draft.updatedAt || null;
    await pgQuery(
      `INSERT INTO drafts (id, status, generated_at, updated_at, gmail_id, thread_id, email, company, draft)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (id) DO UPDATE SET
         status = EXCLUDED.status,
         generated_at = EXCLUDED.generated_at,
         updated_at = EXCLUDED.updated_at,
         gmail_id = EXCLUDED.gmail_id,
         thread_id = EXCLUDED.thread_id,
         email = EXCLUDED.email,
         company = EXCLUDED.company,
         draft = EXCLUDED.draft`,
      [
        draft.id,
        draft.status || null,
        generatedAt,
        updatedAt,
        draft.emailData?.gmailId || null,
        draft.emailData?.threadId || null,
        draft.client?.email || null,
        draft.client?.company || null,
        JSON.stringify(draft)
      ]
    );
    return;
  }

  const filepath = path.join(DRAFTS_DIR, `${draft.id}.json`);
  jsonfile.writeFileSync(filepath, draft, { spaces: 2 });
}

// Helper: Add activity
function addActivity(type, message, details) {
  const entry = {
    timestamp: new Date().toISOString(),
    type,
    message,
    details
  };

  // File-based activity log (legacy / fallback)
  fs.appendFileSync(ACTIVITY_LOG, JSON.stringify(entry) + '\n');

  // Also persist in Postgres when available
  if (pgPool) {
    pgQuery(
      `INSERT INTO activity (type, description, entity_type, entity_id, metadata)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        type,
        message,
        details?.entityType || null,
        details?.entityId || details?.id || null,
        details ? JSON.stringify(details) : JSON.stringify({})
      ]
    ).catch(() => {
      // ignore activity write failures
    });
  }
}

// Helper: Get activity
async function getActivity(limit = 50) {
  // Prefer Postgres when available
  if (pgPool) {
    try {
      const { rows } = await pgQuery(
        `SELECT created_at AS timestamp, type, description AS message, metadata AS details
         FROM activity
         ORDER BY created_at DESC
         LIMIT $1`,
        [limit]
      );
      return rows.map(r => ({
        timestamp: r.timestamp,
        type: r.type,
        message: r.message,
        details: (typeof r.details === 'string') ? (safeJsonParse(r.details) || {}) : (r.details || {})
      }));
    } catch (e) {
      // fall through to file
    }
  }

  // File fallback
  if (!fs.existsSync(ACTIVITY_LOG)) return [];
  const raw = fs.readFileSync(ACTIVITY_LOG, 'utf-8').trim();
  if (!raw) return [];
  const lines = raw.split('\n');
  return lines.slice(-limit).reverse().map(line => safeJsonParse(line)).filter(Boolean);
}

// Helper: Get metrics
async function getMetrics() {
  console.log('[getMetrics] Starting...');
  
  const drafts = await loadDrafts();
  const pending = drafts.filter(d => d.status === 'pending_review');
  const approved = drafts.filter(d => d.status === 'approved');
  const sent = drafts.filter(d => d.status === 'sent');
  const rejected = drafts.filter(d => d.status === 'rejected');
  
  const today = new Date().toISOString().split('T')[0];
  const approvedToday = approved.filter(d => d.approval?.approvedAt?.startsWith(today)).length;
  const sentToday = sent.filter(d => d.sentAt?.startsWith(today)).length;
  
  // Fetch unread emails from Gmail
  let unreadEmails = 0;
  try {
    const Ingestor = require('./src/ingestor');
    const ingestor = new Ingestor(emailbot.config, emailbot.logger);
    const gmail = await ingestor.getGmailClient();
    const response = await gmail.users.messages.list({
      userId: 'me',
      q: 'is:unread',
      maxResults: 1
    });
    unreadEmails = response.data.resultSizeEstimate || 0;
  } catch (e) {
    console.warn('Could not fetch unread emails:', e.message);
  }
  
  // Fetch leads count from Postgres
  let newLeads = 0;
  try {
    if (pgPool) {
      const { rows } = await pgQuery('SELECT COUNT(*)::int AS count FROM leads');
      newLeads = rows?.[0]?.count ?? 0;
    }
  } catch (e) {
    console.warn('Could not fetch Postgres leads:', e.message);
  }
  
  // Enhanced metrics for dashboard (per audit requirements)
  const now = new Date();
  const oneDayAgo = new Date(now - 24 * 60 * 60 * 1000);
  const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
  
  // Trend calculations
  const unreadThisWeek = drafts.filter(d => 
    d.generatedAt && new Date(d.generatedAt) > sevenDaysAgo
  ).length;
  
  const leadsToday = newLeads; // Already fetched
  
  // Urgent drafts (SLA deadline within 1 hour)
  const urgentDrafts = pending.filter(d => {
    if (!d.analysis?.slaDeadline) return false;
    const deadline = new Date(d.analysis.slaDeadline);
    return deadline < new Date(now.getTime() + 60 * 60 * 1000);
  }).length;
  
  // Average delay for pending drafts
  let avgDelayHours = 0;
  if (pending.length > 0) {
    const totalDelay = pending.reduce((sum, d) => {
      if (!d.generatedAt) return sum;
      const generated = new Date(d.generatedAt);
      const delay = (now - generated) / (1000 * 60 * 60); // hours
      return sum + delay;
    }, 0);
    avgDelayHours = (totalDelay / pending.length).toFixed(1);
  }
  
  // Form submissions (from leads with form_type)
  const formSubmissions = newLeads; // Simplified - actual implementation would filter by form_type
  
  return {
    // Basic metrics
    unreadEmails,
    newLeads,
    pendingDrafts: pending.length,
    urgentDrafts: pending.filter(d => d.analysis?.flagged).length,
    approvedToday,
    sentToday,
    totalDrafts: drafts.length,
    approvalRate: (approved.length + rejected.length) > 0 
      ? ((approved.length / (approved.length + rejected.length)) * 100).toFixed(1)
      : 0,
    // Enhanced metrics (per audit)
    unreadTrend: unreadThisWeek > 0 ? `+${unreadThisWeek}` : '0',
    leadsTrend: leadsToday > 0 ? `+${leadsToday} new` : '0',
    urgentCount: urgentDrafts,
    avgDelayHours: parseFloat(avgDelayHours),
    formSubmissions,
    // Status thresholds
    unreadStatus: unreadEmails > 20 ? 'High' : unreadEmails > 10 ? 'Medium' : 'Low',
    // Sparkline data (last 7 days) - REAL data from drafts
    sparklineUnread: (() => {
      const now = new Date();
      const result = [];
      for (let i = 6; i >= 0; i--) {
        const date = new Date(now);
        date.setDate(date.getDate() - i);
        const dateStr = date.toISOString().split('T')[0];
        const count = drafts.filter(d => d.generatedAt && d.generatedAt.startsWith(dateStr)).length;
        result.push(count);
      }
      return result;
    })(),
  };
}

// ============ API ROUTES ============

// Admin: migrate drafts statuses
// POST /api/admin/migrate-drafts-status
// Body: { fromStatus: "needs_revision", toStatus: "pending_review", dryRun?: boolean }
app.post('/api/admin/migrate-drafts-status', async (req, res) => {
  try {
    const fromStatus = String(req.body?.fromStatus || 'needs_revision');
    const toStatus = String(req.body?.toStatus || 'pending_review');
    const dryRun = !!req.body?.dryRun;

    const drafts = await loadDrafts();
    const candidates = drafts.filter(d => String(d.status || '') === fromStatus);

    const migrated = [];
    for (const d of candidates) {
      migrated.push({ id: d.id, oldStatus: d.status, newStatus: toStatus });
      if (!dryRun) {
        d.status = toStatus;
        d.updatedAt = new Date().toISOString();
        await saveDraft(d);
      }
    }

    addActivity('admin', `Migrated drafts status ${fromStatus} -> ${toStatus}`, {
      fromStatus,
      toStatus,
      dryRun,
      count: migrated.length,
    });

    return res.json({
      success: true,
      dryRun,
      fromStatus,
      toStatus,
      count: migrated.length,
      migrated,
    });
  } catch (error) {
    return res.status(500).json({ error: 'Migration failed', message: error.message });
  }
});

// GET /api/drafts - List drafts or get single by ?id=
app.get('/api/drafts', async (req, res) => {
  try {
    const id = req.query.id;
    const status = req.query.status || undefined;
    
    if (id) {
      const draft = await getDraft(id);
      if (!draft) {
        return res.status(404).json({ error: 'Draft not found' });
      }
      return res.json({ draft });
    }
    
    const drafts = await loadDrafts(status);
    res.json({ drafts });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch drafts' });
  }
});

// GET /api/drafts/:id - Get single draft
app.get('/api/drafts/:id', async (req, res) => {
  try {
    const draft = await getDraft(req.params.id);
    if (!draft) {
      return res.status(404).json({ error: 'Draft not found' });
    }
    res.json({ draft });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch draft' });
  }
});

// POST /api/drafts/generate - Generate a draft for ANY email (inbox/unread)
// Body: { gmailId, threadId }
app.post('/api/drafts/generate', async (req, res) => {
  const startedAt = Date.now();
  try {
    const { gmailId, threadId } = req.body || {};
    if (!gmailId) return res.status(400).json({ error: 'gmailId is required' });

    // Dedupe: if draft already exists for this gmailId/threadId, return it
    const existing = (await loadDrafts()).find((d) =>
      (d?.emailData?.gmailId && String(d.emailData.gmailId) === String(gmailId)) ||
      (threadId && d?.emailData?.threadId && String(d.emailData.threadId) === String(threadId))
    );
    if (existing) {
      return res.json({ success: true, draft: existing, deduped: true });
    }

    addActivity('draft', 'Draft generation requested', { entityType: 'draft', gmailId, threadId });

    // Fetch email from Gmail
    const Ingestor = require('./src/ingestor');
    const ingestor = new Ingestor(emailbot.config, emailbot.logger);
    const gmail = await ingestor.getGmailClient();

    const msg = await gmail.users.messages.get({ userId: 'me', id: gmailId, format: 'full' });
    const headers = msg.data?.payload?.headers || [];
    const subject = headers.find((h) => h.name === 'Subject')?.value || '';
    const fromRaw = headers.find((h) => h.name === 'From')?.value || '';
    const date = headers.find((h) => h.name === 'Date')?.value || '';

    const fromName = fromRaw.includes('<') ? fromRaw.split('<')[0].trim().replace(/"/g, '') : fromRaw;
    const fromEmail = fromRaw.match(/<([^>]+)>/)?.[1] || '';

    const body = ingestor.extractBody(msg.data) || '';

    // Build minimal emailData for analyzer/drafter
    const emailData = {
      gmailId,
      threadId: msg.data?.threadId || threadId,
      subject,
      from: fromName || fromRaw || 'Unknown',
      email: fromEmail,
      name: fromName || 'Unknown',
      company: null,
      service: null,
      message: body,
      date,
      receivedAt: new Date().toISOString(),
    };

    const analysis = await emailbot.analyze(emailData);
    const draft = await emailbot.generateDraft(analysis);

    addActivity('draft', 'Draft generated', {
      entityType: 'draft',
      gmailId,
      threadId: emailData.threadId,
      draftId: draft.id,
      durationMs: Date.now() - startedAt,
    });

    return res.json({ success: true, draft });
  } catch (error) {
    addActivity('error', 'Draft generation failed', {
      entityType: 'draft',
      error: error.message,
      durationMs: Date.now() - startedAt,
    });
    return res.status(500).json({ error: 'Failed to generate draft', message: error.message });
  }
});

// POST /api/drafts - Approve/Reject/Edit
app.post('/api/drafts', async (req, res) => {
  try {
    const { action, draftId, reason, newContent, editorNotes } = req.body;
    
    const draft = await getDraft(draftId);
    if (!draft) {
      return res.status(404).json({ error: 'Draft not found' });
    }

    if (action === 'approve') {
      draft.status = 'approved';
      draft.approval = {
        approver: 'Marcelo',
        approvedAt: new Date().toISOString(),
        marceloEdit: newContent || null,
        rejectionReason: null
      };
      if (newContent) {
        draft.draft = newContent;
      }
      await saveDraft(draft);
      addActivity('user', `Approved draft to ${draft.client?.email || 'unknown'}`, { draftId });
      return res.json({ success: true, draft });
    }

    if (action === 'reject') {
      draft.status = 'rejected';
      draft.approval = {
        approver: 'Marcelo',
        approvedAt: new Date().toISOString(),
        rejectionReason: reason
      };
      await saveDraft(draft);
      addActivity('user', `Rejected draft to ${draft.client?.email || 'unknown'}`, { draftId, reason });
      return res.json({ success: true, draft });
    }

    if (action === 'edit') {
      // Edited by user: should return to pending review for approval/send
      draft.status = 'pending_review';
      draft.draft = newContent;
      draft.approval = {
        ...draft.approval,
        marceloEdit: newContent,
        editorNotes: editorNotes || 'Edited by Marcelo'
      };
      await saveDraft(draft);
      addActivity('user', `Edited draft to ${draft.client?.email || 'unknown'}`, { draftId });
      return res.json({ success: true, draft });
    }

    res.status(400).json({ error: 'Invalid action' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to process draft action' });
  }
});

// GET /api/metrics
// Debug endpoint
app.get('/api/test', (req, res) => {
  res.json({ message: 'Backend is working!', timestamp: new Date().toISOString() });
});

// Test endpoint
app.get('/api/test', (req, res) => {
  res.json({ test: 'working', time: new Date().toISOString() });
});

app.get('/api/metrics', async (req, res) => {
  try {
    console.log('[METRICS] Starting...');
    const metrics = await getMetrics();
    console.log('[METRICS] Result:', JSON.stringify(metrics));
    res.json({ metrics });
  } catch (error) {
    console.error('[METRICS] Error:', error.message);
    res.status(500).json({ error: 'Failed to fetch metrics' });
  }
});

// GET /api/metrics/sparkline - REAL data for sparkline charts
app.get('/api/metrics/sparkline', async (req, res) => {
  try {
    const { metric = 'unread_emails', days = 7 } = req.query;
    const drafts = await loadDrafts();
    const now = new Date();
    const result = [];
    
    for (let i = days - 1; i >= 0; i--) {
      const date = new Date(now);
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split('T')[0];
      
      if (metric === 'unread_emails') {
        // Count drafts generated per day
        const count = drafts.filter(d => 
          d.generatedAt && d.generatedAt.startsWith(dateStr)
        ).length;
        result.push(count);
      } else if (metric === 'pending_drafts') {
        const count = drafts.filter(d => 
          d.status === 'pending_review' && 
          d.generatedAt && d.generatedAt.startsWith(dateStr)
        ).length;
        result.push(count);
      } else if (metric === 'leads') {
        // Real leads data would need Notion query - return 0 for now
        result.push(0);
      } else {
        result.push(0);
      }
    }
    
    res.json({ sparkline: result, metric, days: parseInt(days) });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch sparkline data' });
  }
});

// PATCH /api/drafts/:id/draft - Save edited draft without sending (NEW)
app.patch('/api/drafts/:id/draft', async (req, res) => {
  try {
    const { id } = req.params;
    const { draft_body } = req.body;
    
    const draft = await getDraft(id);
    if (!draft) {
      return res.status(404).json({ error: 'Draft not found' });
    }
    
    draft.draft = draft_body;
    // Saving an edit means it's ready for re-approval
    draft.status = 'pending_review';
    draft.updatedAt = new Date().toISOString();
    
    await saveDraft(draft);
    addActivity('user', `Saved draft edit for ${draft.client?.email || 'unknown'}`, { draftId: id });
    
    res.json({ success: true, draft });
  } catch (error) {
    res.status(500).json({ error: 'Failed to save draft' });
  }
});

// POST /api/drafts/:id/regenerate - Regenerate with instructions (NEW)
app.post('/api/drafts/:id/regenerate', async (req, res) => {
  try {
    const { id } = req.params;
    const { tone, instruction = 'rewrite' } = req.body;
    
    const draft = await getDraft(id);
    if (!draft) {
      return res.status(404).json({ error: 'Draft not found' });
    }
    
    // Store regeneration instruction for the worker
    draft.regenerateInstruction = instruction;
    if (tone) {
      draft.analysis = draft.analysis || {};
      draft.analysis.tone = tone;
    }
    draft.status = 'generating';
    draft.updatedAt = new Date().toISOString();
    
    await saveDraft(draft);
    addActivity('agent', `Regenerating draft for ${draft.client?.email || 'unknown'}`, { draftId: id, instruction });
    
    // TODO: Trigger actual regeneration via Gemini (async)
    // For now, return success and let background worker handle it
    
    res.json({ success: true, draft, message: 'Regeneration queued' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to queue regeneration' });
  }
});

// GET /api/dashboard
app.get('/api/dashboard', async (req, res) => {
  try {
    const metrics = await getMetrics();
    const activity = await getActivity(20);
    const pending = await loadDrafts('pending_review');
    
    res.json({
      metrics,
      activity,
      pendingDrafts: pending.slice(0, 5),
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch dashboard' });
  }
});

// GET /api/activity
app.get('/api/activity', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const activity = await getActivity(limit);
    res.json({ activity });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch activity' });
  }
});

// POST /api/forms/contact - Receive contact form submissions
app.post('/api/forms/contact', async (req, res) => {
  try {
    const { name, email, message, company = null, phone = null } = req.body || {};

    if (!name || !email || !message) {
      return res.status(400).json({
        success: false,
        error: 'name, email and message are required'
      });
    }

    const submission = {
      id: `form_${Date.now()}`,
      name,
      email,
      company,
      phone,
      message,
      source: 'contact_form',
      receivedAt: new Date().toISOString()
    };

    addActivity('form_submission', `New contact form from ${email}`, {
      name,
      email,
      company,
      id: submission.id
    });

    return res.status(201).json({ success: true, submission });
  } catch (error) {
    return res.status(500).json({ success: false, error: 'Failed to save form submission' });
  }
});

// POST /api/ingest - Trigger email ingestion
app.post('/api/ingest', async (req, res) => {
  try {
    const result = await emailbot.ingest(req.body);

    // Persist processed leads into Postgres when available
    if (pgPool && result?.processed?.length) {
      for (const lead of result.processed) {
        const receivedAt = lead.receivedAt ? new Date(lead.receivedAt) : new Date();
        const email = lead.email || '';
        if (!email) continue;

        // Best-effort dedupe: same email + received_at
        await pgQuery(
          `INSERT INTO leads (name, email, company, phone, form_type, source, score, status, notes, received_at, metadata)
           SELECT $1,$2,$3,$4,$5,$6,$7,'new',NULL,$8,$9
           WHERE NOT EXISTS (
             SELECT 1 FROM leads WHERE email = $2 AND received_at = $8
           )`,
          [
            lead.name || 'Unknown',
            email,
            lead.company || null,
            lead.phone || null,
            lead.service || lead.formType || null,
            'gmail',
            0,
            receivedAt,
            JSON.stringify({
              gmailId: lead.gmailId,
              threadId: lead.threadId,
              subject: lead.subject,
              from: lead.from,
              raw: lead
            })
          ]
        );
      }

      addActivity('ingest', `Ingested ${result.processed.length} lead(s) into Postgres`, {
        entityType: 'lead',
        count: result.processed.length
      });
    }

    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ error: 'Ingestion failed: ' + error.message });
  }
});

// POST /api/sync/notion - Sync with Notion
app.post('/api/sync/notion', async (req, res) => {
  try {
    const result = await emailbot.syncNotion();
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ error: 'Sync failed: ' + error.message });
  }
});

// GET /api/emails - List emails from Gmail
app.get('/api/emails', async (req, res) => {
  try {
    const { limit = 50, unread, filter } = req.query;
    const Ingestor = require('./src/ingestor');
    const ingestor = new Ingestor(emailbot.config, emailbot.logger);
    const gmail = await ingestor.getGmailClient();
    
    // Build query
    let q = filter || '';
    if (unread === 'true' || unread === '1') {
      q = 'is:unread' + (q ? ' ' + q : '');
    }
    
    // List messages
    const response = await gmail.users.messages.list({
      userId: 'me',
      q: q || undefined,
      maxResults: parseInt(limit)
    });
    
    const messages = response.data.messages || [];
    
    // Fetch details for each message
    const emails = [];
    for (const msg of messages) {
      try {
        const detail = await gmail.users.messages.get({
          userId: 'me',
          id: msg.id,
          format: 'metadata',
          metadataHeaders: ['From', 'To', 'Subject', 'Date']
        });
        
        const headers = detail.data.payload.headers;
        const getHeader = (name) => headers.find(h => h.name === name)?.value || '';
        
        emails.push({
          id: msg.id,
          threadId: detail.data.threadId,
          from: getHeader('From'),
          to: getHeader('To'),
          subject: getHeader('Subject'),
          date: getHeader('Date'),
          unread: detail.data.labelIds?.includes('UNREAD'),
          snippet: detail.data.snippet,
          labels: detail.data.labelIds || []
        });
      } catch (e) {
        console.warn('Failed to fetch email details:', e.message);
      }
    }
    
    res.json({ 
      emails,
      total: response.data.resultSizeEstimate || emails.length
    });
  } catch (error) {
    console.error('ERROR: Using NEW code - Failed to list emails:', error.message);
    res.status(500).json({ error: 'ERROR: Using NEW code - Failed to list emails: ' + error.message });
  }
});

// GET /api/emails/unread - Count unread emails from Gmail
app.get('/api/emails/unread', async (req, res) => {
  try {
    const Ingestor = require('./src/ingestor');
    const ingestor = new Ingestor(emailbot.config, emailbot.logger);
    const gmail = await ingestor.getGmailClient();
    
    // Count unread emails
    const response = await gmail.users.messages.list({
      userId: 'me',
      q: 'is:unread',
      maxResults: 1
    });
    
    // Get total count from result
    const totalUnread = response.data.resultSizeEstimate || 0;
    
    res.json({ unreadEmails: totalUnread });
  } catch (error) {
    console.error('Failed to count unread emails:', error.message);
    res.json({ unreadEmails: 0, error: error.message });
  }
});

// GET /api/emails/:id - Get single email by ID
app.get('/api/emails/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const Ingestor = require('./src/ingestor');
    const ingestor = new Ingestor(emailbot.config, emailbot.logger);
    const gmail = await ingestor.getGmailClient();
    
    // Fetch the specific email
    const response = await gmail.users.messages.get({
      userId: 'me',
      id: id,
      format: 'full'
    });
    
    // Parse email data
    const message = response.data;
    const headers = message.payload.headers;
    
    const getHeader = (name) => {
      const h = headers.find(h => h.name.toLowerCase() === name.toLowerCase());
      return h ? h.value : '';
    };
    
    // Get email body
    let body = '';
    if (message.payload.body.data) {
      body = Buffer.from(message.payload.body.data, 'base64').toString('utf-8');
    } else if (message.payload.parts) {
      const part = message.payload.parts.find(p => p.mimeType === 'text/plain') || 
                   message.payload.parts[0];
      if (part && part.body && part.body.data) {
        body = Buffer.from(part.body.data, 'base64').toString('utf-8');
      }
    }
    
    const email = {
      id: message.id,
      threadId: message.threadId,
      from: {
        name: getHeader('From').split('<')[0].trim(),
        email: getHeader('From').match(/<(.+)>/)?.[1] || getHeader('From')
      },
      to: getHeader('To'),
      subject: getHeader('Subject'),
      body: body.substring(0, 5000), // Limit body size
      bodyPreview: body.substring(0, 200),
      receivedAt: getHeader('Date'),
      status: message.labelIds?.includes('UNREAD') ? 'unread' : 'read',
      labels: message.labelIds || []
    };
    
    res.json({ email });
  } catch (error) {
    console.error('Failed to fetch email:', error.message);
    res.status(500).json({ error: 'Failed to fetch email: ' + error.message });
  }
});

// PATCH /api/emails/:id - Update email (status, labels, etc.)
app.patch('/api/emails/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, addLabels, removeLabels } = req.body;
    
    const Ingestor = require('./src/ingestor');
    const ingestor = new Ingestor(emailbot.config, emailbot.logger);
    const gmail = await ingestor.getGmailClient();
    
    const updates = {};
    
    // Handle read/unread status
    if (status === 'read' || status === 'unread') {
      const labelId = status === 'read' ? 'INBOX' : 'UNREAD';
      updates.addLabels = [labelId];
    }
    
    // Handle custom labels
    if (addLabels?.length > 0) {
      updates.addLabels = [...(updates.addLabels || []), ...addLabels];
    }
    if (removeLabels?.length > 0) {
      updates.removeLabels = removeLabels;
    }
    
    // Apply updates
    if (Object.keys(updates).length > 0) {
      await gmail.users.messages.modify({
        userId: 'me',
        id: id,
        addLabelIds: updates.addLabels || [],
        removeLabelIds: updates.removeLabels || []
      });
    }
    
    res.json({ success: true, id, updates });
  } catch (error) {
    console.error('Failed to update email:', error.message);
    res.status(500).json({ error: 'Failed to update email: ' + error.message });
  }
});

// GET /api/leads/count - Count leads from Postgres
app.get('/api/leads/count', async (req, res) => {
  try {
    if (!pgPool) {
      return res.json({ totalLeads: 0, error: 'Postgres not configured (missing DATABASE_URL)' });
    }

    const { rows } = await pgQuery('SELECT COUNT(*)::int AS count FROM leads');
    res.json({ totalLeads: rows?.[0]?.count ?? 0 });
  } catch (error) {
    console.error('Failed to count Postgres leads:', error.message);
    res.json({ totalLeads: 0, error: error.message });
  }
});

// GET /api/leads - List leads from Postgres with pagination
app.get('/api/leads', async (req, res) => {
  try {
    const { page = 1, limit = 20, sort = 'desc' } = req.query;

    if (!pgPool) {
      return res.json({ leads: [], total: 0, page: parseInt(page), limit: parseInt(limit), error: 'Postgres not configured (missing DATABASE_URL)' });
    }

    const pageSize = Math.min(parseInt(limit) || 20, 100);
    const pageNum = parseInt(page) || 1;
    const offset = (pageNum - 1) * pageSize;
    const direction = (String(sort).toLowerCase() === 'asc') ? 'ASC' : 'DESC';

    const totalRes = await pgQuery('SELECT COUNT(*)::int AS count FROM leads');
    const total = totalRes.rows?.[0]?.count ?? 0;

    const listRes = await pgQuery(
      `SELECT id, name, email, phone, company, form_type AS "formType", source, score, status,
              received_at AS "receivedAt", created_at AS "createdAt", metadata
         FROM leads
        ORDER BY received_at ${direction}
        LIMIT $1 OFFSET $2`,
      [pageSize, offset]
    );

    res.json({
      leads: listRes.rows,
      total,
      page: pageNum,
      limit: pageSize,
      totalPages: Math.ceil(total / pageSize)
    });
  } catch (error) {
    console.error('Failed to fetch Postgres leads:', error.message);
    res.json({ leads: [], total: 0, error: error.message });
  }
});

// Migration endpoint (for PostgreSQL setup)
app.post('/api/migrate', async (req, res) => {
  try {
    const { Pool } = require('pg');
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    });
    
    const schema = `
      CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
      
      CREATE TABLE IF NOT EXISTS emails (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        notion_id TEXT UNIQUE,
        gmail_id TEXT UNIQUE,
        thread_id TEXT,
        from_name TEXT NOT NULL,
        from_email TEXT NOT NULL,
        subject TEXT NOT NULL,
        body_preview TEXT,
        body_full TEXT,
        status TEXT DEFAULT 'unread',
        category TEXT,
        priority TEXT DEFAULT 'normal',
        tags TEXT[] DEFAULT '{}',
        snoozed_until TIMESTAMPTZ,
        received_at TIMESTAMPTZ NOT NULL,
        read_at TIMESTAMPTZ,
        replied_at TIMESTAMPTZ,
        draft_body TEXT,
        draft_confidence INTEGER,
        draft_tone TEXT DEFAULT 'professional',
        draft_language TEXT DEFAULT 'en',
        draft_status TEXT DEFAULT 'none',
        draft_sla_deadline TIMESTAMPTZ,
        draft_generated_at TIMESTAMPTZ,
        agent_insight TEXT,
        metadata JSONB DEFAULT '{}',
        synced_at TIMESTAMPTZ DEFAULT now(),
        created_at TIMESTAMPTZ DEFAULT now()
      );
      
      CREATE TABLE IF NOT EXISTS leads (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        notion_id TEXT UNIQUE,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        company TEXT,
        phone TEXT,
        form_type TEXT,
        source TEXT,
        score INTEGER DEFAULT 0,
        status TEXT DEFAULT 'new',
        notes TEXT,
        received_at TIMESTAMPTZ NOT NULL,
        notion_url TEXT,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT now()
      );
      
      CREATE TABLE IF NOT EXISTS activity (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        type TEXT NOT NULL,
        description TEXT NOT NULL,
        entity_type TEXT,
        entity_id TEXT,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS drafts (
        id UUID PRIMARY KEY,
        status TEXT,
        generated_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ,
        gmail_id TEXT,
        thread_id TEXT,
        email TEXT,
        company TEXT,
        draft JSONB NOT NULL,
        created_at TIMESTAMPTZ DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS idx_drafts_status ON drafts(status);
      CREATE INDEX IF NOT EXISTS idx_drafts_generated_at ON drafts(generated_at);
      CREATE INDEX IF NOT EXISTS idx_drafts_gmail_id ON drafts(gmail_id);
      
      CREATE INDEX IF NOT EXISTS idx_emails_status ON emails(status);
      CREATE INDEX IF NOT EXISTS idx_emails_draft_status ON emails(draft_status);
      CREATE INDEX IF NOT EXISTS idx_emails_received_at ON emails(received_at);
      CREATE INDEX IF NOT EXISTS idx_leads_received_at ON leads(received_at);
      CREATE INDEX IF NOT EXISTS idx_activity_created_at ON activity(created_at);
    `;
    
    await pool.query(schema);
    await pool.end();
    
    res.json({ success: true, message: 'Migration completed' });
  } catch (error) {
    res.status(500).json({ error: 'Migration failed', details: error.message });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`📧 EmailBot API Server running on port ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health`);
  console.log(`   API:   http://localhost:${PORT}/api/*`);
});

module.exports = app;
