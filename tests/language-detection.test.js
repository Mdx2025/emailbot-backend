/**
 * Language Detection Tests
 * Validates that drafts are generated in the correct language
 */

const assert = require('assert');

// Mock the Drafter class
const Drafter = require('../src/drafter');

// Create mock config and logger
const mockConfig = {
  draftsPath: '/tmp/test-drafts',
  MODEL_ROUTER_URL: 'http://localhost:3002',
  EMAIL_DRAFT_TASK_TIMEOUT: 30
};

const mockLogger = {
  info: (...args) => console.log('[INFO]', ...args),
  warn: (...args) => console.log('[WARN]', ...args),
  error: (...args) => console.log('[ERROR]', ...args)
};

const drafter = new Drafter(mockConfig, mockLogger);

console.log('='.repeat(60));
console.log('Language Detection Tests');
console.log('='.repeat(60));

// Test 1: Spanish message detection
console.log('\nTest 1: Spanish message detection');
const spanishMessage = `Hola, estoy interesado en sus servicios de desarrollo web. Me gustaría saber más información sobre precios y tiempos de entrega. Gracias!`;
const detectedEs = drafter.detectLanguage(spanishMessage);
console.log(`  Input: "${spanishMessage.substring(0, 50)}..."`);
console.log(`  Detected: ${detectedEs}`);
console.log(`  Expected: es`);
assert.strictEqual(detectedEs, 'es', 'Should detect Spanish');
console.log('  ✅ PASSED');

// Test 2: English message detection
console.log('\nTest 2: English message detection');
const englishMessage = `Hello, I'm interested in your web development services. I would like to know more about pricing and delivery times. Thanks!`;
const detectedEn = drafter.detectLanguage(englishMessage);
console.log(`  Input: "${englishMessage.substring(0, 50)}..."`);
console.log(`  Detected: ${detectedEn}`);
console.log(`  Expected: en`);
assert.strictEqual(detectedEn, 'en', 'Should detect English');
console.log('  ✅ PASSED');

// Test 3: Short Spanish message
console.log('\nTest 3: Short Spanish message');
const shortSpanish = `Hola, necesito información sobre su producto.`;
const detectedShortEs = drafter.detectLanguage(shortSpanish);
console.log(`  Input: "${shortSpanish}"`);
console.log(`  Detected: ${detectedShortEs}`);
console.log(`  Expected: es`);
assert.strictEqual(detectedShortEs, 'es', 'Should detect Spanish in short message');
console.log('  ✅ PASSED');

// Test 4: Short English message
console.log('\nTest 4: Short English message');
const shortEnglish = `Hi, I need information about your product.`;
const detectedShortEn = drafter.detectLanguage(shortEnglish);
console.log(`  Input: "${shortEnglish}"`);
console.log(`  Detected: ${detectedShortEn}`);
console.log(`  Expected: en`);
assert.strictEqual(detectedShortEn, 'en', 'Should detect English in short message');
console.log('  ✅ PASSED');

// Test 5: Fallback draft in Spanish
console.log('\nTest 5: Spanish fallback draft');
const spanishAnalysis = {
  email: 'test@example.com',
  name: 'Juan',
  company: 'Empresa XYZ',
  service: 'desarrollo web',
  message: spanishMessage
};
const spanishFallback = drafter.generateFallbackDraft(spanishAnalysis, 'es');
console.log(`  Generated fallback (first 100 chars): "${spanishFallback.substring(0, 100)}..."`);
assert.ok(spanishFallback.includes('Hola'), 'Should include Spanish greeting');
assert.ok(!spanishFallback.includes('Hello'), 'Should NOT include English greeting');
console.log('  ✅ PASSED');

// Test 6: Fallback draft in English
console.log('\nTest 6: English fallback draft');
const englishAnalysis = {
  email: 'test@example.com',
  name: 'John',
  company: 'Company ABC',
  service: 'web development',
  message: englishMessage
};
const englishFallback = drafter.generateFallbackDraft(englishAnalysis, 'en');
console.log(`  Generated fallback (first 100 chars): "${englishFallback.substring(0, 100)}..."`);
assert.ok(englishFallback.includes('Hello'), 'Should include English greeting');
assert.ok(!englishFallback.includes('Hola'), 'Should NOT include Spanish greeting');
console.log('  ✅ PASSED');

// Test 7: Default prompt is language-agnostic
console.log('\nTest 7: Default prompt is language-agnostic');
const defaultPrompt = drafter.getDefaultPrompt();
console.log(`  Prompt starts with: "${defaultPrompt.substring(0, 50)}..."`);
assert.ok(!defaultPrompt.includes('Eres un asistente'), 'Should NOT have Spanish intro');
assert.ok(defaultPrompt.includes('You are a professional'), 'Should have English intro');
assert.ok(!defaultPrompt.includes('Reglas:'), 'Should NOT have Spanish rules header');
assert.ok(defaultPrompt.includes('Rules:'), 'Should have English rules header');
console.log('  ✅ PASSED');

// Test 8: System prompt includes detected language
console.log('\nTest 8: System prompt loads correctly');
const systemPrompt = drafter.systemPrompt;
console.log(`  System prompt length: ${systemPrompt.length} chars`);
assert.ok(systemPrompt.length > 100, 'Should have a substantial system prompt');
console.log('  ✅ PASSED');

// Test 9: Empty/null message defaults to English
console.log('\nTest 9: Empty message defaults to English');
const detectedEmpty = drafter.detectLanguage('');
const detectedNull = drafter.detectLanguage(null);
console.log(`  Empty string detected as: ${detectedEmpty}`);
console.log(`  Null detected as: ${detectedNull}`);
assert.strictEqual(detectedEmpty, 'en', 'Empty string should default to English');
assert.strictEqual(detectedNull, 'en', 'Null should default to English');
console.log('  ✅ PASSED');

// Test 10: Mixed content (more Spanish words)
console.log('\nTest 10: Mixed content (more Spanish)');
const mixedSpanish = `Hola hello gracias thanks por favor please consulta inquiry`;
const detectedMixedEs = drafter.detectLanguage(mixedSpanish);
console.log(`  Input: "${mixedSpanish}"`);
console.log(`  Detected: ${detectedMixedEs}`);
console.log(`  Expected: es (more Spanish words)`);
assert.strictEqual(detectedMixedEs, 'es', 'Should detect Spanish when more Spanish words present');
console.log('  ✅ PASSED');

// Test 11: Mixed content (more English words)
console.log('\nTest 11: Mixed content (more English)');
const mixedEnglish = `Hello there! I am interested in your web development services for my company. I would like to get more information about pricing and how we could work together on this project. Please let me know when you have time to discuss.`;
const detectedMixedEn = drafter.detectLanguage(mixedEnglish);
console.log(`  Input: "${mixedEnglish.substring(0, 50)}..."`);
console.log(`  Detected: ${detectedMixedEn}`);
console.log(`  Expected: en (more English words)`);
assert.strictEqual(detectedMixedEn, 'en', 'Should detect English when more English words present');
console.log('  ✅ PASSED');

// Test 12: analyzeDraft includes language
console.log('\nTest 12: analyzeDraft includes language detection');
const analysis = drafter.analyzeDraft({
  message: spanishMessage,
  company: 'Test Company',
  service: 'Test Service'
});
console.log(`  Detected language in analysis: ${analysis.language}`);
assert.strictEqual(analysis.language, 'es', 'Analysis should include detected language');
console.log('  ✅ PASSED');

console.log('\n' + '='.repeat(60));
console.log('All tests passed! ✅');
console.log('='.repeat(60));
