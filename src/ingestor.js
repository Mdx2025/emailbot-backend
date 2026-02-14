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
    this.logger.info('Initializing Gmail client');

    // Always use credentials from env vars (GOOGLE_PRIVATE_KEY and GOOGLE_SERVICE_ACCOUNT_EMAIL)
    // Skip GOOGLE_APPLICATION_CREDENTIALS to avoid file-based auth issues in production
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
    const { filter = 'subject:"Nuevo cliente potencial"', limit = 10 } = options;
    
    this.logger.info('Starting ingestion', { filter, limit });

    try {
      const gmail = await this.getGmailClient();
      
      // Search for matching emails
      const response = await gmail.users.messages.list({
        userId: 'me',
        q: filter,
        maxResults: limit
      });

      const messages = response.data.messages || [];
      const processed = [];

      for (const msg of messages) {
        const email = await this.processEmail(gmail, msg.id);
        if (email) {
          processed.push(email);
        }
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
    if (message.payload.body?.data) {
      return Buffer.from(message.payload.body.data, 'base64').toString('utf8');
    }
    
    if (message.payload.parts) {
      for (const part of message.payload.parts) {
        if (part.mimeType === 'text/plain' && part.body?.data) {
          return Buffer.from(part.body.data, 'base64').toString('utf8');
        }
      }
    }
    
    return '';
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
