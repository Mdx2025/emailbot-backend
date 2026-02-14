/**
 * Analyzer Module
 * Analyzes and classifies incoming emails
 */

class Analyzer {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
  }

  /**
   * Analyze incoming email
   */
  async run(emailData) {
    const analysis = {
      ...emailData,
      classification: this.classifyEmail(emailData),
      extractedData: this.extractData(emailData),
      eligibility: this.checkEligibility(emailData),
      analyzedAt: new Date().toISOString()
    };

    this.logger.info('Email analyzed', {
      gmailId: emailData.gmailId,
      classification: analysis.classification.type
    });

    return analysis;
  }

  /**
   * Classify email type
   */
  classifyEmail(emailData) {
    const msg = (emailData.message || '').toLowerCase();
    const subject = (emailData.subject || '').toLowerCase();

    if (/(student|estudiante|universidad|escuela|tarea)/i.test(msg)) {
      return { type: 'student', priority: 'low', description: 'Estudiante/Proyecto académico' };
    }

    if (/(whatsapp|telegram|signal|contact me on)/i.test(msg)) {
      return { type: 'whatsapp_request', priority: 'medium', description: 'Solicitud de cambio de plataforma' };
    }

    if (/(sample|example|demo|prueba|muestra)/i.test(msg + subject)) {
      return { type: 'sample_request', priority: 'medium', description: 'Solicitud de muestra/ejemplo' };
    }

    if (msg.length < 50 || !emailData.company) {
      return { type: 'vague', priority: 'medium', description: 'Consulta vaga o incompleta' };
    }

    if (/presupuesto|precio|costo|budget|price/i.test(msg)) {
      return { type: 'budget_inquiry', priority: 'high', description: 'Consulta de presupuesto' };
    }

    if (/urgente|emergency|asap|尽快/i.test(msg)) {
      return { type: 'urgent', priority: 'urgent', description: 'Solicitud urgente' };
    }

    return { type: 'lead', priority: 'high', description: 'Lead potencial' };
  }

  /**
   * Extract structured data from email
   */
  extractData(emailData) {
    return {
      services: this.extractServices(emailData.message),
      budget: this.extractBudget(emailData.message),
      timeline: this.extractTimeline(emailData.message),
      questions: this.extractQuestions(emailData.message),
      language: this.detectLanguage(emailData.message)
    };
  }

  /**
   * Extract mentioned services
   */
  extractServices(message) {
    const services = [];
    const serviceKeywords = ['desarrollo web', 'app', 'mobile', 'diseño', 'consulting', 'SEO', 'marketing'];
    
    const msg = (message || '').toLowerCase();
    for (const service of serviceKeywords) {
      if (msg.includes(service)) {
        services.push(service);
      }
    }

    return services;
  }

  /**
   * Extract budget information
   */
  extractBudget(message) {
    const budgetPatterns = [
      /(?:presupuesto|budget|precio|price|costo|cost)[\s:]*\$?[\d,.]+/i,
      /(?:entre|más de|mas de|over)[\s\$]*[\d,.]+/i
    ];

    for (const pattern of budgetPatterns) {
      const match = (message || '').match(pattern);
      if (match) {
        return { mentioned: true, value: match[0] };
      }
    }

    return { mentioned: false, value: null };
  }

  /**
   * Extract timeline information
   */
  extractTimeline(message) {
    const timelinePatterns = [
      /(?:cuándo|cuando|timeline|deadline|plazo|para|lista para)[\s:]*[\w\s,]+/i,
      /(?:asap|urgente|urgent|immediately)/i
    ];

    for (const pattern of timelinePatterns) {
      const match = (message || '').match(pattern);
      if (match) {
        return { mentioned: true, value: match[0] };
      }
    }

    return { mentioned: false, value: null };
  }

  /**
   * Extract questions from message
   */
  extractQuestions(message) {
    return (message || '').split(/[?]/).filter(q => q.trim().length > 10).length;
  }

  /**
   * Detect message language
   */
  detectLanguage(message) {
    const esWords = ['hola', 'gracias', 'por favor', 'consulta', 'mensaje', 'empresa', 'saludos'];
    const enWords = ['hello', 'thanks', 'please', 'inquiry', 'message', 'company', 'regards'];
    
    const msg = (message || '').toLowerCase();
    let esCount = 0, enCount = 0;

    for (const word of esWords) {
      if (msg.includes(word)) esCount++;
    }

    for (const word of enWords) {
      if (msg.includes(word)) enCount++;
    }

    return esCount > enCount ? 'es' : 'en';
  }

  /**
   * Check if email is eligible for draft generation
   */
  checkEligibility(emailData) {
    const issues = [];

    // Check if already processed
    if (emailData.alreadyProcessed) {
      issues.push('already_processed');
    }

    // Check if not latest in thread
    if (!emailData.isLatest) {
      issues.push('not_latest_in_thread');
    }

    // Check for auto-response
    if (emailData.subject?.includes('Auto')) {
      issues.push('auto_response');
    }

    return {
      eligible: issues.length === 0,
      issues,
      recommendation: issues.length === 0 ? 'generate_draft' : 'skip'
    };
  }
}

module.exports = Analyzer;
