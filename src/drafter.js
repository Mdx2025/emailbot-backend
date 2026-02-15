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
    return `
Eres un asistente de ventas profesional para MDX.so.
Tu任务是 redactar respuestas a leads potenciales.

Reglas:
1. PERSONALIZA cada respuesta con el nombre de la empresa
2. NO uses nombres falsos de clientes
3. NO uses placeholders como [Nombre]
4. Responde de manera profesional pero cálida
5. Mantén el email corto (3-4 oraciones máximo)
6. Incluye llamada a la acción clara
7. No incluyas firmas elaboradas
8. Si el lead es vago, pregunta clarificadores
9. Si menciona presupuesto, adapta la respuesta
10. Si es estudiantes o proyectos escolares,declina educadamente

Formato de respuesta:
- Saludo personalizado
- 2-3 oraciones respondiendo su consulta
- Pregunta clarificadora o siguiente paso
- Despedida simple
    `.trim();
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
   * Call ModelRouter for AI generation
   */
  async callModelRouter(analysis) {
    const axios = require('axios');
    
    const prompt = `
Genera un email de respuesta profesional para:

Cliente: ${analysis.name || 'Cliente potencial'}
Empresa: ${analysis.company || 'No especificada'}
Servicio de interés: ${analysis.service || 'No especificado'}
Mensaje original: ${analysis.message || 'Sin contenido'}

${this.systemPrompt}

Responde SOLO con el contenido del email, sin asunto, sin firma elaborada.
El email debe estar en español.
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
            clientService: analysis.service
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

      return this.generateFallbackDraft(analysis);
    }
  }

  /**
   * Generate fallback draft when AI fails
   */
  generateFallbackDraft(analysis) {
    const company = analysis.company || 'tu empresa';
    const service = analysis.service || 'nuestros servicios';
    
    return `Hola,

Gracias por tu interés en MDX.so y por comunicarte con nosotros.

Nos especializamos en ${service} y nos encantaría conocer más detalles sobre tu proyecto para ${company}.

¿Podrías compartirnos más información sobre tus necesidades específicas y el alcance del proyecto?

Quedamos atentos.

Saludos,
Equipo MDX.so`;
  }

  /**
   * Analyze draft characteristics
   */
  analyzeDraft(analysis) {
    return {
      serviceCount: analysis.service ? 1 : 0,
      questionCount: (analysis.message?.match(/\?/g) || []).length,
      budgetMentioned: /presupuesto|precio|costo|price|budget/i.test(analysis.message || ''),
      timelineMentioned: /cuándo|cuando|timeline|deadline|urgente/i.test(analysis.message || ''),
      messageType: this.classifyMessageType(analysis),
      specialRequests: [],
      // NEW: Language detection
      language: this.detectLanguage(analysis),
      // NEW: SLA calculation
      sla: this.calculateSLA(analysis)
    };
  }

  /**
   * Detect message language (ES/EN)
   */
  detectLanguage(analysis) {
    const msg = (analysis.message || '').toLowerCase();
    const company = (analysis.company || '').toLowerCase();

    // Check for Spanish indicators
    if (/hola|gracias|buenos días|buenas tardes|buenas noches|estimado|buen día|saludos|atentamente/i.test(msg)) {
      return 'ES';
    }

    // Check for Spanish company name
    if (/s\.a\.|s\.l\.|sociedad|empresa|consultoría|servicios|talleres|asesor/i.test(company)) {
      return 'ES';
    }

    // Check for English indicators
    if (/hello|hi|hey|good morning|good afternoon|dear|regards|sincerely|best/i.test(msg)) {
      return 'EN';
    }

    // Check for English company suffixes
    if (/inc\.|llc|corp\.|ltd\.|pty\.|gmbh/i.test(company)) {
      return 'EN';
    }

    // Default to English if no clear indicators
    return 'EN';
  }

  /**
   * Calculate SLA based on urgency
   */
  calculateSLA(analysis) {
    const msg = (analysis.message || '').toLowerCase();
    const subject = (analysis.subject || '').toLowerCase();

    // Urgent keywords - respond within 1 hour
    if (/urgent|emergency|asap|as soon as possible|inmediatamente|ya|ahora|inmediato|critical|crítico/i.test(msg + ' ' + subject)) {
      return '1h';
    }

    // High priority - respond within 4 hours
    if (/deadline|importante|important|prioridad|priority|necesito|need|requiero|require/i.test(msg + ' ' + subject)) {
      return '4h';
    }

    // If it's a high-value lead or has budget mention - respond within 8 hours
    if (analysis.leadScore > 80 || /presupuesto|precio|costo|budget|price/i.test(msg)) {
      return '8h';
    }

    // Standard SLA - respond within 24 hours
    return '24h';
  }

  /**
   * Classify message type
   */
  classifyMessageType(analysis) {
    const msg = (analysis.message || '').toLowerCase();
    const company = (analysis.company || '').toLowerCase();

    if (/(estudiante|estudio|universidad|escuela|tarea|homework)/i.test(msg)) {
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
