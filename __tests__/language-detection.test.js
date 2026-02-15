/**
 * Tests for Language Detection in Email Drafts
 * 
 * These tests verify that:
 * 1. English emails generate English drafts
 * 2. Spanish emails generate Spanish drafts  
 * 3. Regeneration preserves the original language
 * 4. Language detection works correctly
 */

const Drafter = require('../src/drafter');

// Mock config and logger
const mockConfig = {
  draftsPath: '/tmp/test-drafts',
  MODEL_ROUTER_URL: 'http://localhost:8080',
  EMAIL_DRAFT_TASK_TIMEOUT: 30
};

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
};

describe('Drafter Language Detection', () => {
  let drafter;

  beforeEach(() => {
    drafter = new Drafter(mockConfig, mockLogger);
    jest.clearAllMocks();
  });

  describe('detectLanguage()', () => {
    test('should detect English for English messages', () => {
      const englishMessages = [
        'Hello, I am interested in your services. Can you provide more information?',
        'Hi there, thank you for reaching out. I would like to know more about your pricing.',
        'Good morning, I saw your website and I am interested in working with you.',
        'Hello, my name is John and I represent a company that needs web development.',
        'Thanks for your email. We are looking for a development team.'
      ];

      englishMessages.forEach(msg => {
        const result = drafter.detectLanguage(msg);
        expect(result).toBe('en');
      });
    });

    test('should detect Spanish for Spanish messages', () => {
      const spanishMessages = [
        'Hola, estoy interesado en sus servicios. ¿Pueden darme más información?',
        'Buenos días, gracias por contactarme. Me gustaría saber sobre precios.',
        'Buenas tardes, necesito información sobre su empresa.',
        'Hola, mi nombre es Juan y represento una empresa que necesita desarrollo web.',
        'Gracias por su respuesta. Estamos buscando un equipo de desarrollo.'
      ];

      spanishMessages.forEach(msg => {
        const result = drafter.detectLanguage(msg);
        expect(result).toBe('es');
      });
    });

    test('should default to English for ambiguous/empty messages', () => {
      const ambiguousMessages = [
        '',
        '   ',
        'OK',
        'Yes',
        'No',
        '12345',
        '???'
      ];

      ambiguousMessages.forEach(msg => {
        const result = drafter.detectLanguage(msg);
        expect(result).toBe('en');
      });
    });

    test('should detect Spanish with common words', () => {
      const result = drafter.detectLanguage('¿Cuánto cuesta el servicio?');
      expect(result).toBe('es');
    });

    test('should detect English with common words', () => {
      const result = drafter.detectLanguage('How much does the service cost?');
      expect(result).toBe('en');
    });
  });

  describe('generateFallbackDraft()', () => {
    test('should generate English fallback when language is en', () => {
      const analysis = {
        company: 'Test Company',
        service: 'web development'
      };

      const result = drafter.generateFallbackDraft(analysis, 'en');

      expect(result).toContain('Hello');
      expect(result).toContain('Thank you');
      expect(result).toContain('MDX.so');
      expect(result).not.toContain('Hola');
      expect(result).not.toContain('Gracias por tu interés');
    });

    test('should generate Spanish fallback when language is es', () => {
      const analysis = {
        company: 'Empresa Test',
        service: 'desarrollo web'
      };

      const result = drafter.generateFallbackDraft(analysis, 'es');

      expect(result).toContain('Hola');
      expect(result).toContain('Gracias por tu interés');
      expect(result).toContain('MDX.so');
      expect(result).not.toContain('Hello');
      expect(result).not.toContain('Thank you');
    });

    test('should use default values in English for missing data', () => {
      const analysis = {};
      const result = drafter.generateFallbackDraft(analysis, 'en');
      
      expect(result).toContain('your company');
      expect(result).toContain('our services');
    });

    test('should use default values in Spanish for missing data', () => {
      const analysis = {};
      const result = drafter.generateFallbackDraft(analysis, 'es');
      
      expect(result).toContain('tu empresa');
      expect(result).toContain('nuestros servicios');
    });
  });

  describe('analyzeDraft()', () => {
    test('should include language in analysis', () => {
      const englishAnalysis = {
        message: 'Hello, I am interested in your services.',
        company: 'Test Co',
        service: 'Development'
      };

      const result = drafter.analyzeDraft(englishAnalysis);
      expect(result.language).toBe('en');
    });

    test('should detect Spanish language in analysis', () => {
      const spanishAnalysis = {
        message: 'Hola, estoy interesado en sus servicios.',
        company: 'Empresa Test',
        service: 'Desarrollo'
      };

      const result = drafter.analyzeDraft(spanishAnalysis);
      expect(result.language).toBe('es');
    });
  });
});

describe('Language Detection Integration', () => {
  test('should not have Spanish instructions in default prompt', () => {
    const drafter = new Drafter(mockConfig, mockLogger);
    const prompt = drafter.getDefaultPrompt();
    
    // The prompt should be in English to avoid Spanish bias
    expect(prompt).toContain('professional sales assistant');
    expect(prompt).not.toContain('Eres un asistente');
    expect(prompt).not.toContain('ventas profesional');
  });

  test('system prompt should mention language rule', () => {
    const drafter = new Drafter(mockConfig, mockLogger);
    const prompt = drafter.getDefaultPrompt();
    
    // Should include language instruction
    expect(prompt.toLowerCase()).toMatch(/language|spanish|english/i);
  });
});
