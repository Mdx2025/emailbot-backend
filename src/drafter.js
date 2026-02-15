/**
 * Drafter Module
 * Generates AI email drafts using GPT models
 */

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const jsonfile = require('jsonfile');

class Drafter {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.draftsPath = config.draftsPath;
    this.systemPrompt = this.loadSystemPrompt();
  }

  loadSystemPrompt() {
    const promptPath = path.join(__dirname, '..', 'docs', 'system_prompt_v3.md');
    if (fs.existsSync(promptPath)) {
      return fs.readFileSync(promptPath, 'utf8');
    }
    // Default prompt if file doesn't exist
    return this.getDefaultPrompt();
  }

  getDefaultPrompt() {
    // Minimal system prompt: avoid “trained template” behavior.
    // We rely on the user prompt + original message context.
    return `You are an email assistant. Reply concisely and naturally.`;
  }

  /**
   * Generate draft for a lead
   */
  async generate(analysis) {
    this.logger.info('Generating draft', { 
      leadEmail: analysis.email,
      company: analysis.company 
    });

    try {
      // Call ModelRouter for GPT generation
      const draftContent = await this.callModelRouter(analysis);

      // Create draft object
      const draft = {
        version: '1.0.0',
        id: uuidv4(),
        generatedAt: new Date().toISOString(),
        client: {
          email: analysis.email,
          name: analysis.name,
          company: analysis.company,
          service: analysis.service
        },
        emailData: {
          gmailId: analysis.gmailId,
          threadId: analysis.threadId,
          subject: analysis.subject,
          originalMessage: analysis.message
        },
        draft: draftContent,
        analysis: this.analyzeDraft(analysis),
        status: 'pending_review',
        approval: null,
        followups: {
          sent1: null,
          sent2: null,
          sent3: null
        }
      };

      // Save draft
      await this.saveDraft(draft);

      this.logger.info('Draft generated', { 
        draftId: draft.id,
        status: 'pending_review' 
      });

      return draft;

    } catch (error) {
      this.logger.error('Draft generation failed', { 
        error: error.message,
        leadEmail: analysis.email 
      });
      throw error;
    }
  }

  /**
   * Detect language of text
   * Returns 'es' for Spanish, 'en' for English (default)
   */
  detectLanguage(text) {
    if (!text) return 'en';
    
    const lowerText = text.toLowerCase();
    
    // Spanish indicators - common words and patterns
    const esWords = ['hola', 'gracias', 'por favor', 'consulta', 'mensaje', 'empresa', 'saludos', 
                     'buenos', 'buenas', 'estoy', 'tengo', 'necesito', 'información', 'informacion',
                     'precio', 'presupuesto', 'costo', 'cuánto', 'cuanto', 'cuando', 'cuándo',
                     'puede', 'pueden', 'sería', 'seria', 'me gustaría', 'me gustaria', 'quisiera',
                     'interesado', 'interesada', 'interes', 'interés', 'servicios', 'servicio',
                     'desarrollo', 'diseño', 'diseñar', 'crear', 'proyecto', 'proyectos',
                     'quisiera', 'gustaría', 'podría', 'han', 'han sido', 'fue', 'eran'];
    
    // English indicators
    const enWords = ['hello', 'hi', 'hey', 'thanks', 'thank', 'please', 'inquiry', 'message', 'company',
                     'regards', 'would', 'could', 'can you', 'how much', 'price', 'cost', 'budget',
                     'i need', 'i want', 'i am', 'i have', 'i\'m', 'information', 'when', 'interested',
                     'service', 'services', 'development', 'design', 'create', 'project', 'projects',
                     'would like', 'could you', 'have been', 'was', 'were', 'been'];
    
    let esCount = 0;
    let enCount = 0;

    for (const word of esWords) {
      if (lowerText.includes(word)) esCount++;
    }

    for (const word of enWords) {
      if (lowerText.includes(word)) enCount++;
    }

    // Check for Spanish-specific patterns (articles, prepositions)
    const esPatterns = [
      /\b(el|la|los|las|un|una|unos|unas)\s+\w+/gi,  // Spanish articles with noun
      /\b(de|del|en|es|son|por|para|con|sin|sobre)\s+/gi,  // Spanish prepositions
      /\w+ción\b/gi,  // words ending in -ción
      /\w+dad\b/gi,   // words ending in -dad
      /\b(qué|cómo|dónde|cuál|quién)\b/gi,  // Spanish question words
    ];
    
    const enPatterns = [
      /\b(the|a|an)\s+\w+/gi,  // English articles with noun
      /\b(of|in|to|for|with|without|about|from|on|at)\s+/gi,  // English prepositions
      /\w+tion\b/gi,  // words ending in -tion
      /\w+ness\b/gi,  // words ending in -ness
      /\b(what|how|where|which|who|when|why)\b/gi,  // English question words
    ];
    
    for (const pattern of esPatterns) {
      const matches = lowerText.match(pattern);
      if (matches) esCount += matches.length * 0.3;
    }
    
    for (const pattern of enPatterns) {
      const matches = lowerText.match(pattern);
      if (matches) enCount += matches.length * 0.3;
    }

    return esCount > enCount ? 'es' : 'en';
  }

  /**
   * Call ModelRouter for AI generation
   */
  async callModelRouter(analysis) {
    const axios = require('axios');
    
    // Detect language from the original message
    const originalMessage = analysis.message || '';
    const detectedLang = this.detectLanguage(originalMessage);
    const languageHint = detectedLang === 'es' ? 'Spanish' : 'English';

    this.logger.info('Language detection for draft', {
      detectedLang,
      languageHint,
      messagePreview: originalMessage.substring(0, 100)
    });

    const prompt = `
Write a reply to the email below.

Rules:
- Reply in the SAME language as the original message.
- Use only the context from the original message.
- Keep it concise and helpful.
- Do not mention policies, training, or that you are an AI.
- Return ONLY the email body (no subject line).

Original message:
${originalMessage || 'No content'}
`;

    try {
      const response = await axios.post(
        `${this.config.MODEL_ROUTER_URL}/api/generate`,
        {
          task: 'EMAIL_DRAFT_TASK',
          prompt,
          context: {
            clientEmail: analysis.email,
            clientCompany: analysis.company,
            clientService: analysis.service,
            detectedLanguage: detectedLang
          },
          timeout: this.config.EMAIL_DRAFT_TASK_TIMEOUT * 1000
        },
        { timeout: this.config.EMAIL_DRAFT_TASK_TIMEOUT * 1000 }
      );

      return response.data.response || response.data.content || response.data;

    } catch (error) {
      // Fallback to simple response if ModelRouter fails
      this.logger.warn('ModelRouter failed, using fallback', { 
        error: error.message 
      });

      return this.generateFallbackDraft(analysis, detectedLang);
    }
  }

  /**
   * Generate fallback draft when AI fails
   * Now language-aware!
   */
  generateFallbackDraft(analysis, language = 'en') {
    const company = analysis.company || (language === 'es' ? 'tu empresa' : 'your company');
    const service = analysis.service || (language === 'es' ? 'nuestros servicios' : 'our services');
    
    if (language === 'es') {
      return `Hola,

Gracias por tu interés en MDX.so y por comunicarte con nosotros.

Nos especializamos en ${service} y nos encantaría conocer más detalles sobre tu proyecto para ${company}.

¿Podrías compartirnos más información sobre tus necesidades específicas y el alcance del proyecto?

Quedamos atentos.

Saludos,
Equipo MDX.so`;
    }
    
    // English fallback
    return `Hello,

Thank you for your interest in MDX.so and for reaching out to us.

We specialize in ${service} and would love to learn more details about your project for ${company}.

Could you share more information about your specific needs and project scope?

We look forward to hearing from you.

Best regards,
MDX.so Team`;
  }

  /**
   * Regenerate an existing draft with optional instruction
   * This is called by the regenerate endpoint
   */
  async regenerate(draft, instruction = 'rewrite') {
    this.logger.info('Regenerating draft', { 
      draftId: draft.id,
      instruction 
    });

    // Build analysis object from existing draft
    const analysis = {
      email: draft.client?.email,
      name: draft.client?.name,
      company: draft.client?.company,
      service: draft.client?.service,
      message: draft.emailData?.originalMessage || draft.original,
      gmailId: draft.emailData?.gmailId,
      threadId: draft.emailData?.threadId,
      subject: draft.emailData?.subject
    };

    try {
      const axios = require('axios');
      
      // Detect language from the original message
      const originalMessage = analysis.message || '';
      const detectedLang = this.detectLanguage(originalMessage);
      const languageHint = detectedLang === 'es' ? 'Spanish' : 'English';

      this.logger.info('Regenerate: Language detection', {
        draftId: draft.id,
        detectedLang,
        languageHint
      });

      // Build instruction-aware prompt
      let instructionText = '';
      if (instruction && instruction !== 'rewrite') {
        instructionText = `\n\nAdditional instruction from user: ${instruction}`;
      }

      const prompt = `
Regenerate the email reply with the following instruction: ${instruction}

CRITICAL LANGUAGE INSTRUCTION:
- You MUST write the reply in ${languageHint}.
- The customer's original message is in ${detectedLang === 'es' ? 'Spanish' : 'English'}.
- Reply in the SAME language as the customer's original message.
- This is mandatory - do not switch languages.

Customer:

Name: ${analysis.name || 'Prospect'}
Company: ${analysis.company || 'Not specified'}
Service of interest: ${analysis.service || 'Not specified'}
Original message: ${originalMessage || 'No content'}

Previous draft (for reference):
${draft.draft || 'No previous draft'}
${instructionText}


Return ONLY the email body (no subject line). Keep it concise and professional.

REMINDER: Write the entire response in ${languageHint}.
`;

      const response = await axios.post(
        `${this.config.MODEL_ROUTER_URL}/api/generate`,
        {
          task: 'EMAIL_DRAFT_TASK',
          prompt,
          context: {
            clientEmail: analysis.email,
            clientCompany: analysis.company,
            clientService: analysis.service,
            detectedLanguage: detectedLang,
            instruction,
            isRegeneration: true
          },
          timeout: this.config.EMAIL_DRAFT_TASK_TIMEOUT * 1000
        },
        { timeout: this.config.EMAIL_DRAFT_TASK_TIMEOUT * 1000 }
      );

      const newContent = response.data.response || response.data.content || response.data;
      
      // Update draft with new content
      draft.draft = newContent;
      draft.status = 'pending_review';
      draft.updatedAt = new Date().toISOString();
      draft.regenerateInstruction = null; // Clear the instruction
      
      // Store detected language in analysis
      draft.analysis = draft.analysis || {};
      draft.analysis.language = detectedLang;
      draft.analysis.regeneratedAt = new Date().toISOString();

      return draft;

    } catch (error) {
      this.logger.error('Draft regeneration failed', { 
        error: error.message,
        draftId: draft.id 
      });
      
      // Fallback: use language-aware fallback
      const detectedLang = this.detectLanguage(analysis.message);
      draft.draft = this.generateFallbackDraft(analysis, detectedLang);
      draft.status = 'pending_review';
      draft.updatedAt = new Date().toISOString();
      draft.regenerateInstruction = null;
      
      return draft;
    }
  }

  /**
   * Analyze draft characteristics
   */
  analyzeDraft(analysis) {
    // Generate agent insight
    const sentiment = this.analyzeSentiment(analysis.message);
    const urgency = this.detectUrgency(analysis.message);
    const recommendedAction = this.getRecommendedAction(analysis);
    const language = this.detectLanguage(analysis.message);
    
    const agentInsight = `Sentiment: ${sentiment}. ${urgency}. ${recommendedAction}`;
    
    return {
      serviceCount: analysis.service ? 1 : 0,
      questionCount: (analysis.message?.match(/\?/g) || []).length,
      budgetMentioned: /presupuesto|precio|costo|price|budget/i.test(analysis.message || ''),
      timelineMentioned: /cuándo|cuando|timeline|deadline|urgente/i.test(analysis.message || ''),
      messageType: this.classifyMessageType(analysis),
      specialRequests: [],
      // Language detection
      language,
      // Agent Insight fields
      sentiment,
      urgency,
      recommendedAction,
      agentInsight
    };
  }

  /**
   * Analyze sentiment of the message
   */
  analyzeSentiment(message) {
    const msg = (message || '').toLowerCase();
    
    // Positive indicators
    const positive = /gracias|excelente|perfecto|me gusta|interesante|increíble|genial|bueno|mejor|interesado|encanta|thank|great|excellent|interested|love/i.test(msg);
    // Negative indicators  
    const negative = /no interested|no thank|nothing|not interested|sorry|unfortunately/i.test(msg);
    
    if (positive && !negative) return 'positive';
    if (negative) return 'negative';
    return 'neutral';
  }

  /**
   * Detect urgency level
   */
  detectUrgency(message) {
    const msg = (message || '').toLowerCase();
    
    if (/urgente|emergency|ahora|immediately|asap|urgent|deadline|hoy|para hoy/i.test(msg)) {
      return 'High urgency';
    }
    if (/esta semana|this week|pronto|soon|para mañana|by tomorrow/i.test(msg)) {
      return 'Medium urgency';
    }
    return 'Normal urgency';
  }

  /**
   * Get recommended action based on analysis
   */
  getRecommendedAction(analysis) {
    const msg = (analysis.message || '').toLowerCase();
    
    if (/(estudiante|estudio|universidad|escuela|student|school|university)/i.test(msg)) {
      return 'Recommend: Redirect to free resources or educational materials';
    }
    if (/presupuesto|precio|costo|budget|price/i.test(msg)) {
      return 'Recommend: Send pricing information and package options';
    }
    if (/demo|muestra|example|sample/i.test(msg)) {
      return 'Recommend: Schedule demo call or send case studies';
    }
    if (!analysis.company || !analysis.service) {
      return 'Recommend: Ask clarifying questions about company and needs';
    }
    if (msg.length < 50) {
      return 'Recommend: Request more details about their requirements';
    }
    return 'Recommend: Send personalized proposal based on their inquiry';
  }

  /**
   * Classify message type
   */
  classifyMessageType(analysis) {
    const msg = (analysis.message || '').toLowerCase();
    const company = (analysis.company || '').toLowerCase();

    if (/(estudiante|estudio|universidad|escuela|tarea|homework|student)/i.test(msg)) {
      return 'student';
    }
    if (/(muestra|example|sample|demo|prueba)/i.test(msg)) {
      return 'sample_request';
    }
    if (/whatsapp|telegram|signal/i.test(msg)) {
      return 'whatsapp_request';
    }
    if (msg.length < 50) {
      return 'short';
    }
    if (!analysis.company && !analysis.service) {
      return 'vague';
    }
    if (/(alemán|francés|español|english|german|french)/i.test(msg) && !/español/i.test(msg)) {
      return 'other_language';
    }
    
    return 'complete';
  }

  /**
   * Save draft to file
   */
  async saveDraft(draft) {
    // Ensure drafts directory exists
    if (!fs.existsSync(this.draftsPath)) {
      fs.mkdirSync(this.draftsPath, { recursive: true });
    }

    const filepath = path.join(this.draftsPath, `${draft.id}.json`);
    await jsonfile.writeFile(filepath, draft, { spaces: 2 });
    
    return filepath;
  }
}

module.exports = Drafter;
