/**
 * IPv4-only fetch wrapper for OSM API requests
 * 
 * WHY THIS IS NEEDED
 * On Windows, Node.js honours IPv6 first, which can cause connection hangs
 * on networks without IPv6 routing to European OSM servers. This wrapper
 * forces IPv4 connections by resolving DNS first and connecting to the IP directly.
 * 
 * Ported from: Traxim-MCP-Servers/traxim-input-creator-mcp/lib/ipv4fetch.js
 */

import https from 'https';
import dns from 'dns';
import { promisify } from 'util';

const dnsLookup = promisify(dns.lookup);

// DNS resolution cache (in-process)
const _dnsCache = new Map();

/**
 * Resolve hostname to IPv4 address with caching
 * @param {string} hostname 
 * @returns {Promise<string>} IPv4 address or original hostname on failure
 */
async function resolveIPv4(hostname) {
  if (_dnsCache.has(hostname)) {
    return _dnsCache.get(hostname);
  }
  
  try {
    // 2-second DNS timeout to prevent hangs
    const timeout = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('DNS timeout')), 2000)
    );
    
    const lookupPromise = dnsLookup(hostname, { family: 4 });
    const { address } = await Promise.race([lookupPromise, timeout]);
    
    _dnsCache.set(hostname, address);
    console.log(`[DNS] Resolved ${hostname} → ${address}`);
    return address;
  } catch (error) {
    console.warn(`[DNS] Failed to resolve ${hostname}: ${error.message}`);
    return hostname; // Fallback to original hostname
  }
}

/**
 * Fetch with forced IPv4 connection
 * @param {string} url 
 * @param {object} options - Same as fetch() options
 * @returns {Promise<{ok: boolean, status: number, json: () => Promise, text: () => Promise}>}
 */
export async function ipv4Fetch(url, options = {}) {
  const socketTimeoutMs = options.socketTimeout || 8000;
  
  // Start timeout timer immediately (includes DNS resolution time)
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => {
      reject(Object.assign(
        new Error(`ipv4Fetch timeout after ${socketTimeoutMs}ms`), 
        { code: 'ETIMEDOUT' }
      ));
    }, socketTimeoutMs);
  });
  
  const workPromise = (async () => {
    const parsed = new URL(url);
    
    // Resolve to IPv4 before connecting
    const ipv4Address = await resolveIPv4(parsed.hostname);
    
    // Normalize body to string
    let bodyStr = '';
    if (options.body instanceof URLSearchParams) {
      bodyStr = options.body.toString();
    } else if (typeof options.body === 'string') {
      bodyStr = options.body;
    } else if (options.body !== undefined && options.body !== null) {
      bodyStr = JSON.stringify(options.body);
    }
    
    const reqOptions = {
      hostname: ipv4Address,           // Connect to IP directly
      servername: parsed.hostname,     // TLS SNI with original hostname
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      method: options.method || (bodyStr ? 'POST' : 'GET'),
      headers: {
        Host: parsed.hostname,         // HTTP Host header must be original hostname
        ...(options.headers || {}),
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {})
      }
    };
    
    return new Promise((resolve, reject) => {
      const req = https.request(reqOptions, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            json: () => {
              try {
                return Promise.resolve(JSON.parse(data));
              } catch (e) {
                return Promise.reject(new Error(
                  `JSON parse error: ${e.message}\nBody: ${data.slice(0, 300)}`
                ));
              }
            },
            text: () => Promise.resolve(data)
          });
        });
      });
      
      req.on('error', reject);
      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  })();
  
  return Promise.race([workPromise, timeoutPromise]);
}
