const express = require('express');
const app = express();
const port = process.env.PORT || process.env.API_PORT || 3001;

app.use(express.json());

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
