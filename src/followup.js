/**
 * FollowUp Module
 * Handles follow-up sequence automation
 */

const fs = require('fs');
const path = require('path');
const jsonfile = require('jsonfile');
const { v4: uuidv4 } = require('uuid');

class FollowUp {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.draftsPath = config.draftsPath;
    this.statePath = config.statePath;
  }

  /**
   * Generate follow-up draft
   */
  async generate(threadId, number) {
    if (number < 1 || number > 3) {
      throw new Error('Follow-up number must be 1, 2, or 3');
    }

    const draft = await this.findOriginalDraft(threadId);
    if (!draft) {
      throw new Error('Original draft not found');
    }

    const followupNumber = parseInt(number);
    
    this.logger.info('Generating follow-up', { 
      threadId, 
      number: followupNumber 
    });

    // Generate follow-up content
    const followupContent = await this.generateFollowupContent(draft, followupNumber);

    const followupDraft = {
      version: '1.0.0',
      id: uuidv4(),
      generatedAt: new Date().toISOString(),
      client: draft.client,
      emailData: {
        gmailId: draft.emailData.gmailId,
        threadId: threadId,
        subject: `Seguimiento: ${draft.emailData.subject || 'Consulta'}`,
        originalMessage: draft.emailData.originalMessage
      },
      draft: followupContent,
      analysis: {
        messageType: 'followup',
        followupNumber
      },
      status: 'pending_review',
      approval: null,
      followups: {
        sent1: draft.followups?.sent1 || null,
        sent2: draft.followups?.sent2 || null,
        sent3: draft.followups?.sent3 || null,
        isFollowup: true,
        parentDraftId: draft.id,
        followupNumber
      }
    };

    // Save follow-up draft
    await this.saveDraft(followupDraft);

    this.logger.info('Follow-up draft created', {
      draftId: followupDraft.id,
      number: followupNumber
    });

    return followupDraft;
  }

  /**
   * Generate follow-up content based on number
   */
  async generateFollowupContent(draft, number) {
    const company = draft.client.company || 'tu empresa';
    const service = draft.client.service || 'nuestros servicios';

    const templates = {
      1: `
Hola,

Hace unos días te escribí respecto a ${service} para ${company}.

Quería saber si tuviste la oportunidad de revisar mi mensaje o si tienes alguna pregunta que pueda responder.

Quedo a tu disposición.

Saludos,
Equipo MDX.so
`.trim(),

      2: `
Hola ${company},

Solo quería hacer seguimiento a mi mensaje anterior sobre ${service}.

Entendemos que los tiempos pueden estar ocupados, pero nos encantaría tener la oportunidad de mostrarte cómo podemos ayudarte.

¿Te gustaría agendar una breve llamada de 15 minutos esta semana?

Saludos,
Equipo MDX.so
`.trim(),

      3: `
Hola,

Comprendo que quizás ${service} no sea lo que buscan en este momento.

Solo quería agradecerte por el interés inicial en MDX.so y dejarte mi contacto por si surge algo en el futuro:

📧 Hello@mdx.so
🌐 mdx.so

¡Éxito con tu proyecto!

Saludos,
Equipo MDX.so
`.trim()
    };

    return templates[number] || templates[1];
  }

  /**
   * Find original draft for thread
   */
  async findOriginalDraft(threadId) {
    const drafts = await this.loadAllDrafts();
    
    return drafts.find(d => 
      d.emailData?.threadId === threadId && 
      !d.followups?.isFollowup
    );
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
        // Skip corrupt files
      }
    }

    return drafts;
  }

  /**
   * Save draft
   */
  async saveDraft(draft) {
    if (!fs.existsSync(this.draftsPath)) {
      fs.mkdirSync(this.draftsPath, { recursive: true });
    }

    const filepath = path.join(this.draftsPath, `${draft.id}.json`);
    await jsonfile.writeFile(filepath, draft, { spaces: 2 });
  }

  /**
   * Mark follow-up as sent and sync to Notion
   */
  async markSentAndSync(draft, followupNumber, notionSync) {
    const sentField = `sent${followupNumber}`;
    
    // Update local draft
    draft.followups[sentField] = new Date().toISOString();
    await this.saveDraft(draft);

    // Sync to Notion
    if (notionSync && this.config.NOTION_KEY) {
      const originalDraft = await this.findOriginalDraft(draft.emailData.threadId);
      if (originalDraft) {
        const existingPage = await notionSync.findPageByEmail(draft.client.email);
        if (existingPage) {
          await notionSync.addFollowUp(existingPage.id, originalDraft, followupNumber);
        }
      }
    }

    this.logger.info('Follow-up marked as sent and synced', { 
      draftId: draft.id, 
      number: followupNumber 
    });
  }

  /**
   * Check for due follow-ups
   */
  async checkDueFollowups() {
    const drafts = await this.loadAllDrafts();
    const sentDrafts = drafts.filter(d => d.status === 'sent' && d.sentAt);
    
    const dueFollowups = [];
    const days = this.config.followupDays || [3, 5, 6];

    for (const draft of sentDrafts) {
      const sentDate = new Date(draft.sentAt);
      const now = new Date();

      for (let i = 0; i < days.length; i++) {
        const followupDate = new Date(sentDate);
        followupDate.setDate(followupDate.getDate() + days[i]);

        const hasFollowup = draft.followups?.[`sent${i + 1}`];
        const isDue = now >= followupDate && !hasFollowup;

        if (isDue) {
          dueFollowups.push({
            draftId: draft.id,
            threadId: draft.emailData?.threadId,
            number: i + 1,
            dueDate: followupDate.toISOString()
          });
        }
      }
    }

    return dueFollowups;
  }
}

module.exports = FollowUp;
