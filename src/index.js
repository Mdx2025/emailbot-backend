/**
 * EmailBot Skill v2
 * Entry point - registers skill with OpenClaw
 */

const path = require('path');

// Load environment configuration
const config = require('../config/default.json');

// Core modules
const Ingestor = require('./ingestor');
const Analyzer = require('./analyzer');
const Drafter = require('./drafter');
const Approver = require('./approver');
const Sender = require('./sender');
const NotionSync = require('./notion');
const FollowUp = require('./followup');
const Dashboard = require('./dashboard');

class EmailBot {
  constructor(config = {}) {
    this.config = { ...config, ...this.loadEnvConfig() };
    this.logger = this.createLogger();
    
    // Initialize modules
    this.ingestor = new Ingestor(this.config, this.logger);
    this.analyzer = new Analyzer(this.config, this.logger);
    this.drafter = new Drafter(this.config, this.logger);
    this.approver = new Approver(this.config, this.logger);
    this.sender = new Sender(this.config, this.logger);
    this.notion = new NotionSync(this.config, this.logger);
    this.followup = new FollowUp(this.config, this.logger);
    this.dashboard = new Dashboard(this.config, this.logger);
    
    this.logger.info('EmailBot initialized', { 
      gmailUser: this.config.GMAIL_USER,
      hasNotion: !!this.config.NOTION_KEY
    });
  }

  loadEnvConfig() {
    return {
      GMAIL_USER: process.env.GMAIL_USER,
      PROJECT_ID: process.env.PROJECT_ID,
      SERVICE_ACCOUNT_EMAIL: process.env.SERVICE_ACCOUNT_EMAIL,
      GMAIL_CLIENT_ID: process.env.GMAIL_CLIENT_ID,
      GMAIL_DELEGATED_USER: process.env.GMAIL_DELEGATED_USER || process.env.GMAIL_USER,
      NOTION_KEY: process.env.NOTION_KEY,
      NOTION_LEADS_DB_ID: process.env.NOTION_LEADS_DB_ID,
      NOTION_FOLLOWUPS_DB_ID: process.env.NOTION_FOLLOWUPS_DB_ID || process.env.NOTION_LEADS_DB_ID, // Misma DB por defecto
      MODEL_ROUTER_URL: process.env.MODEL_ROUTER_URL || 'http://localhost:8080',
      // Gemini (direct) - used by Drafter
      GEMINI_API_KEY: process.env.GEMINI_API_KEY,
      GEMINI_MODEL: process.env.GEMINI_MODEL,
      EMAIL_DRAFT_TASK_TIMEOUT: parseInt(process.env.EMAIL_DRAFT_TASK_TIMEOUT) || 300,
      // Railway-safe defaults: keep all writable data inside project /app/data
      draftsPath: process.env.DRAFTS_PATH || path.resolve(__dirname, '..', 'data', 'drafts'),
      logsPath: process.env.LOGS_PATH || path.resolve(__dirname, '..', 'data', 'logs'),
      statePath: process.env.STATE_PATH || path.resolve(__dirname, '..', 'data', 'state')
    };
  }

  createLogger() {
    const winston = require('winston');
    const fs = require('fs');
    
    // Ensure logs directory exists
    if (!fs.existsSync(this.config.logsPath)) {
      fs.mkdirSync(this.config.logsPath, { recursive: true });
    }
    
    return winston.createLogger({
      level: process.env.LOG_LEVEL || 'info',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
      ),
      transports: [
        new winston.transports.File({ 
          filename: path.join(this.config.logsPath, 'error.log'), 
          level: 'error' 
        }),
        new winston.transports.File({ 
          filename: path.join(this.config.logsPath, 'combined.log') 
        })
      ]
    });
  }

  // Main workflow methods
  async ingest(options = {}) {
    return this.ingestor.run(options);
  }

  async analyze(emailData) {
    return this.analyzer.run(emailData);
  }

  async generateDraft(analysis) {
    return this.drafter.generate(analysis);
  }

  async approve(draftId, options = {}) {
    return this.approver.approve(draftId, options);
  }

  async reject(draftId, reason) {
    return this.approver.reject(draftId, reason);
  }

  async listDrafts(status = 'pending_review') {
    return this.approver.list(status);
  }

  async sendApproved() {
    return this.sender.sendPending();
  }

  async syncNotion() {
    return this.notion.syncAll();
  }

  async getStatus() {
    return this.dashboard.getStatus();
  }

  async generateFollowup(threadId, number) {
    return this.followup.generate(threadId, number);
  }

  async sendFollowup(draftId) {
    // Load the follow-up draft
    const approver = require('./approver');
    const approverInstance = new approver(this.config, this.logger);
    const draft = await approverInstance.findById(draftId);
    
    if (!draft) {
      throw new Error('Draft not found');
    }
    
    if (!draft.followups?.isFollowup) {
      throw new Error('Draft is not a follow-up');
    }
    
    // Send and sync to Notion
    return this.sender.sendFollowup(draft, this.notion);
  }

  // Event emitter interface
  on(event, callback) {
    // Simple event bus implementation
    if (!this.events) this.events = {};
    if (!this.events[event]) this.events[event] = [];
    this.events[event].push(callback);
  }

  emit(event, data) {
    if (this.events && this.events[event]) {
      this.events[event].forEach(cb => cb(data));
    }
  }
}

module.exports = EmailBot;
