/**
 * Approver Module
 * Handles draft approval workflow
 */

const fs = require('fs');
const path = require('path');
const jsonfile = require('jsonfile');

class Approver {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.draftsPath = config.draftsPath;
  }

  /**
   * List drafts by status
   */
  async list(status = 'pending_review') {
    const drafts = await this.loadAllDrafts();
    return drafts.filter(d => d.status === status);
  }

  /**
   * Approve a draft
   */
  async approve(draftId, options = {}) {
    const { marceloEdit, editMessage } = options;
    
    const draft = await this.loadDraft(draftId);
    if (!draft) {
      throw new Error(`Draft not found: ${draftId}`);
    }

    draft.status = 'approved';
    draft.approval = {
      approver: 'Marcelo',
      approvedAt: new Date().toISOString(),
      marceloEdit: marceloEdit || editMessage || null,
      rejectionReason: null
    };

    // Apply edits if provided
    if (marceloEdit || editMessage) {
      draft.draft = marceloEdit || editMessage;
    }

    await this.saveDraft(draft);

    this.logger.info('Draft approved', { draftId, hasEdits: !!marceloEdit });

    return draft;
  }

  /**
   * Reject a draft
   */
  async reject(draftId, reason) {
    const draft = await this.loadDraft(draftId);
    if (!draft) {
      throw new Error(`Draft not found: ${draftId}`);
    }

    draft.status = 'rejected';
    draft.approval = {
      approver: 'Marcelo',
      approvedAt: new Date().toISOString(),
      rejectionReason: reason
    };

    await this.saveDraft(draft);

    this.logger.info('Draft rejected', { draftId, reason });

    return draft;
  }

  /**
   * Request revision
   */
  async requestRevision(draftId, notes) {
    const draft = await this.loadDraft(draftId);
    if (!draft) {
      throw new Error(`Draft not found: ${draftId}`);
    }

    draft.status = 'needs_revision';
    draft.approval = {
      ...draft.approval,
      revisionNotes: notes,
      requestedAt: new Date().toISOString()
    };

    await this.saveDraft(draft);

    this.logger.info('Revision requested', { draftId, notes });

    return draft;
  }

  /**
   * Get single draft
   */
  async get(draftId) {
    return this.loadDraft(draftId);
  }

  /**
   * Load single draft
   */
  async loadDraft(draftId) {
    const filepath = path.join(this.draftsPath, `${draftId}.json`);
    
    if (!fs.existsSync(filepath)) {
      return null;
    }

    return jsonfile.readFile(filepath);
  }

  /**
   * Load all drafts
   */
  async loadAllDrafts() {
    if (!fs.existsSync(this.draftsPath)) {
      return [];
    }

    const files = fs.readdirSync(this.draftsPath)
      .filter(f => f.endsWith('.json'));

    const drafts = [];
    for (const file of files) {
      try {
        const draft = await jsonfile.readFile(path.join(this.draftsPath, file));
        drafts.push(draft);
      } catch (error) {
        this.logger.warn('Failed to load draft', { file, error: error.message });
      }
    }

    return drafts.sort((a, b) => 
      new Date(b.generatedAt) - new Date(a.generatedAt)
    );
  }

  /**
   * Save draft
   */
  async saveDraft(draft) {
    const filepath = path.join(this.draftsPath, `${draft.id}.json`);
    await jsonfile.writeFile(filepath, draft, { spaces: 2 });
  }

  /**
   * Get statistics
   */
  async getStats() {
    const drafts = await this.loadAllDrafts();
    
    const stats = {
      total: drafts.length,
      pending: drafts.filter(d => d.status === 'pending_review').length,
      approved: drafts.filter(d => d.status === 'approved').length,
      rejected: drafts.filter(d => d.status === 'rejected').length,
      needsRevision: drafts.filter(d => d.status === 'needs_revision').length,
      sent: drafts.filter(d => d.status === 'sent').length,
      archived: drafts.filter(d => d.status === 'archived').length
    };

    return stats;
  }
}

module.exports = Approver;
