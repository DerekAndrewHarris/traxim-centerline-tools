# Geography API Testing Guide

## Overview
This guide demonstrates how to test the geography endpoints (geocoding and railway section discovery) in the Traxim File Generator.

## Prerequisites
- Backend server running on http://localhost:3001 (or your configured port)
- PowerShell or curl available for making HTTP requests

## Test Flow

### Step 1: Create a Session
```powershell
$response = Invoke-RestMethod -Uri "http://localhost:3001/api/sessions" -Method POST
$sessionId = $response.id
Write-Host "Session created: $sessionId"
```

Or with curl:
```bash
SESSION_RESPONSE=$(curl -X POST http://localhost:3001/api/sessions)
SESSION_ID=$(echo $SESSION_RESPONSE | jq -r '.id')
echo "Session created: $SESSION_ID"
```

### Step 2: Geocode Places
Test geocoding for Italian cities (Genoa and Pisa):

```powershell
$body = @{
    sessionId = $sessionId
    places = @("Genoa", "Pisa")
} | ConvertTo-Json

$geocodeResponse = Invoke-RestMethod `
    -Uri "http://localhost:3001/api/geography/geocode" `
    -Method POST `
    -Body $body `
    -ContentType "application/json"

Write-Host "Geocoding results:"
$geocodeResponse.results | ForEach-Object {
    Write-Host "  $($_.place): $($_.displayName) ($($_.lat), $($_.lon)) [source: $($_.source)]"
}
```

Or with curl:
```bash
curl -X POST http://localhost:3001/api/geography/geocode \
  -H "Content-Type: application/json" \
  -d "{
    \"sessionId\": \"$SESSION_ID\",
    \"places\": [\"Genoa\", \"Pisa\"]
  }" | jq .
```

**Expected Results:**
- **Genoa**: Should return "Genova Piazza Principe" (or similar station) with coordinates around (44.407, 8.934)
- **Pisa**: Should return "Pisa Centrale" with coordinates around (43.708, 10.398)
- **Source**: Should be "railway_station" (preferred) or "admin_boundary" (fallback)

### Step 3: Query Railway Sections
Create bounding boxes between geocoded points and search for railway sections:

```powershell
# Define bounding boxes (example: Genoa-Pisa corridor)
$body = @{
    sessionId = $sessionId
    bboxes = @(
        @{
            minLat = 44.35
            minLon = 8.85
            maxLat = 44.42
            maxLon = 8.95
        },
        @{
            minLat = 43.68
            minLon = 10.35
            maxLat = 43.75
            maxLon = 10.45
        }
    )
} | ConvertTo-Json -Depth 10

$sectionsResponse = Invoke-RestMethod `
    -Uri "http://localhost:3001/api/geography/sections" `
    -Method POST `
    -Body $body `
    -ContentType "application/json"

Write-Host "`nRailway sections found: $($sectionsResponse.sections.Count)"
$sectionsResponse.sections | ForEach-Object {
    Write-Host "  - $($_.name) (OSM $($_.osmType) $($_.osmId))"
    if ($_.altOsmId) {
        Write-Host "    Alt OSM ID: $($_.altOsmId) (bidirectional duplicate)"
    }
}
```

Or with curl:
```bash
curl -X POST http://localhost:3001/api/geography/sections \
  -H "Content-Type: application/json" \
  -d "{
    \"sessionId\": \"$SESSION_ID\",
    \"bboxes\": [
      {\"minLat\": 44.35, \"minLon\": 8.85, \"maxLat\": 44.42, \"maxLon\": 8.95},
      {\"minLat\": 43.68, \"minLon\": 10.35, \"maxLat\": 43.75, \"maxLon\": 10.45}
    ]
  }" | jq .
```

**Expected Results:**
- Should return railway route relations (type: "railway" or "train")
- May include multiple sections with names like "Genova - Pisa", "Pontremolese", etc.
- Bidirectional routes should be deduplicated (e.g., "Genova - Pisa" ↔ "Pisa - Genova" → single entry with altOsmId)

### Step 4: Confirm Selected Sections
Select sections for geometry generation:

```powershell
$body = @{
    sessionId = $sessionId
    selectedSections = @(
        @{
            osmId = "12345"  # Replace with actual OSM ID from Step 3 results
            osmType = "relation"
        }
    )
} | ConvertTo-Json -Depth 10

$confirmResponse = Invoke-RestMethod `
    -Uri "http://localhost:3001/api/geography/confirm" `
    -Method POST `
    -Body $body `
    -ContentType "application/json"

Write-Host "`n$($confirmResponse.message)"
```

Or with curl:
```bash
curl -X POST http://localhost:3001/api/geography/confirm \
  -H "Content-Type: application/json" \
  -d "{
    \"sessionId\": \"$SESSION_ID\",
    \"selectedSections\": [
      {\"osmId\": \"12345\", \"osmType\": \"relation\"}
    ]
  }" | jq .
```

**Expected Results:**
- Confirmation message: "N sections confirmed. Ready for geometry generation."
- Session metadata updated with confirmed sections

### Step 5: Verify Session Metadata
Check that geography data is stored in session:

```powershell
$sessionInfo = Invoke-RestMethod -Uri "http://localhost:3001/api/sessions/$sessionId"
Write-Host "`nSession metadata:"
Write-Host "  - Geocoded places: $($sessionInfo.metadata.geocodedPlaces.Count)"
Write-Host "  - Candidate sections: $($sessionInfo.metadata.candidateSections.Count)"
Write-Host "  - Confirmed sections: $($sessionInfo.metadata.confirmedSections.Count)"
```

Or with curl:
```bash
curl http://localhost:3001/api/sessions/$SESSION_ID | jq '.metadata'
```

## Real-World Test Cases

### Test Case 1: Genoa-Pisa Route
```powershell
# Geocode
$body = @{
    sessionId = $sessionId
    places = @("Genova", "Pisa")
} | ConvertTo-Json

Invoke-RestMethod -Uri "http://localhost:3001/api/geography/geocode" `
    -Method POST -Body $body -ContentType "application/json"

# Expected: Genova Piazza Principe (44.407, 8.934), Pisa Centrale (43.708, 10.398)
```

### Test Case 2: Lucca-Viareggio Route (Bidirectional Deduplication Test)
```powershell
# Create bbox around Lucca-Viareggio
$body = @{
    sessionId = $sessionId
    bboxes = @(
        @{ minLat = 43.80; minLon = 10.48; maxLat = 43.88; maxLon = 10.52 },  # Lucca
        @{ minLat = 43.84; minLon = 10.22; maxLat = 43.88; maxLon = 10.28 }   # Viareggio
    )
} | ConvertTo-Json -Depth 10

$sections = Invoke-RestMethod -Uri "http://localhost:3001/api/geography/sections" `
    -Method POST -Body $body -ContentType "application/json"

# Expected: "Lucca – Viareggio" (normalized, deduplicated)
# Should have altOsmId if both directions exist in OSM
```

### Test Case 3: Complex Multi-City Route
```powershell
$body = @{
    sessionId = $sessionId
    places = @("Roma", "Firenze", "Bologna", "Milano")
} | ConvertTo-Json

Invoke-RestMethod -Uri "http://localhost:3001/api/geography/geocode" `
    -Method POST -Body $body -ContentType "application/json"

# Expected: All major stations (Roma Termini, Firenze SMN, Bologna Centrale, Milano Centrale)
```

## Debugging Tips

### Enable Verbose Logging
Check the backend console output for detailed logs:
- `[Geocoding]` prefix for geocoding operations
- `[Railway Sections]` prefix for section discovery
- `[Geography API]` prefix for API endpoint calls

### Common Issues

**Issue: "Could not geocode place"**
- Check spelling of place name
- Try alternative spellings (e.g., "Genoa" vs "Genova")
- Verify OSM has admin boundary data for the region

**Issue: "No railway sections found"**
- Verify bounding boxes cover the route corridor
- Expand bbox size (±0.1 degrees ~ 11km)
- Check OSM for railway=* tags in the area

**Issue: "Session not found"**
- Verify session hasn't expired (24-hour default)
- Check sessionId is correct UUID format
- Ensure session was created successfully

**Issue: IPv6 connection hangs (Windows)**
- ipv4fetch.js automatically handles this
- If issues persist, check DNS resolution: `Resolve-DnsName overpass-api.de`
- Verify firewall allows outbound IPv4 connections

## Validation Checklist

- [ ] Session creation returns valid UUID
- [ ] Geocoding returns lat/lon coordinates
- [ ] Geocoding prefers railway stations over admin boundaries
- [ ] Railway sections query returns OSM relations
- [ ] Bidirectional routes are deduplicated (check for altOsmId)
- [ ] Session metadata is updated after each operation
- [ ] Error handling works (invalid sessionId, missing parameters)
- [ ] IPv4 fetch works reliably (no timeouts)

## Next Steps

After confirming geography endpoints work:
1. Test geometry generation (Phase 2, next milestone)
2. Test infrastructure generation (Phase 2, future)
3. Integrate with frontend UI (Phase 2, future)
4. Test end-to-end workflow (geocode → sections → geometry → infrastructure)

## Cleanup
```powershell
# Delete test session
Invoke-RestMethod -Uri "http://localhost:3001/api/sessions/$sessionId" -Method DELETE
```
