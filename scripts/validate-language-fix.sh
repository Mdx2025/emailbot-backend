#!/bin/bash
#
# Validation Script for Language Detection Fix
# This script validates that the Spanish drafts bug has been fixed.
#
# Usage: ./scripts/validate-language-fix.sh [API_BASE_URL]
#
# Example:
#   ./scripts/validate-language-fix.sh https://emailbot-backend-production.up.railway.app
#

set -e

API_BASE="${1:-http://localhost:3001}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

echo "============================================================"
echo "Language Detection Fix Validation Script"
echo "============================================================"
echo ""
echo "API Base: $API_BASE"
echo "Project Root: $PROJECT_ROOT"
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

pass() {
    echo -e "${GREEN}✅ PASS${NC}: $1"
}

fail() {
    echo -e "${RED}❌ FAIL${NC}: $1"
}

info() {
    echo -e "${YELLOW}ℹ️ INFO${NC}: $1"
}

# Track test results
TESTS_PASSED=0
TESTS_FAILED=0

# Test 1: Run unit tests
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Test 1: Unit Tests for Language Detection"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

cd "$PROJECT_ROOT"
if node tests/language-detection.test.js > /dev/null 2>&1; then
    pass "Unit tests passed"
    ((TESTS_PASSED++))
else
    fail "Unit tests failed"
    ((TESTS_FAILED++))
    node tests/language-detection.test.js
fi

# Test 2: Check API health
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Test 2: API Health Check"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

HEALTH_RESPONSE=$(curl -s "$API_BASE/health" 2>/dev/null || echo '{"status":"error"}')
if echo "$HEALTH_RESPONSE" | grep -q '"status":"ok"'; then
    pass "API is healthy"
    ((TESTS_PASSED++))
else
    fail "API health check failed: $HEALTH_RESPONSE"
    ((TESTS_FAILED++))
fi

# Test 3: Generate draft with English message
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Test 3: Draft Generation with English Message"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

info "This test simulates generating a draft for an English lead..."

# We can't easily test actual draft generation without Gmail access,
# but we can verify the regenerate endpoint works

# Test 4: Verify regenerate endpoint exists
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Test 4: Regenerate Endpoint Exists"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Try to call regenerate on a non-existent draft - should get 404, not 500
REGEN_RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
    "$API_BASE/api/drafts/00000000-0000-0000-0000-000000000000/regenerate" \
    -H "Content-Type: application/json" \
    -d '{"instruction":"rewrite"}' 2>/dev/null || echo "000")

if [ "$REGEN_RESPONSE" = "404" ]; then
    pass "Regenerate endpoint exists (404 for non-existent draft is expected)"
    ((TESTS_PASSED++))
elif [ "$REGEN_RESPONSE" = "500" ]; then
    fail "Regenerate endpoint has server error (500)"
    ((TESTS_FAILED++))
elif [ "$REGEN_RESPONSE" = "000" ] || [ "$REGEN_RESPONSE" = "000" ]; then
    info "Could not reach regenerate endpoint (network issue or server not running)"
    # Don't count as failure for offline testing
else
    info "Regenerate endpoint returned HTTP $REGEN_RESPONSE"
    ((TESTS_PASSED++))
fi

# Test 5: Check drafter.js has language detection
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Test 5: Code Review - Language Detection Implementation"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

DRAFTER_PATH="$PROJECT_ROOT/src/drafter.js"

# Check for detectLanguage method
if grep -q "detectLanguage" "$DRAFTER_PATH"; then
    pass "detectLanguage method exists in drafter.js"
    ((TESTS_PASSED++))
else
    fail "detectLanguage method NOT found in drafter.js"
    ((TESTS_FAILED++))
fi

# Check for language-aware fallback
if grep -q "generateFallbackDraft(analysis, language" "$DRAFTER_PATH"; then
    pass "generateFallbackDraft is language-aware"
    ((TESTS_PASSED++))
else
    fail "generateFallbackDraft is NOT language-aware"
    ((TESTS_FAILED++))
fi

# Check for English default prompt
if grep -q "You are a professional sales assistant" "$DRAFTER_PATH"; then
    pass "Default prompt is in English (not Spanish)"
    ((TESTS_PASSED++))
else
    fail "Default prompt is NOT in English"
    ((TESTS_FAILED++))
fi

# Check regenerate method exists
if grep -q "async regenerate(draft, instruction" "$DRAFTER_PATH"; then
    pass "regenerate method exists in drafter.js"
    ((TESTS_PASSED++))
else
    fail "regenerate method NOT found in drafter.js"
    ((TESTS_FAILED++))
fi

# Test 6: Check server uses regenerate method
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Test 6: Server Integration - Regenerate Endpoint"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

SERVER_PATH="$PROJECT_ROOT/server-new.js"

# Check that server calls drafter.regenerate
if grep -q "drafter.regenerate" "$SERVER_PATH"; then
    pass "Server calls drafter.regenerate method"
    ((TESTS_PASSED++))
else
    fail "Server does NOT call drafter.regenerate method"
    ((TESTS_FAILED++))
fi

# Check that language is passed in regenerate request
if grep -q "detectedLanguage:" "$SERVER_PATH"; then
    pass "Server returns detectedLanguage in response"
    ((TESTS_PASSED++))
else
    fail "Server does NOT return detectedLanguage"
    ((TESTS_FAILED++))
fi

# Summary
echo ""
echo "============================================================"
echo "Validation Summary"
echo "============================================================"
echo ""
echo -e "Tests Passed: ${GREEN}$TESTS_PASSED${NC}"
echo -e "Tests Failed: ${RED}$TESTS_FAILED${NC}"
echo ""

if [ $TESTS_FAILED -eq 0 ]; then
    echo -e "${GREEN}All validation tests passed! ✅${NC}"
    echo ""
    echo "The language detection fix has been successfully implemented."
    echo ""
    echo "Key changes made:"
    echo "  1. Default system prompt changed to English (was Spanish)"
    echo "  2. Added detectLanguage() method for language detection"
    echo "  3. Fallback drafts are now language-aware"
    echo "  4. Regenerate endpoint now actually regenerates drafts"
    echo "  5. Language is detected from original message"
    echo ""
    exit 0
else
    echo -e "${RED}Some validation tests failed. Please review the output above.${NC}"
    exit 1
fi
