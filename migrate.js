/**
 * Database Migration Script
 * Creates tables for EmailBot in PostgreSQL
 */

const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const schema = `
-- Drop existing tables (optional, for clean start)
-- DROP TABLE IF EXISTS activity CASCADE;
-- DROP TABLE IF EXISTS emails CASCADE;
-- DROP TABLE IF EXISTS leads CASCADE;

-- Create emails table (unified with draft fields)
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
  -- AI Draft fields (built-in, not separate table)
  draft_body TEXT,
  draft_confidence INTEGER,
  draft_tone TEXT DEFAULT 'professional',
  draft_language TEXT DEFAULT 'en',
  draft_status TEXT DEFAULT 'none',
  draft_sla_deadline TIMESTAMPTZ,
  draft_generated_at TIMESTAMPTZ,
  -- AI Analysis
  agent_insight TEXT,
  -- Metadata
  metadata JSONB DEFAULT '{}',
  synced_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Create leads table
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

-- Create activity table
CREATE TABLE IF NOT EXISTS activity (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  type TEXT NOT NULL,
  description TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_emails_status ON emails(status);
CREATE INDEX IF NOT EXISTS idx_emails_draft_status ON emails(draft_status);
CREATE INDEX IF NOT EXISTS idx_emails_received_at ON emails(received_at);
CREATE INDEX IF NOT EXISTS idx_leads_received_at ON leads(received_at);
CREATE INDEX IF NOT EXISTS idx_activity_created_at ON activity(created_at);

SELECT 'Migration completed successfully' as result;
`;

async function migrate() {
  try {
    console.log('Starting migration...');
    const client = await pool.connect();
    
    // Enable UUID extension
    await client.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    
    // Run migration
    const result = await client.query(schema);
    console.log('Migration result:', result.rows);
    
    client.release();
    await pool.end();
    
    console.log('✅ Migration completed successfully');
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error.message);
    process.exit(1);
  }
}

migrate();
