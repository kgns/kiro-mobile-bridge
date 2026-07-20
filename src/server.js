#!/usr/bin/env node
/**
 * Kiro Mobile Bridge Server
 * A mobile web interface for monitoring Kiro IDE agent sessions from your phone over LAN.
 * Captures snapshots of the chat interface via CDP and lets you send messages remotely.
 */

process.on('uncaughtException', (err) => {
  console.error('[Server] Uncaught exception (kept alive):', err.message);
});
process.on('unhandledRejection', (err) => {
  console.error('[Server] Unhandled rejection (kept alive):', err?.message || err);
});

import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Services
import { fetchCDPTargets, connectToCDP } from './services/cdp.js';
import { captureMetadata, captureCSS, captureSnapshot, captureEditor } from './services/snapshot.js';

// Utils
import { generateId, computeHash } from './utils/hash.js';
import { getLocalIP } from './utils/network.js';
import {
  CDP_PORTS,
  DISCOVERY_INTERVAL_ACTIVE,
  DISCOVERY_INTERVAL_STABLE,
  SNAPSHOT_INTERVAL_ACTIVE,
  SNAPSHOT_INTERVAL_IDLE,
  SNAPSHOT_IDLE_THRESHOLD
} from './utils/constants.js';

// Auth
import {
  generateOTP,
  getOTP,
  setAuthEnabled,
  isAuthEnabled,
  authMiddleware,
  validateWSAuth,
  validateSession,
  getLoginPageHTML,
  verifyOTP,
  getRateLimitStatus
} from './middleware/auth.js';

// Routes
import { createApiRouter } from './routes/api.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// =============================================================================
// Configuration
// =============================================================================

const PORT = process.env.PORT || 3050;
const AUTH = process.argv.includes('--auth');

// Configure authentication
setAuthEnabled(AUTH);
if (AUTH) {
  generateOTP();
}

// =============================================================================
// State Management
// =============================================================================

const cascades = new Map(); // cascadeId -> { id, cdp, metadata, snapshot, css, snapshotHash, editor, editorHash, windowId, windowTitle }
const mainWindows = new Map(); // windowId (page target id) -> { cdp, wsUrl, title }

/**
 * Clean a raw window title for display.
 * Kiro window titles look like "<file> - <workspace> [WSL: host] - Kiro".
 * Strip the trailing " - Kiro" and any "[WSL: ...]"/"[SSH: ...]" remote tag.
 * @param {string} raw
 * @returns {string}
 */
function cleanWindowTitle(raw) {
  if (!raw) return '';
  return raw
    .replace(/\s*-\s*Kiro\s*$/i, '')
    .replace(/\s*\[(WSL|SSH|Dev Container|Codespaces)[^\]]*\]\s*/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

const pollingState = {
  lastCascadeCount: 0,
  lastMainWindowConnected: false,
  discoveryInterval: null,
  discoveryIntervalMs: DISCOVERY_INTERVAL_ACTIVE,
  stableCount: 0,
  snapshotInterval: null,
  snapshotIntervalMs: SNAPSHOT_INTERVAL_ACTIVE,
  lastSnapshotChange: Date.now(),
  idleThreshold: SNAPSHOT_IDLE_THRESHOLD
};

// =============================================================================
// Discovery Service
// =============================================================================

let _discoveryRunning = false;
async function discoverTargets() {
  if (_discoveryRunning) return;
  _discoveryRunning = true;
  try {
  const foundCascadeIds = new Set();
  const foundWindowIds = new Set();
  let foundMainWindow = false;
  let stateChanged = false;

  const portResults = await Promise.allSettled(
    CDP_PORTS.map(port => fetchCDPTargets(port).then(targets => ({ port, targets })))
  );

  for (const result of portResults) {
    if (result.status !== 'fulfilled') continue;
    const { port, targets } = result.value;

    try {
      // Map all main Kiro/VS Code windows on this port by their target id.
      // Each chat webview references its window via target.parentId.
      const windowsById = new Map();
      for (const target of targets) {
        const url = (target.url || '').toLowerCase();
        if (target.type === 'page' &&
          (url.startsWith('vscode-file://') || url.includes('workbench')) &&
          target.webSocketDebuggerUrl) {
          windowsById.set(target.id, target);
        }
      }

      // Ensure a CDP connection to each main window (used for per-window editor/workspace).
      for (const [windowId, windowTarget] of windowsById) {
        foundMainWindow = true;
        foundWindowIds.add(windowId);
        const title = cleanWindowTitle(windowTarget.title);

        if (!mainWindows.has(windowId)) {
          console.log(`[Discovery] Found main window: ${title}`);
          try {
            const cdp = await connectToCDP(windowTarget.webSocketDebuggerUrl);
            mainWindows.set(windowId, { cdp, wsUrl: windowTarget.webSocketDebuggerUrl, title });
            stateChanged = true;

            cdp.ws.on('close', () => {
              console.log(`[Discovery] Main window disconnected: ${title}`);
              mainWindows.delete(windowId);
              adjustDiscoveryInterval(true);
            });
          } catch (err) {
            console.error(`[Discovery] Failed to connect to main window: ${err.message}`);
          }
        } else {
          mainWindows.get(windowId).title = title;
        }
      }

      // Find Kiro Agent webviews (chat), one per window.
      // Exclude service workers / workers that share the vscode-webview URL scheme.
      const kiroAgentTargets = targets.filter(target => {
        const url = (target.url || '').toLowerCase();
        if (!target.webSocketDebuggerUrl) return false;
        if (target.type === 'service_worker' || target.type === 'worker' || target.type === 'shared_worker') return false;
        return url.includes('kiroagent') ||
          url.includes('vscode-webview') ||
          (url.startsWith('https://127.0.0.1:') && url.includes('/c/'));
      });

      for (const target of kiroAgentTargets) {
        const wsUrl = target.webSocketDebuggerUrl;
        const cascadeId = generateId(wsUrl);
        foundCascadeIds.add(cascadeId);
        const windowTitle = windowsById.get(target.parentId)?.title
          ? cleanWindowTitle(windowsById.get(target.parentId).title)
          : '';

        if (!cascades.has(cascadeId)) {
          stateChanged = true;

          try {
            const cdp = await connectToCDP(wsUrl);

            cascades.set(cascadeId, {
              id: cascadeId,
              cdp,
              windowId: target.parentId || null,
              windowTitle,
              metadata: { windowTitle: windowTitle || target.title || 'Unknown', chatTitle: '', isActive: true },
              snapshot: null,
              css: null,
              snapshotHash: null,
              editor: null,
              editorHash: null
            });

            cdp.ws.on('close', () => {
              console.log(`[Discovery] Cascade disconnected: ${cascadeId}`);
              cascades.delete(cascadeId);
              broadcastCascadeList();
              adjustDiscoveryInterval(true);
            });

            broadcastCascadeList();
          } catch (err) {
            console.error(`[Discovery] Failed to connect to ${cascadeId}: ${err.message}`);
          }
        } else {
          const existing = cascades.get(cascadeId);
          if (target.parentId) existing.windowId = target.parentId;
          if (windowTitle) {
            existing.windowTitle = windowTitle;
            existing.metadata.windowTitle = windowTitle;
          }
        }
      }
    } catch (err) {
      // Log port scanning errors for debugging
      console.debug(`[Discovery] Error scanning port ${port}: ${err.message}`);
    }
  }

  // Clean up main windows that are no longer present
  for (const [windowId, entry] of mainWindows) {
    if (!foundWindowIds.has(windowId)) {
      console.log(`[Discovery] Main window no longer available: ${entry.title}`);
      stateChanged = true;
      try { entry.cdp.close(); } catch (e) { /* already closed */ }
      mainWindows.delete(windowId);
    }
  }

  // Clean up disconnected targets
  for (const [cascadeId, cascade] of cascades) {
    if (!foundCascadeIds.has(cascadeId)) {
      console.log(`[Discovery] Target no longer available: ${cascadeId}`);
      stateChanged = true;
      try {
        cascade.cdp.close();
      } catch (e) {
        console.debug(`[Discovery] Error closing cascade ${cascadeId}: ${e.message}`);
      }
      cascades.delete(cascadeId);
      broadcastCascadeList();
    }
  }

  const mainWindowChanged = foundMainWindow !== pollingState.lastMainWindowConnected;
  const cascadeCountChanged = cascades.size !== pollingState.lastCascadeCount;

  if (stateChanged || mainWindowChanged || cascadeCountChanged) {
    console.log(`[Discovery] Active cascades: ${cascades.size}${foundMainWindow ? ' (main window connected)' : ''}`);
    pollingState.lastCascadeCount = cascades.size;
    pollingState.lastMainWindowConnected = foundMainWindow;
    adjustDiscoveryInterval(true);
  } else {
    adjustDiscoveryInterval(false);
  }
  } finally { _discoveryRunning = false; }
}

// =============================================================================
// Snapshot Polling
// =============================================================================

let _snapshotRunning = false;
async function pollSnapshots() {
  if (_snapshotRunning) return;
  _snapshotRunning = true;
  try {
  let anyChanges = false;

  for (const [cascadeId, cascade] of cascades) {
    try {
      const cdp = cascade.cdp;
      if (!cdp || !cdp.rootContextId) continue;

      // Capture CSS once
      if (cascade.css === null) {
        cascade.css = await captureCSS(cdp);
      }

      // Capture metadata
      const metadata = await captureMetadata(cdp);
      cascade.metadata.chatTitle = metadata.chatTitle || cascade.metadata.chatTitle;
      cascade.metadata.isActive = metadata.isActive;

      // Capture chat snapshot
      const snapshot = await captureSnapshot(cdp);
      if (snapshot) {
        const newHash = computeHash(snapshot.html);
        if (newHash !== cascade.snapshotHash) {
          cascade.snapshot = snapshot;
          cascade.snapshotHash = newHash;
          broadcastSnapshotUpdate(cascadeId, 'chat');
          anyChanges = true;
        }
      }

      // Capture editor from this cascade's own window (falls back to any window)
      // Store rootContextId locally to avoid race conditions during async operations
      const mainCDP = (cascade.windowId && mainWindows.get(cascade.windowId)?.cdp)
        || (mainWindows.size > 0 ? [...mainWindows.values()][0].cdp : null);
      const contextId = mainCDP?.rootContextId;
      if (mainCDP && contextId) {
        const editor = await captureEditor(mainCDP);
        if (editor?.hasContent) {
          const editorHash = computeHash(editor.content + editor.fileName);
          if (editorHash !== cascade.editorHash) {
            cascade.editor = editor;
            cascade.editorHash = editorHash;
            broadcastSnapshotUpdate(cascadeId, 'editor');
            anyChanges = true;
          }
        } else if (cascade.editor?.hasContent) {
          cascade.editor = { hasContent: false, fileName: '', content: '' };
          cascade.editorHash = '';
          broadcastSnapshotUpdate(cascadeId, 'editor');
          anyChanges = true;
        }
      }
    } catch (err) {
      console.error(`[Snapshot] Error polling cascade ${cascadeId}:`, err.message);
    }
  }

  adjustSnapshotInterval(anyChanges);
  } finally { _snapshotRunning = false; }
}

// =============================================================================
// Adaptive Polling
// =============================================================================

function adjustDiscoveryInterval(hasChanges) {
  if (hasChanges) {
    pollingState.stableCount = 0;
    if (pollingState.discoveryIntervalMs !== DISCOVERY_INTERVAL_ACTIVE) {
      pollingState.discoveryIntervalMs = DISCOVERY_INTERVAL_ACTIVE;
      restartDiscoveryInterval();
    }
  } else {
    pollingState.stableCount++;
    if (pollingState.stableCount >= 3 && pollingState.discoveryIntervalMs !== DISCOVERY_INTERVAL_STABLE) {
      pollingState.discoveryIntervalMs = DISCOVERY_INTERVAL_STABLE;
      restartDiscoveryInterval();
      console.log('[Discovery] Stable state, slowing to 30s interval');
    }
  }
}

function restartDiscoveryInterval() {
  if (pollingState.discoveryInterval) clearInterval(pollingState.discoveryInterval);
  pollingState.discoveryInterval = setInterval(discoverTargets, pollingState.discoveryIntervalMs);
}

function adjustSnapshotInterval(hasChanges) {
  const now = Date.now();
  if (hasChanges) {
    pollingState.lastSnapshotChange = now;
    if (pollingState.snapshotIntervalMs !== SNAPSHOT_INTERVAL_ACTIVE) {
      pollingState.snapshotIntervalMs = SNAPSHOT_INTERVAL_ACTIVE;
      restartSnapshotInterval();
    }
  } else {
    const idleTime = now - pollingState.lastSnapshotChange;
    if (idleTime > pollingState.idleThreshold && pollingState.snapshotIntervalMs !== SNAPSHOT_INTERVAL_IDLE) {
      pollingState.snapshotIntervalMs = SNAPSHOT_INTERVAL_IDLE;
      restartSnapshotInterval();
    }
  }
}

function restartSnapshotInterval() {
  if (pollingState.snapshotInterval) clearInterval(pollingState.snapshotInterval);
  pollingState.snapshotInterval = setInterval(pollSnapshots, pollingState.snapshotIntervalMs);
}

// =============================================================================
// WebSocket Broadcasting
// =============================================================================

let wss; // Will be set after server creation

function broadcastSnapshotUpdate(cascadeId, panel = 'chat') {
  if (!wss) return;
  const message = JSON.stringify({ type: 'snapshot_update', cascadeId, panel });
  for (const client of wss.clients) {
    try { if (client.readyState === WebSocket.OPEN) client.send(message); } catch (e) {}
  }
}

function serializeCascades() {
  return Array.from(cascades.values()).map(c => {
    const windowTitle = c.windowTitle || c.metadata?.windowTitle || '';
    return {
      id: c.id,
      // Prefer the human-readable window title so multiple windows are distinguishable
      title: windowTitle || c.metadata?.chatTitle || 'Kiro',
      window: windowTitle || 'Unknown',
      active: c.metadata?.isActive || false
    };
  });
}

function broadcastCascadeList() {
  if (!wss) return;
  const message = JSON.stringify({ type: 'cascade_list', cascades: serializeCascades() });
  for (const client of wss.clients) {
    try { if (client.readyState === WebSocket.OPEN) client.send(message); } catch (e) {}
  }
}

// =============================================================================
// Express App Setup
// =============================================================================

const app = express();
app.use(express.json({ limit: '20mb' })); // 20MB to accommodate base64-encoded file uploads (~15MB binary)

// Disable caching for development - ensures latest code is always served
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

// Auth routes — must be before authMiddleware
app.get('/auth/login', (req, res) => {
  res.type('html').send(getLoginPageHTML());
});

app.post('/auth/verify', (req, res) => {
  const { otp } = req.body;
  const result = verifyOTP(otp);

  if (result.success) {
    // Set HttpOnly session cookie (no Secure flag — this is HTTP-only LAN tool)
    res.cookie('kmb_session', result.token, {
      httpOnly: true,
      sameSite: 'strict',
      path: '/'
    });
    console.log(`[Auth] Device authenticated successfully`);
    res.json({ success: true });
  } else {
    console.log(`[Auth] Failed attempt: ${result.error}`);
    res.status(401).json({
      success: false,
      error: result.error,
      retryAfter: result.retryAfter || null
    });
  }
});

app.get('/auth/status', (req, res) => {
  const cookie = req.headers.cookie || '';
  const match = cookie.match(/(?:^|;\s*)kmb_session=([a-f0-9]{64})(?:;|$)/);
  const token = match ? match[1] : null;
  const rateLimit = getRateLimitStatus();
  res.json({
    authenticated: token ? validateSession(token) : false,
    authEnabled: isAuthEnabled(),
    locked: rateLimit.locked,
    consumed: rateLimit.consumed,
    retryAfter: rateLimit.retryAfter
  });
});

// Authentication gate — all routes below require valid session
app.use(authMiddleware);

app.use(express.static(join(__dirname, 'public')));

// Mount API routes
app.use('/', createApiRouter(cascades, mainWindows));

// Global error handler - prevents unhandled route errors from crashing the server
app.use((err, req, res, next) => {
  console.error('[Server] Route error (kept alive):', err.message);
  if (!res.headersSent) res.status(500).json({ error: err.message });
});

// =============================================================================
// Server Startup
// =============================================================================

const httpServer = createServer(app);

wss = new WebSocketServer({ server: httpServer });
wss.on('error', (err) => console.error('[WebSocket Server] Error:', err.message));

wss.on('connection', (ws, req) => {
  const clientIP = req.socket.remoteAddress || 'unknown';

  // Validate WebSocket authentication
  if (!validateWSAuth(req)) {
    console.log(`[WebSocket] Unauthorized connection from ${clientIP}`);
    ws.close(4401, 'Unauthorized');
    return;
  }

  console.log(`[WebSocket] Client connected from ${clientIP}`);

  // Keepalive
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  // Send cascade list on connect
  try { ws.send(JSON.stringify({ type: 'cascade_list', cascades: serializeCascades() })); } catch (e) {}

  ws.on('close', () => console.log(`[WebSocket] Client disconnected from ${clientIP}`));
  ws.on('error', (err) => console.error(`[WebSocket] Error from ${clientIP}:`, err.message));
});

// Ping clients every 30s, terminate dead ones
setInterval(() => {
  if (!wss) return;
  for (const client of wss.clients) {
    if (!client.isAlive) { client.terminate(); continue; }
    client.isAlive = false;
    try { client.ping(); } catch (e) {}
  }
}, 30000);

httpServer.on('error', (err) => console.error('[Server] HTTP server error:', err.message));
httpServer.listen(PORT, '0.0.0.0', () => {
  const localIP = getLocalIP();
  console.log('');
  console.log('Kiro Mobile Bridge');
  console.log('─────────────────────');
  console.log(`Local:   http://localhost:${PORT}`);
  console.log(`Network: http://${localIP}:${PORT}`);
  console.log('');
  if (isAuthEnabled()) {
    console.log(`\x1b[33m\x1b[1m🔑 Access Code: ${getOTP()}\x1b[0m`);
    console.log('');
    console.log('Enter this code on your device to connect.');
  } else {
    console.log('Auth disabled (--no-auth). Open the Network URL on your phone.');
  }
  console.log('');

  // Start discovery and polling
  discoverTargets();
  pollingState.discoveryInterval = setInterval(discoverTargets, pollingState.discoveryIntervalMs);
  pollingState.snapshotInterval = setInterval(pollSnapshots, pollingState.snapshotIntervalMs);
});
