/**
 * ZIP Generation Utility
 * Creates downloadable ZIP archives from session files
 */

import archiver from 'archiver';
import fs from 'fs';
import path from 'path';

/**
 * Generate a ZIP file from all files in a session directory
 * @param {string} sessionPath - Absolute path to session directory
 * @param {string} outputPath - Absolute path where ZIP should be written
 * @returns {Promise<{success: boolean, filePath: string, fileCount: number, sizeBytes: number}>}
 */
export async function generateSessionZip(sessionPath, outputPath) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outputPath);
    const archive = archiver('zip', {
      zlib: { level: 9 } // Maximum compression
    });

    let fileCount = 0;

    // Track completion
    output.on('close', () => {
      const sizeBytes = archive.pointer();
      console.log(`[ZIP] Generated: ${path.basename(outputPath)} (${fileCount} files, ${Math.round(sizeBytes / 1024)} KB)`);
      resolve({
        success: true,
        filePath: outputPath,
        fileCount,
        sizeBytes
      });
    });

    // Handle errors
    archive.on('error', (err) => {
      console.error('[ZIP] Error:', err.message);
      reject(err);
    });

    archive.on('entry', (entry) => {
      fileCount++;
    });

    // Pipe archive data to the file
    archive.pipe(output);

    // Add all files except session.json
    archive.glob('**/*', {
      cwd: sessionPath,
      ignore: ['session.json']
    });

    // Finalize the archive
    archive.finalize();
  });
}

/**
 * Generate a ZIP file from specific files
 * @param {Array<{path: string, name: string}>} files - Array of {path: absolute path, name: name in zip}
 * @param {string} outputPath - Where to write the ZIP
 * @returns {Promise<{success: boolean, filePath: string, fileCount: number, sizeBytes: number}>}
 */
export async function generateCustomZip(files, outputPath) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outputPath);
    const archive = archiver('zip', {
      zlib: { level: 9 }
    });

    let fileCount = 0;

    output.on('close', () => {
      const sizeBytes = archive.pointer();
      console.log(`[ZIP] Generated custom archive: ${path.basename(outputPath)} (${fileCount} files, ${Math.round(sizeBytes / 1024)} KB)`);
      resolve({
        success: true,
        filePath: outputPath,
        fileCount,
        sizeBytes
      });
    });

    archive.on('error', (err) => {
      console.error('[ZIP] Error:', err.message);
      reject(err);
    });

    archive.on('entry', () => {
      fileCount++;
    });

    archive.pipe(output);

    // Add each file
    for (const file of files) {
      if (fs.existsSync(file.path)) {
        archive.file(file.path, { name: file.name });
      } else {
        console.warn(`[ZIP] File not found, skipping: ${file.path}`);
      }
    }

    archive.finalize();
  });
}
