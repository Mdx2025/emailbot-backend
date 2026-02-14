/**
 * Notion Sync Module
 * Syncs leads and status with Notion CRM
 */

const axios = require('axios');
const jsonfile = require('jsonfile');

class NotionSync {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
  }

  get headers() {
    return {
      'Authorization': `Bearer ${this.config.NOTION_KEY}`,
      'Content-Type': 'application/json',
      'Notion-Version': '2022-06-28'
    };
  }

  get databaseUrl() {
    return `https://api.notion.com/v1/databases/${this.config.NOTION_LEADS_DB_ID}`;
  }

  /**
   * Sync all drafts with Notion
   */
  async syncAll() {
    if (!this.config.NOTION_KEY) {
      this.logger.warn('Notion key not configured');
      return { updated: 0 };
    }

    const Approver = require('./approver');
    const approver = new Approver(this.config, this.logger);
    const drafts = await approver.loadAllDrafts();

    let updated = 0;
    for (const draft of drafts) {
      try {
        await this.syncDraft(draft);
        updated++;
      } catch (error) {
        this.logger.error('Failed to sync draft', {
          draftId: draft.id,
          error: error.message
        });
      }
    }

    this.logger.info('Notion sync complete', { updated });
    return { updated };
  }

  /**
   * Sync single draft to Notion
   */
  async syncDraft(draft) {
    // Check if page exists
    const existingPage = await this.findPageByEmail(draft.client.email);

    if (existingPage) {
      return this.updatePage(existingPage.id, draft);
    } else {
      return this.createPage(draft);
    }
  }

  /**
   * Find existing Notion page by email
   * Note: Email is rich_text type, not email type
   */
  async findPageByEmail(email) {
    try {
      const response = await axios.post(
        `${this.databaseUrl}/query`,
        {
          filter: {
            property: 'Email',
            rich_text: { equals: email }
          }
        },
        { headers: this.headers }
      );

      return response.data.results[0] || null;
    } catch (error) {
      this.logger.error('Failed to find Notion page', { email, error: error.message });
      return null;
    }
  }

  /**
   * Create new Notion page for draft
   */
  async createPage(draft) {
    const properties = this.buildProperties(draft);

    try {
      const response = await axios.post(
        'https://api.notion.com/v1/pages',
        {
          parent: { database_id: this.config.NOTION_LEADS_DB_ID },
          properties
        },
        { headers: this.headers }
      );

      this.logger.info('Created Notion page', { 
        pageId: response.data.id,
        email: draft.client.email 
      });

      return response.data;
    } catch (error) {
      this.logger.error('Failed to create Notion page', { 
        error: error.message,
        response: error.response?.data 
      });
      throw error;
    }
  }

  /**
   * Update existing Notion page
   */
  async updatePage(pageId, draft) {
    const properties = this.buildProperties(draft);

    try {
      await axios.patch(
        `https://api.notion.com/v1/pages/${pageId}`,
        { properties },
        { headers: this.headers }
      );

      this.logger.info('Updated Notion page', { pageId });
    } catch (error) {
      this.logger.error('Failed to update Notion page', { 
        pageId, 
        error: error.message 
      });
      throw error;
    }
  }

  /**
   * Build Notion properties from draft
   * Maps to actual database schema: Form, Email (rich_text), Company name, Project type, Status, Date, Message
   */
  buildProperties(draft) {
    const statusMap = {
      'pending_review': { select: { name: 'Recibido' } },
      'approved': { select: { name: 'Enviado' } },
      'rejected': { select: { name: 'Descartado' } },
      'sent': { select: { name: 'Enviado' } },
      'needs_revision': { select: { name: 'Revisar' } }
    };

    return {
      'Form': { title: [{ text: { content: draft.client.name || 'Unknown' } }] },
      'Email': { rich_text: [{ text: { content: draft.client.email || '' } }] },
      'Company name': { rich_text: [{ text: { content: draft.client.company || '' } }] },
      'Project type': { rich_text: [{ text: { content: draft.client.service || 'General' } }] },
      'Status': statusMap[draft.status] || { select: { name: 'Recibido' } },
      'Date': { rich_text: [{ text: { content: draft.generatedAt?.split('T')[0] || new Date().toISOString().split('T')[0] } }] },
      'Message': { rich_text: [{ text: { content: (draft.emailData?.originalMessage || '').substring(0, 2000) } }] }
    };
  }

  /**
   * Add follow-up entry to Notion (same database with columns)
   * Uses: Primer seguimiento, Segundo seguimiento, Terce seguimiento
   */
  async addFollowUp(pageId, draft, followupNumber) {
    try {
      const followupColumns = {
        1: { 'Primer seguimiento': { select: { name: 'Realizado' } } },
        2: { 'Segundo seguimiento': { select: { name: 'realizado' } } },
        3: { 'Terce seguimiento': { select: { name: 'realizado' } } }
      };

      const properties = followupColumns[followupNumber];
      if (!properties) {
        throw new Error(`Invalid follow-up number: ${followupNumber}`);
      }

      await axios.patch(
        `https://api.notion.com/v1/pages/${pageId}`,
        { properties },
        { headers: this.headers }
      );

      this.logger.info('Follow-up synced to Notion', { pageId, number: followupNumber });
      return true;
    } catch (error) {
      this.logger.error('Failed to sync follow-up', { pageId, followupNumber, error: error.message });
      throw error;
    }
  }

  /**
   * Add follow-up entry as new page (if using separate DB)
   * Uses database property names: Form, Email, Categoria
   */
  async addFollowUpAsPage(draft, followupNumber) {
    const dbId = this.config.NOTION_FOLLOWUPS_DB_ID || this.config.NOTION_LEADS_DB_ID;
    
    const properties = {
      'Form': { title: [{ text: { content: draft.client.name || 'Unknown' } }] },
      'Email': { rich_text: [{ text: { content: draft.client.email || '' } }] },
      'Categoria': { multi_select: [{ name: 'Cliente potencial' }] },
      'Status': { select: { name: 'Enviado' } }
    };

    try {
      const response = await axios.post(
        'https://api.notion.com/v1/pages',
        {
          parent: { database_id: dbId },
          properties
        },
        { headers: this.headers }
      );

      this.logger.info('Follow-up page created in Notion', { 
        pageId: response.data.id,
        followupNumber 
      });

      return response.data;
    } catch (error) {
      this.logger.error('Failed to create follow-up page', { error: error.message });
      throw error;
    }
  }

  /**
   * Calculate follow-up dates
   */
  calculateFollowUpDates(sentDate) {
    const sent = new Date(sentDate);
    const days = this.config.followupDays || [3, 5, 6];
    
    return days.map(d => {
      const followUp = new Date(sent);
      followUp.setDate(followUp.getDate() + d);
      return {
        number: days.indexOf(d) + 1,
        date: followUp.toISOString()
      };
    });
  }
}

module.exports = NotionSync;
