# Integration Guide: File Generator Backend → Traxim Controller

## Overview

This guide explains how to integrate the file generator backend routes into the existing `Traxim-Live-Control-Interface-for-Web/server.js`.

## Prerequisites

1. Both repositories cloned in the same parent directory:
   ```
   DerekAndrewHarris/
   ├── traxim-centerline-tools/
   └── Traxim-Live-Control-Interface-for-Web/
   ```

2. Dependencies installed in traxim-centerline-tools:
   ```bash
   cd traxim-centerline-tools
   npm install
   ```

## Integration Steps

### 1. Install Additional Dependencies in Traxim Controller

```bash
cd ../Traxim-Live-Control-Interface-for-Web
npm install archiver node-cron
```

### 2. Modify server.js

Add these imports near the top of `Traxim-Live-Control-Interface-for-Web/server.js`:

```javascript
// ADD: File generator imports
import path from 'path';
import { fileURLToPath } from 'url';
import cron from 'node-cron';
import fileGeneratorRoutes from '../traxim-centerline-tools/backend/routes/index.js';
import { cleanupOldSessions } from '../traxim-centerline-tools/backend/utils/tempFiles.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
```

### 3. Update CORS Configuration

Update the existing CORS config to allow file generator frontend:

```javascript
// MODIFY: Update allowedOrigins
const allowedOrigins = [
  'http://localhost:5173',                    // Dev
  'https://traximrail.com',                   // Main site
  'https://tools.traximrail.com',             // Tools domain (includes file generator)
  'https://www.traximrail.com'                // WWW variant
];

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (e.g., MCP, curl, Postman)
    if (!origin) return callback(null, true);
    
    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: false  // No credentials needed for file generator
}));
```

### 4. Mount File Generator Routes

Add after existing route registrations:

```javascript
// ADD: Mount file generator API routes
app.use('/api/file-generator', fileGeneratorRoutes);
```

### 5. Serve File Generator Frontend

Add static file serving for the file generator UI:

```javascript
// ADD: Serve file generator frontend
app.use('/file-generator', express.static(path.join(__dirname, '../traxim-centerline-tools')));
```

### 6. Add Cleanup Cron Job

Add before `app.listen()`:

```javascript
// ADD: Daily cleanup cron job (runs at 2 AM)
cron.schedule('0 2 * * *', async () => {
  console.log('[Cron] Running file generator session cleanup...');
  try {
    const result = await cleanupOldSessions();
    console.log(`[Cron] Cleanup complete. Deleted: ${result.deleted}, Errors: ${result.errors}`);
  } catch (error) {
    console.error('[Cron] Cleanup failed:', error);
  }
});
```

### 7. Update Startup Logging

Add to the endpoint list in startup logging:

```javascript
console.log('  POST   /api/file-generator/sessions');
console.log('  GET    /api/file-generator/sessions/:id');
console.log('  DELETE /api/file-generator/sessions/:id');
console.log('  GET    /api/file-generator/sessions/:id/download-all');
console.log('  GET    /api/file-generator/files/:sessionId/:filename');
```

### 8. Update .env

Add to `Traxim-Live-Control-Interface-for-Web/.env`:

```bash
# File Generator Configuration
TEMP_FILES_DIR=/var/traxim-temp-files
SESSION_EXPIRY_HOURS=24
OVERPASS_API_URL=https://overpass-api.de/api/interpreter
ELEVATION_API_URL=https://api.open-elevation.com/api/v1/lookup
OSM_NOMINATIM_URL=https://nominatim.openstreetmap.org/search
```

## Create Temp Directory on Server

On the Hetzner server:

```bash
sudo mkdir -p /var/traxim-temp-files
sudo chown your-user:your-group /var/traxim-temp-files
sudo chmod 755 /var/traxim-temp-files
```

## Nginx Configuration

Add to your existing `tools.traximrail.com` nginx config:

```nginx
# File Generator Frontend
location /file-generator {
    try_files $uri $uri/ /file-generator/index.html;
}

# File Generator API (already proxied by existing /api/ location)
```

## Testing Integration

### 1. Start Server

```bash
cd Traxim-Live-Control-Interface-for-Web
node server.js
```

### 2. Test Endpoints

```bash
# Health check
curl http://localhost:3000/api/file-generator/health

# Create session
curl -X POST http://localhost:3000/api/file-generator/sessions

# Access frontend
open http://localhost:3000/file-generator/
```

## Complete server.js Diff Summary

**Lines to ADD:** ~40 lines
**Lines to MODIFY:** ~5 lines (CORS config)
**Breaking changes:** None (all additions, no modifications to existing functionality)

**Modified sections:**
1. Imports (add 5 lines)
2. CORS config (modify allowedOrigins array)
3. Route registration (add 1 line)
4. Static files (add 1 line)
5. Cron job (add 8 lines)
6. Startup logging (add 5 lines)

## Rollback Plan

If issues arise:
1. Comment out the added lines
2. Restart server
3. File generator won't be available, but existing functionality unaffected

## Next Steps After Integration

1. Deploy to Hetzner
2. Test session creation/deletion
3. Verify cron job runs (check logs next day)
4. Begin Phase 2: OSM services implementation

## Troubleshooting

**Import error:**
- Verify relative paths are correct
- Check both repos are in same parent directory

**CORS error:**
- Verify `tools.traximrail.com` is in allowedOrigins
- Check frontend is served from correct domain

**Session files not cleaning up:**
- Check cron job is registered (should see startup log)
- Verify TEMP_FILES_DIR path is correct
- Check directory permissions

**404 on /file-generator:**
- Verify static file serving is configured
- Check path to traxim-centerline-tools is correct
