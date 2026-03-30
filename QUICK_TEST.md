# Quick Test Guide - Phase 1

Test the backend infrastructure you just built!

## Setup (First Time Only)

```powershell
# Navigate to project
cd c:\Users\derek\source\repos\DerekAndrewHarris\traxim-centerline-tools

# Install dependencies
npm install

# Create .env file (optional - defaults will work)
copy .env.example .env
```

## Start the Server

```powershell
npm run dev
```

You should see:
```
╔════════════════════════════════════════════════════════════╗
║     Traxim File Generator API Server (Development)        ║
╚════════════════════════════════════════════════════════════╝
🚀 Server running on: http://localhost:3001
📁 Frontend available: http://localhost:3001/index.html
🔌 API endpoint: http://localhost:3001/api/file-generator
```

## Test the API

Open a **new PowerShell window** and run these tests:

### 1. Health Check
```powershell
curl http://localhost:3001/api/file-generator/health
```

**Expected:** `{"success":true,"service":"Traxim File Generator API","version":"1.0.0","status":"operational",...}`

### 2. Create Session
```powershell
$response = curl -Method POST http://localhost:3001/api/file-generator/sessions | ConvertFrom-Json
$sessionId = $response.session.id
Write-Host "Created session: $sessionId"
```

**Expected:** Session ID like `a1b2c3d4-e5f6-...`

### 3. Get Session Info
```powershell
curl "http://localhost:3001/api/file-generator/sessions/$sessionId"
```

**Expected:** `{"success":true,"session":{"id":"...","createdAt":"...","expiresAt":"...","files":[]}}`

### 4. Delete Session
```powershell
curl -Method DELETE "http://localhost:3001/api/file-generator/sessions/$sessionId"
```

**Expected:** No output (204 status)

## Test the Frontend

1. Open browser to: `http://localhost:3001/index.html`
2. You should see the existing centerline tools UI
3. Test KML→CSV or CSV→KML conversion (original functionality)

## Verify File Structure

```powershell
# Check temp directory was created
Test-Path .\temp-sessions
# Should return: True (after creating first session)

# List backend files
Get-ChildItem -Recurse backend\

# Expected:
# backend\server.js
# backend\routes\index.js
# backend\routes\sessions.js
# backend\utils\tempFiles.js
# backend\utils\zipGenerator.js
# backend\utils\jobQueue.js
# backend\utils\errorHandler.js
```

## Common Issues

**"npm: command not found"**
- Install Node.js from https://nodejs.org/

**"Port 3001 already in use"**
```powershell
# Change port in .env or:
$env:PORT="3002"; npm run dev
```

**"Cannot find module"**
```powershell
# Reinstall dependencies
rm -r node_modules
npm install
```

## Success Criteria

✅ Server starts without errors
✅ Health check returns success
✅ Can create session
✅ Can get session info
✅ Can delete session
✅ Frontend loads at /index.html
✅ temp-sessions/ directory created

## Next Steps

Once all tests pass:
1. Commit your work:
   ```powershell
   git add .
   git commit -m "Phase 1: Backend infrastructure complete"
   ```

2. Ready to start Phase 2! (OSM services)

## Stop the Server

Press `Ctrl+C` in the terminal running the server.
