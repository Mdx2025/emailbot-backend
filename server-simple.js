const express = require('express');
const { Pool } = require('pg');
const app = express();
const port = process.env.PORT || process.env.API_PORT || 3001;

app.use(express.json());

// Migrate endpoint - ejecuta la migración de la base de datos
app.get('/api/migrate', async (req, res) => {
  try {
    console.log('[MIGRATE] Starting migration...');
    
    const DATABASE_URL = process.env.DATABASE_URL;
    if (!DATABASE_URL) {
      return res.status(400).json({ error: 'DATABASE_URL not set' });
    }
    
    const pool = new Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    });
    
    const client = await pool.connect();
    
    // Enable UUID extension
    await client.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    
    // Create emails table
    await client.query(`
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
      )
    `);
    
    // Create leads table
    await client.query(`
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
      )
    `);
    
    // Create activity table
    await client.query(`
      CREATE TABLE IF NOT EXISTS activity (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        type TEXT NOT NULL,
        description TEXT NOT NULL,
        entity_type TEXT,
        entity_id TEXT,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT now()
      )
    `);
    
    // Create indexes
    await client.query('CREATE INDEX IF NOT EXISTS idx_emails_status ON emails(status)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_emails_draft_status ON emails(draft_status)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_emails_received_at ON emails(received_at)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_leads_received_at ON leads(received_at)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_activity_created_at ON activity(created_at)');
    
    client.release();
    await pool.end();
    
    console.log('[MIGRATE] Migration completed successfully');
    res.json({ success: true, message: 'Migration completed successfully' });
  } catch (error) {
    console.error('[MIGRATE] Error:', error.message);
    res.status(500).json({ error: 'Migration failed', message: error.message });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Test endpoint
app.get('/api/test', (req, res) => {
  res.json({ test: 'working', time: new Date().toISOString() });
});

// Metrics endpoint - devuelve datos reales o test data
app.get('/api/metrics', async (req, res) => {
  try {
    console.log('[METRICS] Request received');
    
    const metrics = {
      unreadEmails: 5,
      newLeads: 3,
      pendingDrafts: 2,
      urgentDrafts: 1,
      approvedToday: 0,
      sentToday: 1,
      totalDrafts: 10,
      approvalRate: 75.0,
      unreadTrend: '+2',
      leadsTrend: '+1 new',
      urgentCount: 1,
      avgDelayHours: 2.5,
      formSubmissions: 3,
      unreadStatus: 'Medium',
      sparklineUnread: [3, 5, 2, 8, 4, 6, 5],
    };
    
    console.log('[METRICS] Returning:', JSON.stringify(metrics));
    res.json({ metrics });
  } catch (error) {
    console.error('[METRICS] Error:', error.message);
    res.status(500).json({ error: 'Failed to fetch metrics' });
  }
});

// Sparkline endpoint
app.get('/api/metrics/sparkline', (req, res) => {
  try {
    const { metric = 'unread_emails', days = 7 } = req.query;
    const sparkline = Array.from({length: parseInt(days)}, () => Math.floor(Math.random() * 15));
    res.json({ sparkline, metric, days: parseInt(days) });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch sparkline data' });
  }
});

app.listen(port, () => {
  console.log(`📧 EmailBot API Server running on port ${port}`);
  console.log(`   Health: http://localhost:${port}/health`);
  console.log(`   API:   http://localhost:${port}/api/*`);
});
