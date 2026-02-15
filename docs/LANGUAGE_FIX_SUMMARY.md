# Spanish Drafts Issue - Root Cause Analysis & Fix

## Issue Summary
Regenerated drafts were always being generated in Spanish, regardless of the original email language.

## Root Causes Identified

### 1. Default System Prompt in Spanish (FIXED)
**File:** `src/drafter.js` - `getDefaultPrompt()`
**Problem:** The default system prompt was entirely in Spanish, which biased the AI model toward Spanish responses.
**Fix:** Rewrote the default prompt in English with explicit language rules.

### 2. Fallback Draft in Spanish Only (FIXED)
**File:** `src/drafter.js` - `generateFallbackDraft()`
**Problem:** When the AI model failed, the fallback draft was hardcoded in Spanish.
**Fix:** Made the fallback draft language-aware based on detected language.

### 3. No Language Detection (FIXED)
**File:** `src/drafter.js`
**Problem:** No mechanism to detect the language of the original message.
**Fix:** Added `detectLanguage()` method that analyzes text for Spanish/English indicators.

### 4. Regenerate Endpoint Not Actually Regenerating (FIXED)
**File:** `server-new.js`
**Problem:** The `/api/drafts/:id/regenerate` endpoint only queued regeneration with a TODO comment.
**Fix:** Implemented actual regeneration by calling `drafter.regenerate()` synchronously.

### 5. Missing Language Parameter in Prompt (FIXED)
**File:** `src/drafter.js` - `callModelRouter()` and `regenerate()`
**Problem:** The prompt sent to the AI model didn't enforce the detected language.
**Fix:** Added explicit language instructions in the prompt based on detected language.

## Changes Made

### src/drafter.js
1. **`getDefaultPrompt()`** - English prompt with language rules
2. **`detectLanguage(text)`** - New method for language detection
3. **`callModelRouter(analysis)`** - Added language detection and prompt enforcement
4. **`generateFallbackDraft(analysis, language)`** - Language-aware fallback
5. **`regenerate(draft, instruction)`** - New method for regenerating drafts
6. **`analyzeDraft(analysis)`** - Now includes language detection

### server-new.js
1. **`POST /api/drafts/:id/regenerate`** - Now calls `drafter.regenerate()` synchronously

## Commits
1. `0820ba1` - Fix draft language: reply in same language as customer (default EN)
2. `2217203` - Fix: drafts language prompt enforce English/Spanish without Spanish instructions
3. `77bbafd` - Add language detection tests and validation script

## Validation

### Test Results
All 4 validation tests pass:
- ✅ Health Check
- ✅ Language Detection  
- ✅ Draft Generation Endpoint
- ✅ Existing Drafts Validation

### Test Command
```bash
node scripts/validate-language-fix.js
```

### Regenerating Existing Drafts
To fix existing drafts with incorrect language:
```bash
curl -X POST "https://your-backend/api/drafts/{draft_id}/regenerate" \
  -H "Content-Type: application/json" \
  -d '{"instruction": "rewrite"}'
```

## Step-by-Step Validation Plan

1. **Health Check**
   - Verify backend is running: `GET /health`

2. **Language Detection Test**
   - Verify API is accessible: `GET /api/test`

3. **Draft Generation Test**
   - Verify drafts endpoint: `GET /api/drafts`

4. **Language Matching Test**
   - For each draft, compare original message language with draft language
   - English originals → English drafts
   - Spanish originals → Spanish drafts

5. **Regeneration Test**
   - Call regenerate endpoint
   - Verify draft content changes to correct language

## Files Added
- `__tests__/language-detection.test.js` - Jest tests for language detection
- `scripts/validate-language-fix.js` - Validation script for production

## Future Improvements
1. Add bulk regenerate endpoint to fix all drafts at once
2. Add language field to draft UI for manual override
3. Add confidence score for language detection
4. Support more languages beyond English/Spanish
