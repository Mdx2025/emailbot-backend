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
      // Pre-compute draft analysis (used for both prompting + draft metadata)
      const draftAnalysis = this.analyzeDraft(analysis);

      // Call ModelRouter for GPT generation
      const draftContent = await this.callModelRouter({ ...analysis, messageType: draftAnalysis.messageType });

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
        analysis: draftAnalysis,
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
   * Call Gemini for AI generation (direct)
   */
  async callGemini(prompt, detectedLang, context = {}) {
    const axios = require('axios');

    const apiKey = this.config.GEMINI_API_KEY || process.env.GEMINI_API_KEY;
    if (!apiKey) {
      // Make the failure explicit in logs; UI otherwise looks like "nothing happened".
      this.logger.error('Gemini not configured: missing GEMINI_API_KEY', { context, detectedLang });
      throw new Error('GEMINI_API_KEY is not set');
    }

    // Validate model - fallback to working model if the configured one is invalid
    const VALID_MODELS = ['gemini-2.0-flash-001', 'gemini-2.5-flash', 'gemini-flash-latest', 'gemini-2.0-flash'];
    const configuredModel = this.config.GEMINI_MODEL || process.env.GEMINI_MODEL;
    const model = VALID_MODELS.includes(configuredModel) ? configuredModel : 'gemini-2.0-flash-001';

    // Safety: keep outputs stable and avoid creative drift
    const generationConfig = {
      temperature: 0.4,
      topP: 0.95,
      maxOutputTokens: 5000
      // Note: minOutputTokens removed as it can cause 400 errors for short emails
    };

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    let response;
    try {
      response = await axios.post(
        url,
        {
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig
        },
        { timeout: this.config.EMAIL_DRAFT_TASK_TIMEOUT * 1000 }
      );
    } catch (axiosError) {
      // Log detailed error information
      const errorDetails = axiosError.response?.data || axiosError.message;
      this.logger.error('Gemini API request failed', { 
        error: errorDetails,
        status: axiosError.response?.status,
        model,
        promptLength: prompt.length,
        context 
      });
      throw new Error(`Gemini API error: ${JSON.stringify(errorDetails)}`);
    }

    const candidate = response.data?.candidates?.[0];
    const text = candidate?.content?.parts?.map(p => p.text).join('')
      || candidate?.content?.parts?.[0]?.text
      || '';

    // Check for truncation or other finish reasons
    const finishReason = candidate?.finishReason;
    const safetyRatings = candidate?.safetyRatings;
    
    if (finishReason && finishReason !== 'STOP') {
      this.logger.warn('Gemini finished with non-STOP reason', { 
        finishReason, 
        model, 
        textLength: text.length,
        safetyRatings,
        context 
      });
    }

    if (!text) {
      this.logger.error('Gemini returned empty content', { detectedLang, model, context, finishReason });
      throw new Error('Gemini returned empty content');
    }

    // Warn if text seems truncated (ends mid-sentence or very short)
    if (text.length < 200 || /[a-zA-Z]$/.test(text) && !text.endsWith('.')) {
      this.logger.warn('Draft may be truncated', { 
        textLength: text.length, 
        endsWith: text.slice(-20),
        finishReason,
        model
      });
    }

    return String(text).trim();
  }

  /**
   * Format original message for better readability
   * Parses contact form submissions and formats them nicely
   */
  formatOriginalMessage(message) {
    if (!message) return 'No content';
    
    // Check if it's a contact form submission
    if (message.includes('You have received a new message from your website contact form')) {
      // Extract fields using regex
      const fields = {
        name: message.match(/Name:\s*([^\n]+)/)?.[1]?.trim(),
        company: message.match(/Company:\s*([^\n]+)/)?.[1]?.trim(),
        email: message.match(/Email:\s*([^\n]+)/)?.[1]?.trim(),
        phone: message.match(/Phone:\s*([^\n]+)/)?.[1]?.trim(),
        interested: message.match(/Interested in:\s*([^\n]+)/)?.[1]?.trim(),
        message: message.match(/Message:\s*([\s\S]+?)(?:--|$)/)?.[1]?.trim()
      };
      
      // Build formatted message
      let formatted = '=== CONTACT FORM SUBMISSION ===\n\n';
      if (fields.name) formatted += `👤 Name: ${fields.name}\n`;
      if (fields.company) formatted += `🏢 Company: ${fields.company}\n`;
      if (fields.email) formatted += `📧 Email: ${fields.email}\n`;
      if (fields.phone) formatted += `📞 Phone: ${fields.phone}\n`;
      if (fields.interested) formatted += `💼 Interested in: ${fields.interested}\n`;
      if (fields.message) formatted += `\n📝 Message:\n${fields.message}\n`;
      formatted += '\n===========================';
      
      return formatted;
    }
    
    // For regular emails, just return as-is but trimmed
    return message.trim();
  }

  /**
   * Generate draft (Gemini)
   */
  async callModelRouter(analysis) {
    // Detect language from the original message
    const originalMessage = analysis.message || '';
    const detectedLang = this.detectLanguage(originalMessage);
    const languageHint = detectedLang === 'es' ? 'Spanish' : 'English';

    this.logger.info('Language detection for draft', {
      detectedLang,
      languageHint,
      messagePreview: originalMessage.substring(0, 100)
    });

    // If non-actionable, avoid calling the model entirely.
    if (analysis.messageType === 'non_actionable') {
      return this.generateFallbackDraft(analysis, detectedLang);
    }

    // Format the message for better readability
    const formattedMessage = this.formatOriginalMessage(originalMessage);

    const prompt = `
Write a reply to the email below.

Hard rules:
- Reply in the SAME language as the original message.
- Use only the context from the original message.
- Be specific: reference at least 2 concrete details from the message.
- DO NOT use generic filler like "We specialize in our services".
- If the message asks for a website, propose a next step and ask 3 targeted questions (scope/pages, features, timeline/budget).
- Keep it concise and helpful.
- Do not mention policies, training, or that you are an AI.
- Return ONLY the email body (no subject line).

Original message:
${formattedMessage}
`;

    try {
      const content = await this.callGemini(prompt, detectedLang, {
        clientEmail: analysis.email,
        clientCompany: analysis.company,
        clientService: analysis.service
      });
      return content;
    } catch (error) {
      // Marcelo preference: do not generate any fallback/template-like drafts.
      // If Gemini fails, surface an explicit error so the UI can prompt retry.
      this.logger.error('Gemini failed (no fallback draft will be generated)', { error: error.message });
      throw error;
    }
  }

  /**
   * Generate fallback draft when AI fails
   * Now language-aware!
   */
  generateFallbackDraft(analysis, language = 'en') {
    // If it's a notification/system email, do not create a sales reply.
    const msgType = analysis?.messageType || analysis?.draftAnalysis?.messageType;
    if (msgType === 'non_actionable') {
      return language === 'es'
        ? `No action needed.

(Automated notification detected — no reply will be sent.)`
        : `No action needed.

(Automated notification detected — no reply will be sent.)`;
    }

    // IMPORTANT: avoid any canned sales template. If we are here, AI generation failed.
    // Return a minimal, context-neutral reply that won't look like a template.
    if (language === 'es') {
      return `Hola,

Gracias por tu mensaje. ¿Podrías compartir un poco más de contexto o el objetivo principal para poder ayudarte mejor?

Saludos,`;
    }

    return `Hello,

Thanks for your message. Could you share a bit more context or your main goal so I can help you properly?

Best regards,`;
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

      // Minimal prompt: let Gemini judge content and write a human, contextual reply.
      // We only pass a small nudge for shorten/expand; otherwise keep it neutral.
      let modeLine = '';
      const mode = String(instruction || 'rewrite').toLowerCase();
      if (mode === 'shorten') modeLine = 'Make it shorter.';
      else if (mode === 'expand') modeLine = 'Make it a bit longer.';
      else modeLine = 'Rewrite naturally.';

      const prompt = `${this.systemPrompt}

Write the reply in ${languageHint}.

Customer name: ${analysis.name || 'Prospect'}
Company: ${analysis.company || 'Not specified'}
Original message:
${originalMessage || 'No content'}

(For reference only) Previous draft:
${draft.draft || 'No previous draft'}

Task: ${modeLine}

Return ONLY the email body.`;

      const newContent = await this.callGemini(prompt, detectedLang, {
        draftId: draft.id,
        clientEmail: analysis.email,
        instruction: mode,
        isRegeneration: true
      });
      
      // Update draft with new content
      draft.draft = newContent || this.generateFallbackDraft(analysis, detectedLang);
      draft.status = 'pending_review';
      draft.updatedAt = new Date().toISOString();
      draft.regenerateInstruction = null; // Clear the instruction
      
      // Store detected language in analysis
      draft.analysis = draft.analysis || {};
      draft.analysis.language = detectedLang;
      draft.analysis.regeneratedAt = new Date().toISOString();

      return draft;

    } catch (error) {
      // Marcelo preference: no fallback/template-like drafts.
      // Keep the previous draft unchanged and surface error to caller.
      this.logger.error('Draft regeneration failed (no fallback will be used)', { 
        error: error.message,
        draftId: draft.id 
      });

      // Ensure we don't leave it stuck in generating.
      draft.status = 'pending_review';
      draft.updatedAt = new Date().toISOString();
      draft.regenerateInstruction = null;

      throw error;
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
    const subject = (analysis.subject || analysis.emailSubject || '').toLowerCase();
    const fromEmail = (analysis.email || analysis.fromEmail || '').toLowerCase();

    // Non-actionable notifications (receipts, billing, system alerts, scheduling, trials)
    if (
      /(no-reply|noreply|do-not-reply)/i.test(fromEmail) ||
      /(receipt|invoice|funded|billing|payment|charged|usage limit|limits have increased|trial is ending|premium features|subscription|renewal)/i.test(subject) ||
      /(calendly|meeting scheduled|invitee|google meet|zoom)/i.test(msg) ||
      /(you have \d+ more days|upgrade now|workspace url|sign in)/i.test(msg)
    ) {
      return 'non_actionable';
    }

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
