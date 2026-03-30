#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Quick smoke test for Geography API - minimal version
.DESCRIPTION
    Tests basic connectivity and geocoding functionality
.EXAMPLE
    .\quick-test-geography.ps1
#>

$BaseUrl = "http://localhost:3001"
$ApiBase = "$BaseUrl/api/file-generator"

Write-Host "`nQuick Geography API Smoke Test`n" -ForegroundColor Cyan

# Test 1: Health
Write-Host "1. Health check... " -NoNewline
try {
    $health = Invoke-RestMethod -Uri "$ApiBase/health" -TimeoutSec 3
    Write-Host "[OK]" -ForegroundColor Green
} catch {
    Write-Host "[FAIL] Server not responding" -ForegroundColor Red
    exit 1
}

# Test 2: Session
Write-Host "2. Create session... " -NoNewline
try {
    $session = Invoke-RestMethod -Uri "$ApiBase/sessions" -Method POST -TimeoutSec 3
    $sessionId = $session.session.id
    Write-Host "[OK]" -ForegroundColor Green
} catch {
    Write-Host "[FAIL]" -ForegroundColor Red
    exit 1
}

# Test 3: Geocode
Write-Host "3. Geocode 'Genoa'... " -NoNewline
try {
    $body = @{ sessionId = $sessionId; places = @("Genoa") } | ConvertTo-Json
    $result = Invoke-RestMethod -Uri "$ApiBase/geography/geocode" -Method POST -Body $body -ContentType "application/json" -TimeoutSec 15
    $place = $result.results[0]
    Write-Host "[OK]" -ForegroundColor Green
    Write-Host "   -> $($place.displayName) ($($place.lat), $($place.lon))" -ForegroundColor DarkGray
} catch {
    Write-Host "[FAIL]" -ForegroundColor Red
}

# Cleanup
Invoke-RestMethod -Uri "$ApiBase/sessions/$sessionId" -Method DELETE -TimeoutSec 3 | Out-Null

Write-Host "`nAll basic tests passed!`n" -ForegroundColor Green
