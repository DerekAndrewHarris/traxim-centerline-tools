/**
 * Temporary File Management
 * Handles session creation, retrieval, and cleanup for the Traxim File Generator
 */

import { randomUUID } from 'crypto';
import fs from 'fs/promises';
import fsSync from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration — store outside the workspace so Live Server doesn't trigger reloads
const TEMP_FILES_DIR = process.env.TEMP_FILES_DIR || path.join(os.tmpdir(), 'traxim-temp-sessions');
const SESSION_EXPIRY_HOURS = parseInt(process.env.SESSION_EXPIRY_HOURS || '24', 10);

// Session ids are always crypto.randomUUID() values. Anything else (for
// example '..', which path.join would turn into the parent folder) is
// treated as "no such session" everywhere, before any path is built from it.
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * True if the value has the shape of a session id (a lower-case UUID).
 * @param {unknown} sessionId
 * @returns {boolean}
 */
export function isValidSessionId(sessionId) {
  return typeof sessionId === 'string' && SESSION_ID_PATTERN.test(sessionId);
}

/**
 * Absolute folder of a session. Throws for anything that is not a session id.
 * @param {string} sessionId
 * @returns {string}
 */
function sessionDir(sessionId) {
  if (!isValidSessionId(sessionId)) {
    throw new Error('Invalid session id');
  }
  return path.join(TEMP_FILES_DIR, sessionId);
}

/**
 * Create a new temporary session
 * @returns {Promise<{id: string, path: string, createdAt: Date, expiresAt: Date}>}
 */
export async function createSession(extraMetadata = null) {
  const sessionId = randomUUID();
  const sessionPath = path.join(TEMP_FILES_DIR, sessionId);
  
  // Create session directory structure
  await fs.mkdir(sessionPath, { recursive: true });
  await fs.mkdir(path.join(sessionPath, 'geometry'), { recursive: true });
  await fs.mkdir(path.join(sessionPath, 'centerline-conversions'), { recursive: true });
  
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + SESSION_EXPIRY_HOURS * 60 * 60 * 1000);
  
  // Write session metadata
  // extraMetadata is only used by the agent routes (it holds the 'agent'
  // block with the owner). Sessions created by the website have none.
  const sessionInfo = {
    id: sessionId,
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    files: [],
    ...(extraMetadata || {})
  };
  
  await fs.writeFile(
    path.join(sessionPath, 'session.json'),
    JSON.stringify(sessionInfo, null, 2)
  );
  
  console.log(`[Session] Created: ${sessionId} (expires ${expiresAt.toISOString()})`);
  
  return {
    id: sessionId,
    path: sessionPath,
    createdAt,
    expiresAt
  };
}

/**
 * Get session information
 * @param {string} sessionId 
 * @returns {Promise<{id: string, path: string, exists: boolean, createdAt?: Date, expiresAt?: Date, files?: string[]}>}
 */
export async function getSession(sessionId) {
  if (!isValidSessionId(sessionId)) {
    return { id: String(sessionId), path: null, exists: false };
  }
  const sessionPath = path.join(TEMP_FILES_DIR, sessionId);

  try {
    await fs.access(sessionPath);
    
    // Read session metadata
    const sessionInfoPath = path.join(sessionPath, 'session.json');
    const sessionData = await fs.readFile(sessionInfoPath, 'utf-8');
    const sessionInfo = JSON.parse(sessionData);
    
    // List files in session
    const files = await listSessionFiles(sessionPath);
    
    return {
      id: sessionId,
      path: sessionPath,
      exists: true,
      createdAt: new Date(sessionInfo.createdAt),
      expiresAt: new Date(sessionInfo.expiresAt),
      files
    };
  } catch (error) {
    return {
      id: sessionId,
      path: sessionPath,
      exists: false
    };
  }
}

/**
 * List all files in a session (recursively)
 * @param {string} sessionPath 
 * @returns {Promise<string[]>}
 */
async function listSessionFiles(sessionPath) {
  const files = [];
  
  async function scan(dir, relative = '') {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    
    for (const entry of entries) {
      const relativePath = path.join(relative, entry.name);
      
      if (entry.isDirectory()) {
        await scan(path.join(dir, entry.name), relativePath);
      } else if (entry.name !== 'session.json') {
        files.push(relativePath);
      }
    }
  }
  
  await scan(sessionPath);
  return files;
}

/**
 * Delete a session and all its files
 * @param {string} sessionId 
 * @returns {Promise<boolean>} True if deleted, false if not found
 */
export async function deleteSession(sessionId) {
  if (!isValidSessionId(sessionId)) {
    return false;
  }
  const sessionPath = path.join(TEMP_FILES_DIR, sessionId);

  try {
    // fs.rm with force:true does not fail on a missing folder, so check first
    // (otherwise deleting an unknown id reported success).
    await fs.access(sessionPath);
    await fs.rm(sessionPath, { recursive: true, force: true });
    console.log(`[Session] Deleted: ${sessionId}`);
    return true;
  } catch (error) {
    console.error(`[Session] Error deleting ${sessionId}:`, error.message);
    return false;
  }
}

/**
 * Clean up expired sessions (runs as cron job)
 * @returns {Promise<{deleted: number, errors: number}>}
 */
export async function cleanupOldSessions() {
  console.log('[Cleanup] Starting session cleanup...');
  
  let deleted = 0;
  let errors = 0;
  
  try {
    // Ensure temp directory exists
    await fs.mkdir(TEMP_FILES_DIR, { recursive: true });
    
    const entries = await fs.readdir(TEMP_FILES_DIR, { withFileTypes: true });
    const now = new Date();
    
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      
      const sessionId = entry.name;
      const sessionPath = path.join(TEMP_FILES_DIR, entry.name);
      const sessionInfoPath = path.join(sessionPath, 'session.json');
      
      try {
        // Read session metadata
        const sessionData = await fs.readFile(sessionInfoPath, 'utf-8');
        const sessionInfo = JSON.parse(sessionData);
        const expiresAt = new Date(sessionInfo.expiresAt);
        
        // Delete if expired
        if (expiresAt < now) {
          await fs.rm(sessionPath, { recursive: true, force: true });
          console.log(`[Cleanup] Deleted expired session: ${sessionId} (expired ${expiresAt.toISOString()})`);
          deleted++;
        }
      } catch (error) {
        console.error(`[Cleanup] Error processing ${sessionId}:`, error.message);
        errors++;
      }
    }
    
    console.log(`[Cleanup] Complete. Deleted: ${deleted}, Errors: ${errors}`);
  } catch (error) {
    console.error('[Cleanup] Fatal error:', error.message);
    errors++;
  }
  
  return { deleted, errors };
}

/**
 * Get file path within session (with validation)
 * @param {string} sessionId 
 * @param {string} filename 
 * @returns {string} Absolute path to file
 * @throws {Error} If path traversal detected
 */
export function getSessionFilePath(sessionId, filename) {
  const sessionPath = sessionDir(sessionId);
  const filePath = path.join(sessionPath, filename);

  // Prevent path traversal attacks (path.relative, so a sibling folder whose
  // name merely starts with the session id is not treated as inside it)
  const relative = path.relative(sessionPath, filePath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Invalid file path');
  }

  return filePath;
}

/**
 * Read a session's session.json synchronously, or null if the session does
 * not exist (or the id is not a session id).
 * @param {string} sessionId
 * @returns {object|null}
 */
export function readSessionMetadataSync(sessionId) {
  if (!isValidSessionId(sessionId)) return null;
  try {
    return JSON.parse(fsSync.readFileSync(path.join(TEMP_FILES_DIR, sessionId, 'session.json'), 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Change a session's 'agent' block (owner, confirmation, generation state).
 * Synchronous read-change-write, so no other request can interleave with it.
 * Only the 'agent' key is rewritten from the fresh file; other keys are kept
 * exactly as they are on disk.
 * @param {string} sessionId
 * @param {(agent: object, meta: object) => void} change - edits 'agent' in place
 * @returns {object} the updated agent block
 */
export function updateAgentMetadataSync(sessionId, change) {
  const file = path.join(sessionDir(sessionId), 'session.json');
  const meta = JSON.parse(fsSync.readFileSync(file, 'utf-8'));
  const agent = meta.agent || {};
  change(agent, meta);
  meta.agent = agent;
  meta.lastUpdated = new Date().toISOString();
  fsSync.writeFileSync(file, JSON.stringify(meta, null, 2));
  return agent;
}

/**
 * Ids of every session folder currently on disk (valid ids only).
 * @returns {string[]}
 */
export function listSessionIdsSync() {
  try {
    return fsSync.readdirSync(TEMP_FILES_DIR, { withFileTypes: true })
      .filter(e => e.isDirectory() && isValidSessionId(e.name))
      .map(e => e.name);
  } catch {
    return [];
  }
}

/**
 * Update session metadata
 * @param {string} sessionId 
 * @param {object} updates - Key-value pairs to merge into session metadata
 * @returns {Promise<void>}
 */
export async function updateSessionMetadata(sessionId, updates) {
  const sessionPath = sessionDir(sessionId);
  const sessionInfoPath = path.join(sessionPath, 'session.json');
  
  try {
    // Read existing session data
    const sessionData = await fs.readFile(sessionInfoPath, 'utf-8');
    const sessionInfo = JSON.parse(sessionData);
    
    // Merge updates
    const updatedInfo = {
      ...sessionInfo,
      ...updates,
      lastUpdated: new Date().toISOString()
    };
    
    // Write back
    await fs.writeFile(sessionInfoPath, JSON.stringify(updatedInfo, null, 2));
    
    console.log(`[Session] Updated metadata for ${sessionId}:`, Object.keys(updates));
  } catch (error) {
    console.error(`[Session] Error updating metadata for ${sessionId}:`, error.message);
    throw error;
  }
}

/**
 * Get the temp files directory path
 * @returns {string}
 */
export function getTempFilesDir() {
  return TEMP_FILES_DIR;
}
