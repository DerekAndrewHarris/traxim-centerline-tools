#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Test script for Traxim File Generator Geography API endpoints
.DESCRIPTION
    Tests geocoding and railway section discovery endpoints with real-world examples
.PARAMETER BaseUrl
    Base URL of the API server (default: http://localhost:3001)
.PARAMETER Places
    Array of place names to geocode (default: Genoa, Pisa)
.EXAMPLE
    .\test-geography-api.ps1
.EXAMPLE
    .\test-geography-api.ps1 -BaseUrl "http://localhost:3000" -Places @("Roma", "Milano")
#>

param(
    [string]$BaseUrl = "http://localhost:3001",
    [string[]]$Places = @("Genoa", "Pisa")
)

# Color output functions
function Write-Success { param($Message) Write-Host "✓ $Message" -ForegroundColor Green }
function Write-Error { param($Message) Write-Host "✗ $Message" -ForegroundColor Red }
function Write-Info { param($Message) Write-Host "ℹ $Message" -ForegroundColor Cyan }
function Write-Step { param($Message) Write-Host "`n▶ $Message" -ForegroundColor Yellow }

# Test configuration
$ApiBase = "$BaseUrl/api"
$ErrorActionPreference = "Stop"

Write-Host "`n═══════════════════════════════════════════════════════" -ForegroundColor Magenta
Write-Host "  Traxim File Generator - Geography API Test Suite" -ForegroundColor Magenta
Write-Host "═══════════════════════════════════════════════════════`n" -ForegroundColor Magenta

Write-Info "API Base URL: $ApiBase"
Write-Info "Testing with places: $($Places -join ', ')"

# Error tracking
$TestsPassed = 0
$TestsFailed = 0
$SessionId = $null

try {
    # Test 1: Health Check
    Write-Step "Test 1: Health Check"
    try {
        $health = Invoke-RestMethod -Uri "$ApiBase/health" -Method GET -TimeoutSec 5
        if ($health.success -and $health.service -eq "Traxim File Generator API") {
            Write-Success "Server is operational"
            Write-Info "  Service: $($health.service)"
            Write-Info "  Version: $($health.version)"
            Write-Info "  Status: $($health.status)"
            $TestsPassed++
        } else {
            throw "Unexpected health check response"
        }
    } catch {
        Write-Error "Health check failed: $_"
        $TestsFailed++
        exit 1
    }

    # Test 2: Create Session
    Write-Step "Test 2: Create Session"
    try {
        $sessionResponse = Invoke-RestMethod -Uri "$ApiBase/sessions" -Method POST -TimeoutSec 5
        $SessionId = $sessionResponse.session.id
        
        if ($SessionId -and $SessionId -match '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') {
            Write-Success "Session created"
            Write-Info "  Session ID: $SessionId"
            Write-Info "  Expires: $($sessionResponse.session.expiresAt)"
            $TestsPassed++
        } else {
            throw "Invalid session ID format"
        }
    } catch {
        Write-Error "Session creation failed: $_"
        $TestsFailed++
        exit 1
    }

    # Test 3: Geocode Places
    Write-Step "Test 3: Geocode Places ($($Places -join ', '))"
    try {
        $geocodeBody = @{
            sessionId = $SessionId
            places = $Places
        } | ConvertTo-Json

        $geocodeResponse = Invoke-RestMethod `
            -Uri "$ApiBase/geography/geocode" `
            -Method POST `
            -Body $geocodeBody `
            -ContentType "application/json" `
            -TimeoutSec 30

        if ($geocodeResponse.results -and $geocodeResponse.results.Count -eq $Places.Count) {
            Write-Success "Geocoded $($geocodeResponse.results.Count) places"
            
            foreach ($result in $geocodeResponse.results) {
                if ($result.error) {
                    Write-Error "  $($result.place): $($result.error)"
                } else {
                    Write-Info "  $($result.place):"
                    Write-Host "    Location: $($result.displayName)" -ForegroundColor White
                    Write-Host "    Coordinates: $($result.lat), $($result.lon)" -ForegroundColor White
                    Write-Host "    Source: $($result.source)" -ForegroundColor White
                    if ($result.stationName) {
                        Write-Host "    Station: $($result.stationName)" -ForegroundColor White
                    }
                    if ($result.centerSource) {
                        Write-Host "    Center: $($result.centerSource)" -ForegroundColor White
                    }
                }
            }
            $TestsPassed++
            
            # Save geocoded results for bbox generation
            $global:GeocodedResults = $geocodeResponse.results
        } else {
            throw "Unexpected geocoding response"
        }
    } catch {
        Write-Error "Geocoding failed: $_"
        $TestsFailed++
    }

    # Test 4: Query Railway Sections
    Write-Step "Test 4: Query Railway Sections"
    
    if ($global:GeocodedResults) {
        try {
            # Generate bounding boxes around geocoded points (±0.05 degrees ~ 5.5km)
            $bboxes = @()
            foreach ($result in $global:GeocodedResults | Where-Object { $_.lat -and $_.lon }) {
                $bboxes += @{
                    minLat = [math]::Round($result.lat - 0.05, 4)
                    minLon = [math]::Round($result.lon - 0.05, 4)
                    maxLat = [math]::Round($result.lat + 0.05, 4)
                    maxLon = [math]::Round($result.lon + 0.05, 4)
                }
            }

            Write-Info "  Generated $($bboxes.Count) bounding boxes"

            $sectionsBody = @{
                sessionId = $SessionId
                bboxes = $bboxes
            } | ConvertTo-Json -Depth 10

            $sectionsResponse = Invoke-RestMethod `
                -Uri "$ApiBase/geography/sections" `
                -Method POST `
                -Body $sectionsBody `
                -ContentType "application/json" `
                -TimeoutSec 60

            if ($sectionsResponse.sections) {
                Write-Success "Found $($sectionsResponse.sections.Count) railway sections"
                
                $global:FoundSections = $sectionsResponse.sections
                
                if ($sectionsResponse.sections.Count -gt 0) {
                    Write-Info "`n  Railway Sections:"
                    foreach ($section in $sectionsResponse.sections | Select-Object -First 10) {
                        Write-Host "    • $($section.name)" -ForegroundColor White
                        Write-Host "      OSM: $($section.osmType) $($section.osmId)" -ForegroundColor DarkGray
                        if ($section.operator) {
                            Write-Host "      Operator: $($section.operator)" -ForegroundColor DarkGray
                        }
                        Write-Host "      Type: $($section.type)" -ForegroundColor DarkGray
                        Write-Host "      Ways: $($section.wayIds.Count)" -ForegroundColor DarkGray
                        if ($section.altOsmId) {
                            Write-Host "      Alt OSM ID: $($section.altOsmId) (bidirectional)" -ForegroundColor DarkGray
                        }
                    }
                    
                    if ($sectionsResponse.sections.Count -gt 10) {
                        Write-Info "  ... and $($sectionsResponse.sections.Count - 10) more sections"
                    }
                } else {
                    Write-Info "  No sections found (this may be expected for some regions)"
                }
                
                $TestsPassed++
            } else {
                throw "Unexpected sections response"
            }
        } catch {
            Write-Error "Railway sections query failed: $_"
            Write-Info "  This may be due to network timeouts with Overpass API"
            $TestsFailed++
        }
    } else {
        Write-Error "Skipping sections test (no geocoded results)"
        $TestsFailed++
    }

    # Test 5: Confirm Selected Sections
    Write-Step "Test 5: Confirm Selected Sections"
    
    if ($global:FoundSections -and $global:FoundSections.Count -gt 0) {
        try {
            # Select first section (or all if few)
            $selectedSections = @()
            $selectCount = [Math]::Min(3, $global:FoundSections.Count)
            
            for ($i = 0; $i -lt $selectCount; $i++) {
                $selectedSections += @{
                    osmId = $global:FoundSections[$i].osmId
                    osmType = $global:FoundSections[$i].osmType
                }
            }

            $confirmBody = @{
                sessionId = $SessionId
                selectedSections = $selectedSections
            } | ConvertTo-Json -Depth 10

            $confirmResponse = Invoke-RestMethod `
                -Uri "$ApiBase/geography/confirm" `
                -Method POST `
                -Body $confirmBody `
                -ContentType "application/json" `
                -TimeoutSec 10

            if ($confirmResponse.confirmedSections) {
                Write-Success "Confirmed $($confirmResponse.confirmedSections.Count) sections"
                Write-Info "  $($confirmResponse.message)"
                $TestsPassed++
            } else {
                throw "Unexpected confirmation response"
            }
        } catch {
            Write-Error "Section confirmation failed: $_"
            $TestsFailed++
        }
    } else {
        Write-Info "Skipping confirmation test (no sections found)"
    }

    # Test 6: Verify Session Metadata
    Write-Step "Test 6: Verify Session Metadata"
    try {
        $sessionInfo = Invoke-RestMethod -Uri "$ApiBase/sessions/$SessionId" -Method GET -TimeoutSec 5
        
        if ($sessionInfo.session.metadata) {
            $metadata = $sessionInfo.session.metadata
            Write-Success "Session metadata updated"
            
            if ($metadata.geocodedPlaces) {
                Write-Info "  Geocoded places stored: $($metadata.geocodedPlaces.Count)"
            }
            if ($metadata.candidateSections) {
                Write-Info "  Candidate sections stored: $($metadata.candidateSections.Count)"
            }
            if ($metadata.confirmedSections) {
                Write-Info "  Confirmed sections stored: $($metadata.confirmedSections.Count)"
            }
            if ($metadata.lastGeocodeTimestamp) {
                Write-Info "  Last geocode: $($metadata.lastGeocodeTimestamp)"
            }
            
            $TestsPassed++
        } else {
            throw "No metadata found in session"
        }
    } catch {
        Write-Error "Metadata verification failed: $_"
        $TestsFailed++
    }

} catch {
    Write-Error "Unexpected error: $_"
    $TestsFailed++
} finally {
    # Cleanup: Delete session
    if ($SessionId) {
        Write-Step "Cleanup: Deleting Test Session"
        try {
            Invoke-RestMethod -Uri "$ApiBase/sessions/$SessionId" -Method DELETE -TimeoutSec 5 | Out-Null
            Write-Success "Session deleted: $SessionId"
        } catch {
            Write-Error "Failed to delete session: $_"
        }
    }
}

# Test Summary
Write-Host "`n═══════════════════════════════════════════════════════" -ForegroundColor Magenta
Write-Host "  Test Summary" -ForegroundColor Magenta
Write-Host "═══════════════════════════════════════════════════════`n" -ForegroundColor Magenta

$TotalTests = $TestsPassed + $TestsFailed
$PassRate = if ($TotalTests -gt 0) { [math]::Round(($TestsPassed / $TotalTests) * 100, 1) } else { 0 }

Write-Host "Total Tests: $TotalTests" -ForegroundColor White
Write-Host "Passed: $TestsPassed" -ForegroundColor Green
Write-Host "Failed: $TestsFailed" -ForegroundColor $(if ($TestsFailed -eq 0) { "Green" } else { "Red" })
Write-Host "Pass Rate: $PassRate%" -ForegroundColor $(if ($PassRate -eq 100) { "Green" } elseif ($PassRate -ge 75) { "Yellow" } else { "Red" })

Write-Host ""

if ($TestsFailed -eq 0) {
    Write-Success "All tests passed! Geography API is working correctly."
    exit 0
} else {
    Write-Error "Some tests failed. Please review the errors above."
    exit 1
}
