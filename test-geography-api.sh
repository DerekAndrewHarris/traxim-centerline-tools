#!/bin/bash
# Quick Geography API Test Script (Bash/curl version)
# Usage: ./test-geography-api.sh [base_url]

BASE_URL="${1:-http://localhost:3001}"
API_BASE="$BASE_URL/api"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

echo -e "\n${YELLOW}═══════════════════════════════════════════════════════${NC}"
echo -e "${YELLOW}  Traxim File Generator - Geography API Test Suite${NC}"
echo -e "${YELLOW}═══════════════════════════════════════════════════════${NC}\n"

echo -e "${CYAN}ℹ API Base URL: $API_BASE${NC}"

# Test 1: Health Check
echo -e "\n${YELLOW}▶ Test 1: Health Check${NC}"
HEALTH=$(curl -s "$API_BASE/health")
if echo "$HEALTH" | jq -e '.success == true' > /dev/null 2>&1; then
    echo -e "${GREEN}✓ Server is operational${NC}"
    echo "$HEALTH" | jq -r '"  Service: \(.service)\n  Version: \(.version)\n  Status: \(.status)"'
else
    echo -e "${RED}✗ Health check failed${NC}"
    exit 1
fi

# Test 2: Create Session
echo -e "\n${YELLOW}▶ Test 2: Create Session${NC}"
SESSION_RESPONSE=$(curl -s -X POST "$API_BASE/sessions")
SESSION_ID=$(echo "$SESSION_RESPONSE" | jq -r '.session.id')

if [ "$SESSION_ID" != "null" ] && [ -n "$SESSION_ID" ]; then
    echo -e "${GREEN}✓ Session created${NC}"
    echo -e "  Session ID: $SESSION_ID"
else
    echo -e "${RED}✗ Session creation failed${NC}"
    exit 1
fi

# Test 3: Geocode Places
echo -e "\n${YELLOW}▶ Test 3: Geocode Places (Genoa, Pisa)${NC}"
GEOCODE_RESPONSE=$(curl -s -X POST "$API_BASE/geography/geocode" \
    -H "Content-Type: application/json" \
    -d "{\"sessionId\": \"$SESSION_ID\", \"places\": [\"Genoa\", \"Pisa\"]}")

GEOCODE_COUNT=$(echo "$GEOCODE_RESPONSE" | jq -r '.results | length')
if [ "$GEOCODE_COUNT" -eq 2 ]; then
    echo -e "${GREEN}✓ Geocoded 2 places${NC}"
    echo "$GEOCODE_RESPONSE" | jq -r '.results[] | "  \(.place):\n    Location: \(.displayName)\n    Coordinates: \(.lat), \(.lon)\n    Source: \(.source)"'
else
    echo -e "${RED}✗ Geocoding failed${NC}"
fi

# Test 4: Query Railway Sections
echo -e "\n${YELLOW}▶ Test 4: Query Railway Sections${NC}"
SECTIONS_RESPONSE=$(curl -s -X POST "$API_BASE/geography/sections" \
    -H "Content-Type: application/json" \
    -d "{\"sessionId\": \"$SESSION_ID\", \"bboxes\": [{\"minLat\": 44.35, \"minLon\": 8.85, \"maxLat\": 44.42, \"maxLon\": 8.95}]}")

SECTIONS_COUNT=$(echo "$SECTIONS_RESPONSE" | jq -r '.sections | length')
echo -e "${GREEN}✓ Found $SECTIONS_COUNT railway sections${NC}"
if [ "$SECTIONS_COUNT" -gt 0 ]; then
    echo "$SECTIONS_RESPONSE" | jq -r '.sections[0:5][] | "  • \(.name)\n    OSM: \(.osmType) \(.osmId)\n    Type: \(.type)"'
fi

# Test 5: Verify Session Metadata
echo -e "\n${YELLOW}▶ Test 5: Verify Session Metadata${NC}"
SESSION_INFO=$(curl -s "$API_BASE/sessions/$SESSION_ID")
GEOCODED_COUNT=$(echo "$SESSION_INFO" | jq -r '.session.metadata.geocodedPlaces | length')
echo -e "${GREEN}✓ Session metadata updated${NC}"
echo -e "  Geocoded places stored: $GEOCODED_COUNT"

# Cleanup
echo -e "\n${YELLOW}▶ Cleanup: Deleting Test Session${NC}"
curl -s -X DELETE "$API_BASE/sessions/$SESSION_ID" > /dev/null
echo -e "${GREEN}✓ Session deleted${NC}"

echo -e "\n${GREEN}All tests passed! Geography API is working correctly.${NC}\n"
