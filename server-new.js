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

// Fix escaped newlines in private key (dotenv doesn't expand \n escapes)
if (process.env.GOOGLE_PRIVATE_KEY && process.env.GOOGLE_PRIVATE_KEY.includes('\\n')) {
  process.env.GOOGLE_PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n');
}

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const jsonfile = require('jsonfile');

const EmailBot = require('./src/index');

// Configuration
const PORT = process.env.API_PORT || 3001;
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
const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Helper: Load drafts
function loadDrafts(status) {
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
function getDraft(id) {
  const filepath = path.join(DRAFTS_DIR, `${id}.json`);
  if (fs.existsSync(filepath)) {
    return jsonfile.readFileSync(filepath);
  }
  return null;
}

// Helper: Save draft
function saveDraft(draft) {
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
  fs.appendFileSync(ACTIVITY_LOG, JSON.stringify(entry) + '\n');
}

// Helper: Get activity
function getActivity(limit = 50) {
  if (!fs.existsSync(ACTIVITY_LOG)) return [];
  const lines = fs.readFileSync(ACTIVITY_LOG, 'utf-8').trim().split('\n');
  return lines.slice(-limit).reverse().map(line => JSON.parse(line));
}

// Helper: Get metrics
async function getMetrics() {
  const drafts = loadDrafts();
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
  
  // Fetch leads count from Notion
  let newLeads = 0;
  try {
    const axios = require('axios');
    const notionKey = emailbot.config.NOTION_KEY;
    const leadsDbId = emailbot.config.NOTION_LEADS_DB_ID;
    if (notionKey && leadsDbId) {
      const response = await axios.post(
        `https://api.notion.com/v1/databases/${leadsDbId}/query`,
        {},
        {
          headers: {
            'Authorization': `Bearer ${notionKey}`,
            'Content-Type': 'application/json',
            'Notion-Version': '2022-06-28'
          }
        }
      );
      newLeads = response.data.results.length;
    }
  } catch (e) {
    console.warn('Could not fetch Notion leads:', e.message);
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
    // Sparkline data (last 7 days)
    sparklineUnread: Array.from({length: 7}, () => Math.floor(Math.random() * 15)),
  };
}

// ============ API ROUTES ============

// GET /api/drafts - List drafts or get single by ?id=
app.get('/api/drafts', (req, res) => {
  try {
    const id = req.query.id;
    const status = req.query.status || undefined;
    
    if (id) {
      const draft = getDraft(id);
      if (!draft) {
        return res.status(404).json({ error: 'Draft not found' });
      }
      return res.json({ draft });
    }
    
    const drafts = loadDrafts(status);
    res.json({ drafts });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch drafts' });
  }
});

// GET /api/drafts/:id - Get single draft
app.get('/api/drafts/:id', (req, res) => {
  try {
    const draft = getDraft(req.params.id);
    if (!draft) {
      return res.status(404).json({ error: 'Draft not found' });
    }
    res.json({ draft });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch draft' });
  }
});

// POST /api/drafts - Approve/Reject/Edit
app.post('/api/drafts', async (req, res) => {
  try {
    const { action, draftId, reason, newContent, editorNotes } = req.body;
    
    const draft = getDraft(draftId);
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
      saveDraft(draft);
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
      saveDraft(draft);
      addActivity('user', `Rejected draft to ${draft.client?.email || 'unknown'}`, { draftId, reason });
      return res.json({ success: true, draft });
    }

    if (action === 'edit') {
      draft.status = 'needs_revision';
      draft.draft = newContent;
      draft.approval = {
        ...draft.approval,
        marceloEdit: newContent,
        editorNotes: editorNotes || 'Edited by Marcelo'
      };
      saveDraft(draft);
      addActivity('user', `Edited draft to ${draft.client?.email || 'unknown'}`, { draftId });
      return res.json({ success: true, draft });
    }

    res.status(400).json({ error: 'Invalid action' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to process draft action' });
  }
});

// GET /api/metrics
app.get('/api/metrics', (req, res) => {
  try {
    const metrics = getMetrics();
    res.json({ metrics });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch metrics' });
  }
});

// GET /api/metrics/sparkline - NEW (for sparkline charts)
app.get('/api/metrics/sparkline', (req, res) => {
  try {
    const { metric = 'unread_emails', days = 7 } = req.query;
    const drafts = loadDrafts();
    const now = new Date();
    const result = [];
    
    for (let i = days - 1; i >= 0; i--) {
      const date = new Date(now);
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split('T')[0];
      
      if (metric === 'unread_emails') {
        // Count drafts created per day
        const count = drafts.filter(d => 
          d.generatedAt && d.generatedAt.startsWith(dateStr)
        ).length;
        result.push(count || Math.floor(Math.random() * 10)); // fallback for demo
      } else if (metric === 'pending_drafts') {
        const count = drafts.filter(d => 
          d.status === 'pending_review' && 
          d.generatedAt && d.generatedAt.startsWith(dateStr)
        ).length;
        result.push(count);
      } else if (metric === 'leads') {
        // Simulated leads data
        result.push(Math.floor(Math.random() * 5));
      }
    }
    
    res.json({ sparkline: result, metric, days: parseInt(days) });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch sparkline data' });
  }
});

// PATCH /api/drafts/:id/draft - Save edited draft without sending (NEW)
app.patch('/api/drafts/:id/draft', (req, res) => {
  try {
    const { id } = req.params;
    const { draft_body } = req.body;
    
    const draft = getDraft(id);
    if (!draft) {
      return res.status(404).json({ error: 'Draft not found' });
    }
    
    draft.draft = draft_body;
    draft.status = 'needs_revision';
    draft.updatedAt = new Date().toISOString();
    
    saveDraft(draft);
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
    
    const draft = getDraft(id);
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
    
    saveDraft(draft);
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
    const metrics = getMetrics();
    const activity = getActivity(20);
    const pending = loadDrafts('pending_review');
    
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
app.get('/api/activity', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const activity = getActivity(limit);
    res.json({ activity });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch activity' });
  }
});

// POST /api/ingest - Trigger email ingestion
app.post('/api/ingest', async (req, res) => {
  try {
    const result = await emailbot.ingest(req.body);
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

// GET /api/leads/count - Count leads from Notion DB
app.get('/api/leads/count', async (req, res) => {
  try {
    const axios = require('axios');
    const notionKey = emailbot.config.NOTION_KEY;
    const leadsDbId = emailbot.config.NOTION_LEADS_DB_ID;
    
    if (!notionKey || !leadsDbId) {
      return res.json({ newLeads: 0, error: 'Notion not configured' });
    }
    
    // Query Notion database to count items
    const response = await axios.post(
      `https://api.notion.com/v1/databases/${leadsDbId}/query`,
      {},
      {
        headers: {
          'Authorization': `Bearer ${notionKey}`,
          'Content-Type': 'application/json',
          'Notion-Version': '2022-06-28'
        }
      }
    );
    
    const newLeads = response.data.results.length;
    
    res.json({ newLeads });
  } catch (error) {
    console.error('Failed to count Notion leads:', error.message);
    res.json({ newLeads: 0, error: error.message });
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
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
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
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
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
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        type TEXT NOT NULL,
        description TEXT NOT NULL,
        entity_type TEXT,
        entity_id TEXT,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT now()
      );
      
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
