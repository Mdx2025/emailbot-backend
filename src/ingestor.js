/**
 * Ingestor Module
 * Reads emails from Gmail and parses lead information
 */

const { google } = require('googleapis');
const jsonfile = require('jsonfile');

class Ingestor {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.draftsPath = config.draftsPath;
  }

  /**
   * Initialize Gmail API client with Service Account
   */
  async getGmailClient() {
    this.logger.info('Initializing Gmail client - USING ENV VARS AUTH');

    // Always use credentials from env vars (GOOGLE_PRIVATE_KEY and GOOGLE_SERVICE_ACCOUNT_EMAIL)
    // Skip GOOGLE_APPLICATION_CREDENTIALS to avoid file-based auth issues in production
    console.log('=== AUTH CHECK ===');
    console.log('GOOGLE_SERVICE_ACCOUNT_EMAIL:', process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL ? 'SET' : 'NOT SET');
    console.log('GOOGLE_PRIVATE_KEY:', process.env.GOOGLE_PRIVATE_KEY ? 'SET' : 'NOT SET');
    console.log('GOOGLE_APPLICATION_CREDENTIALS:', process.env.GOOGLE_APPLICATION_CREDENTIALS ? 'SET' : 'NOT SET');
    console.log('==================');
    let clientEmail = process.env.SERVICE_ACCOUNT_EMAIL || 
                       process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL ||
                       this.config.SERVICE_ACCOUNT_EMAIL;
    let privateKey = process.env.GOOGLE_PRIVATE_KEY;

    if (privateKey && privateKey.includes('\\n')) {
      privateKey = privateKey.replace(/\\\\n/g, '\n');
    }

    if (!clientEmail || !privateKey) {
      throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_EMAIL or GOOGLE_PRIVATE_KEY');
    }

    const auth = new google.auth.GoogleAuth({
      credentials: {
        client_email: clientEmail,
        private_key: privateKey
      },
      scopes: ['https://www.googleapis.com/auth/gmail.modify'],
      clientOptions: {
        subject: this.config.GMAIL_DELEGATED_USER
      }
    });

    const gmail = google.gmail({ version: 'v1', auth });
    return gmail;
  }

  /**
   * Run ingestion pipeline
   */
  async run(options = {}) {
    // If you want *all* emails, call without filter.
    // WARNING: ingesting everything can create a lot of leads and cost.
    const {
      filter = '',
      limit = 50
    } = options;

    const safeLimit = Math.max(1, Math.min(parseInt(limit, 10) || 50, 500));

    this.logger.info('Starting ingestion', { filter, limit: safeLimit });

    try {
      const gmail = await this.getGmailClient();

      // Search for matching emails (or list all if filter is empty)
      let pageToken = undefined;
      const messages = [];

      while (messages.length < safeLimit) {
        const resp = await gmail.users.messages.list({
          userId: 'me',
          q: filter || undefined,
          maxResults: Math.min(100, safeLimit - messages.length),
          pageToken
        });

        const batch = resp.data.messages || [];
        messages.push(...batch);

        pageToken = resp.data.nextPageToken;
        if (!pageToken || batch.length === 0) break;
      }

      const processed = [];

      for (const msg of messages) {
        const email = await this.processEmail(gmail, msg.id);
        if (email) processed.push(email);
      }

      this.logger.info('Ingestion complete', { processed: processed.length });
      return { success: true, processed };

    } catch (error) {
      this.logger.error('Ingestion failed', { error: error.message });
      throw error;
    }
  }

  /**
   * Process single email
   */
  async processEmail(gmail, messageId) {
    try {
      const msg = await gmail.users.messages.get({
        userId: 'me',
        id: messageId,
        format: 'full'
      });

      const headers = msg.data.payload.headers;
      const subject = headers.find(h => h.name === 'Subject')?.value || '';
      const from = headers.find(h => h.name === 'From')?.value || '';
      const date = headers.find(h => h.name === 'Date')?.value || '';

      // Extract body
      const body = this.extractBody(msg.data);
      
      // Parse contact form data
      const leadData = this.parseLeadForm(body, from);
      
      if (!leadData.email) {
        this.logger.warn('No valid email found in message', { messageId });
        return null;
      }

      const emailData = {
        gmailId: messageId,
        threadId: msg.data.threadId,
        subject,
        from,
        date,
        body,
        ...leadData,
        receivedAt: new Date().toISOString()
      };

      this.logger.info('Processed email', { 
        gmailId: messageId, 
        email: leadData.email 
      });

      return emailData;

    } catch (error) {
      this.logger.error('Failed to process email', { 
        messageId, 
        error: error.message 
      });
      return null;
    }
  }

  /**
   * Extract email body from Gmail payload
   */
  extractBody(message) {
    try {
      // Gmail uses base64url sometimes; normalize
      const decode = (data) => {
        if (!data) return '';
        const b64 = String(data).replace(/-/g, '+').replace(/_/g, '/');
        return Buffer.from(b64, 'base64').toString('utf8');
      };

      // 1) Single-part body
      if (message?.payload?.body?.data) {
        const txt = decode(message.payload.body.data);
        if (txt && txt.trim()) return txt;
      }

      // 2) Walk MIME tree (pref: text/plain, fallback: text/html)
      const parts = [];
      const walk = (node) => {
        if (!node) return;
        if (node.parts && Array.isArray(node.parts)) node.parts.forEach(walk);
        parts.push(node);
      };
      walk(message?.payload);

      const pick = (mime) => parts.find((p) => p?.mimeType === mime && p?.body?.data);

      const plain = pick('text/plain');
      if (plain) {
        const txt = decode(plain.body.data);
        if (txt && txt.trim()) return txt;
      }

      const html = pick('text/html');
      if (html) {
        const raw = decode(html.body.data);
        // ultra-light HTML -> text (good enough for context)
        const txt = raw
          .replace(/<style[\s\S]*?<\/style>/gi, ' ')
          .replace(/<script[\s\S]*?<\/script>/gi, ' ')
          .replace(/<br\s*\/?\s*>/gi, '\n')
          .replace(/<\/?p\b[^>]*>/gi, '\n')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/\n{3,}/g, '\n\n')
          .trim();
        if (txt) return txt;
      }

      // 3) Last resort: Gmail snippet
      const snip = message?.snippet;
      if (snip && String(snip).trim()) return String(snip);

      return '';
    } catch {
      return '';
    }
  }

  /**
   * Parse lead information from contact form
   */
  parseLeadForm(body, from) {
    const result = {
      email: null,
      name: null,
      company: null,
      service: null,
      message: null
    };

    // Extract from email header
    const fromMatch = from.match(/"?([^"<]*)"?\s*<([^>]+)>/);
    if (fromMatch) {
      result.name = fromMatch[1].trim();
      result.email = fromMatch[2].trim();
    } else if (from.includes('@')) {
      result.email = from;
    }

    // Parse body for contact form fields
    const patterns = {
      email: /Email:\s*([^\n\r]+)/i,
      name: /Name:\s*([^\n\r]+)/i,
      company: /Company:\s*([^\n\r]+)/i,
      service: /Service:\s*([^\n\r]+)/i,
      message: /Message:\s*([\s\S]*?)(?=\n\n|$)/i
    };

    for (const [field, pattern] of Object.entries(patterns)) {
      const match = body.match(pattern);
      if (match) {
        result[field] = match[1].trim();
      }
    }

    // If no structured data, use raw body as message
    if (!result.message && body) {
      result.message = body.substring(0, 500);
    }

    return result;
  }
}

module.exports = Ingestor;
