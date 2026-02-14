/**
 * Dashboard Module
 * Provides system status and metrics
 */

const fs = require('fs');
const path = require('path');
const jsonfile = require('jsonfile');

class Dashboard {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.draftsPath = config.draftsPath;
    this.statePath = config.statePath;
  }

  /**
   * Get comprehensive system status
   */
  async getStatus() {
    const Approver = require('./approver');
    const approver = new Approver(this.config, this.logger);
    
    const stats = await approver.getStats();
    const recentActivity = await this.getRecentActivity();

    return {
      stats,
      recentActivity,
      lastRun: this.getLastRunTime(),
      config: {
        gmailUser: this.config.GMAIL_USER,
        hasNotion: !!this.config.NOTION_KEY,
        followupDays: this.config.followupDays
      }
    };
  }

  /**
   * Get recent activity
   */
  async getRecentActivity() {
    const Approver = require('./approver');
    const approver = new Approver(this.config, this.logger);
    const drafts = await approver.loadAllDrafts();

    return drafts
      .slice(0, 10)
      .map(d => ({
        id: d.id,
        status: d.status,
        email: d.client.email,
        company: d.client.company,
        generatedAt: d.generatedAt,
        sentAt: d.sentAt
      }));
  }

  /**
   * Get last run time
   */
  getLastRunTime() {
    const stateFile = path.join(this.statePath, 'last_run.json');
    
    if (fs.existsSync(stateFile)) {
      try {
        const state = jsonfile.readFileSync(stateFile);
        return state.timestamp;
      } catch {
        return null;
      }
    }
    
    return null;
  }

  /**
   * Update last run time
   */
  updateLastRun() {
    const stateFile = path.join(this.statePath, 'last_run.json');
    
    if (!fs.existsSync(this.statePath)) {
      fs.mkdirSync(this.statePath, { recursive: true });
    }

    jsonfile.writeFileSync(stateFile, {
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Get daily metrics
   */
  async getDailyMetrics() {
    const Approver = require('./approver');
    const approver = new Approver(this.config, this.logger);
    const drafts = await approver.loadAllDrafts();

    const today = new Date().toISOString().split('T')[0];

    const todayDrafts = drafts.filter(d => 
      d.generatedAt.startsWith(today)
    );

    const todaySent = drafts.filter(d => 
      d.sentAt && d.sentAt.startsWith(today)
    );

    return {
      date: today,
      newLeads: todayDrafts.length,
      sent: todaySent.length,
      pendingApproval: todayDrafts.filter(d => d.status === 'pending_review').length
    };
  }

  /**
   * Get response rate metrics
   */
  async getResponseRate() {
    const Approver = require('./approver');
    const approver = new Approver(this.config, this.logger);
    const drafts = await approver.loadAllDrafts();

    const sent = drafts.filter(d => d.status === 'sent');
    
    // This would require Gmail API to check for replies
    // For now, return basic stats
    return {
      totalSent: sent.length,
      responded: 0, // Would need Gmail API to check
      replyRate: 0
    };
  }
}

module.exports = Dashboard;
