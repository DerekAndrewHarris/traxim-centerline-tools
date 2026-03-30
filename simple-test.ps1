# Simple Geography API Test
$ErrorActionPreference = "Continue"

Write-Host "`n=== Geography API Test ===`n"

# Create session
Write-Host "Creating session..."
$session = Invoke-RestMethod -Uri "http://localhost:3001/api/file-generator/sessions" -Method POST
$sessionId = $session.session.id
Write-Host "Session ID: $sessionId`n"

# Geocode
Write-Host "Geocoding 'Genoa'..."
$body = @{
    sessionId = $sessionId
    places = @("Genoa")
} | ConvertTo-Json

try {
    $result = Invoke-RestMethod `
        -Uri "http://localhost:3001/api/file-generator/geography/geocode" `
        -Method POST `
        -Body $body `
        -ContentType "application/json" `
        -TimeoutSec 30
    
    Write-Host "`nSuccess!" -ForegroundColor Green
    Write-Host "`nResults:"
    $result.results | ForEach-Object {
        Write-Host "  Place: $($_.place)"
        Write-Host "  Display Name: $($_.displayName)"
       Write-Host "  Coordinates: $($_.lat), $($_.lon)"
        Write-Host "  Source: $($_source)"
        if ($_.stationName) {
            Write-Host "  Station: $($_.stationName)"
        }
        Write-Host ""
    }
} catch {
    Write-Host "`nError occurred:" -ForegroundColor Red
    Write-Host $_.Exception.Message
    if ($_.ErrorDetails.Message) {
        Write-Host "Details: $($_.ErrorDetails.Message)"
    }
}

# Cleanup
Write-Host "Cleaning up..."
Invoke-RestMethod -Uri "http://localhost:3001/api/file-generator/sessions/$sessionId" -Method DELETE | Out-Null
Write-Host "Done!"
