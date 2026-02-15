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
    
    const detectedLang = (analysis?.extractedData?.language || analysis?.language || 'en');
    const languageHint = (String(detectedLang).toLowerCase() === 'es') ? 'Spanish' : 'English';

    const prompt = `
Generate a professional reply email.

IMPORTANT: Write the reply in ${languageHint}, and in the same language as the customer's original message.

Customer:

Name: ${analysis.name || 'Prospect'}
Company: ${analysis.company || 'Not specified'}
Service of interest: ${analysis.service || 'Not specified'}
Original message: ${analysis.message || 'No content'}

${this.systemPrompt}

Responde SOLO con el contenido del email, sin asunto, sin firma elaborada.

REGLA DE IDIOMA (crítica):
- Responde en el MISMO idioma del mensaje original del cliente.
- Si el mensaje original está en inglés, responde en inglés.
- Si es ambiguo, responde en inglés.
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
    // Generate agent insight
    const sentiment = this.analyzeSentiment(analysis.message);
    const urgency = this.detectUrgency(analysis.message);
    const recommendedAction = this.getRecommendedAction(analysis);
    
    const agentInsight = `Sentiment: ${sentiment}. ${urgency}. ${recommendedAction}`;
    
    return {
      serviceCount: analysis.service ? 1 : 0,
      questionCount: (analysis.message?.match(/\?/g) || []).length,
      budgetMentioned: /presupuesto|precio|costo|price|budget/i.test(analysis.message || ''),
      timelineMentioned: /cuándo|cuando|timeline|deadline|urgente/i.test(analysis.message || ''),
      messageType: this.classifyMessageType(analysis),
      specialRequests: [],
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
    const positive = /gracias|excelente|perfecto|me gusta|interesante|increíble|genial|bueno|mejor|interesado|encanta/i.test(msg);
    // Negative indicators  
    const negative = /no|no interested|no thank|nothing|not interested|sorry|unfortunately/i.test(msg);
    
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
    
    if (/(estudiante|estudio|universidad|escuela)/i.test(msg)) {
      return 'Recommend: Redirect to free resources or educational materials';
    }
    if (/presupuesto|precio|costo/i.test(msg)) {
      return 'Recommend: Send pricing information and package options';
    }
    if (/demo|muestra|example/i.test(msg)) {
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
