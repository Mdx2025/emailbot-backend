/**
 * Sender Module
 * Sends approved drafts via Gmail API
 */

const { google } = require('googleapis');
const path = require('path');
const jsonfile = require('jsonfile');

class Sender {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.draftsPath = config.draftsPath;
  }

  /**
   * Initialize Gmail API client
   */
  async getGmailClient() {
    // Use JWT client instead of GoogleAuth to avoid OpenSSL issues
    const auth = new google.auth.JWT(
      this.config.SERVICE_ACCOUNT_EMAIL,
      null,
      process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      ['https://www.googleapis.com/auth/gmail.send'],
      this.config.GMAIL_DELEGATED_USER
    );

    return google.gmail({ version: 'v1', auth });
  }

  /**
   * Send pending approved drafts
   */
  async sendPending() {
    const approver = require('./approver');
    const approverInstance = new approver(this.config, this.logger);
    
    const approvedDrafts = await approverInstance.list('approved');
    
    if (approvedDrafts.length === 0) {
      this.logger.info('No pending drafts to send');
      return { sent: 0, skipped: 0 };
    }

    this.logger.info('Sending approved drafts', { count: approvedDrafts.length });

    const results = {
      sent: 0,
      failed: 0,
      skipped: 0,
      details: []
    };

    for (const draft of approvedDrafts) {
      try {
        await this.send(draft);
        
        // Update draft status
        draft.status = 'sent';
        draft.sentAt = new Date().toISOString();
        await this.saveDraft(draft);

        results.sent++;
        results.details.push({
          draftId: draft.id,
          email: draft.client.email,
          status: 'sent'
        });

      } catch (error) {
        results.failed++;
        results.details.push({
          draftId: draft.id,
          email: draft.client.email,
          status: 'failed',
          error: error.message
        });

        this.logger.error('Failed to send draft', {
          draftId: draft.id,
          error: error.message
        });
      }
    }

    this.logger.info('Sending complete', results);
    return results;
  }

  /**
   * Send follow-up and sync to Notion
   */
  async sendFollowup(draft, notionSync) {
    const followupNumber = draft.analysis?.followupNumber || 1;

    // Send the follow-up email
    await this.send(draft);

    // Update draft status
    draft.status = 'sent';
    draft.sentAt = new Date().toISOString();
    await this.saveDraft(draft);

    // Sync follow-up to Notion
    if (notionSync && this.config.NOTION_KEY) {
      const FollowUp = require('./followup');
      const followupModule = new FollowUp(this.config, this.logger);
      await followupModule.markSentAndSync(draft, followupNumber, notionSync);
    }

    this.logger.info('Follow-up sent and synced', {
      draftId: draft.id,
      number: followupNumber
    });

    return { sent: true, followupNumber };
  }

  /**
   * Send single draft
   */
  async send(draft) {
    const gmail = await this.getGmailClient();

    // Build email content
    const emailContent = this.buildEmail(draft);

    // Send via Gmail API
    const response = await gmail.users.messages.send({
      userId: 'me',
      requestBody: {
        raw: Buffer.from(emailContent).toString('base64'),
        threadId: draft.emailData.threadId || undefined
      }
    });

    this.logger.info('Email sent', {
      gmailId: response.data.id,
      to: draft.client.email
    });

    return response.data;
  }

  /**
   * Build RFC 2822 email
   */
  buildEmail(draft) {
    const to = draft.client.email;
    const subject = `Re: ${draft.emailData.subject || 'Consulta'}`;
    const content = draft.draft;

    // Include In-Reply-To header for threading
    const headers = [
      `To: ${to}`,
      `From: ${this.config.GMAIL_USER}`,
      `Subject: ${subject}`,
      `Content-Type: text/plain; charset=UTF-8`,
      `MIME-Version: 1.0`
    ];

    if (draft.emailData.threadId) {
      headers.push(`In-Reply-To: <${draft.emailData.threadId}@gmail.com>`);
      headers.push(`References: <${draft.emailData.threadId}@gmail.com>`);
    }

    return headers.join('\r\n') + '\r\n\r\n' + content;
  }

  /**
   * Save draft after sending
   */
  async saveDraft(draft) {
    const approver = require('./approver');
    const approverInstance = new approver(this.config, this.logger);
    await approverInstance.saveDraft(draft);
  }
}

module.exports = Sender;
