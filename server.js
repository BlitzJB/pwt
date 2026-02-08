#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const readline = require('readline');
const { execSync, spawn } = require('child_process');
const WebSocket = require('ws');
const pty = require('node-pty');
const qrcode = require('qrcode-terminal');
const chalk = require('chalk');
const ngrok = require('@ngrok/ngrok');

// Parse arguments - support combined flags like -tc, -ct
const args = process.argv.slice(2);
const showHelp = args.includes('-h') || args.includes('--help');
const useCaffeinate = args.some(arg => arg.includes('c') && arg.startsWith('-') && !arg.includes('help') && !arg.includes('p'));
const useTunnel = args.some(arg => arg.includes('t') && arg.startsWith('-') && !arg.includes('help') && !arg.includes('p'));

// Parse -p flag for PIN setting
let setPinValue = null;
let clearPin = false;
const pinIndex = args.findIndex(arg => arg === '-p' || arg === '--pin');
if (pinIndex !== -1) {
  const nextArg = args[pinIndex + 1];
  if (nextArg && /^\d+$/.test(nextArg)) {
    setPinValue = nextArg;
  } else {
    clearPin = true;
  }
}

if (showHelp) {
  console.log(`
  ${chalk.bold.cyan('PWT')} - Persistent Web Terminal

  ${chalk.dim('Usage:')}
    pwt [options]

  ${chalk.dim('Options:')}
    -p, --pin <PIN>     Set or remove PIN (4-10 digits, omit to remove)
    -c, --caffeinate    Prevent system sleep (macOS only)
    -t, --tunnel        Start ngrok tunnel for remote access
    -h, --help          Show this help message

  ${chalk.dim('Examples:')}
    pwt                 Start server on default port
    pwt -p 1234         Set 4-digit PIN
    pwt -p              Remove PIN
    pwt -t              Start with ngrok tunnel
    pwt -c              Start with caffeinate enabled
    pwt -tc             Start with tunnel and caffeinate

  ${chalk.dim('Environment:')}
    PORT                Set custom port (default: 3000)

  ${chalk.dim('Config:')}
    ~/.web-terminal/config.json    Stores ngrok token and PIN hash
    ~/.web-terminal/sessions/      Session metadata
    ~/.web-terminal/sockets/       dtach sockets
`);
  process.exit(0);
}

// Config file for storing tokens
const CONFIG_FILE = path.join(os.homedir(), '.web-terminal', 'config.json');

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    }
  } catch {}
  return {};
}

function saveConfig(config) {
  const dir = path.dirname(CONFIG_FILE);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

// PIN hashing functions
function hashPin(pin) {
  return crypto.createHash('sha256').update(pin).digest('hex');
}

function verifyPin(pin, hash) {
  return hashPin(pin) === hash;
}

// Handle PIN clearing
if (clearPin) {
  const config = loadConfig();
  delete config.pinHash;
  delete config.pinLength;
  saveConfig(config);
  console.log(chalk.yellow('\n  PIN removed\n'));
  console.log(chalk.dim('  To set a PIN, run: ') + chalk.white('pwt -p <4-10 digits>'));
  console.log(chalk.dim('  Setting a PIN is recommended for security\n'));
  process.exit(0);
}

// Handle PIN setting
if (setPinValue !== null) {
  // Validate PIN: must be 4-10 digits
  if (!/^\d{4,10}$/.test(setPinValue)) {
    console.log(chalk.red('\n  PIN must be 4-10 digits\n'));
    process.exit(1);
  }

  const config = loadConfig();
  config.pinHash = hashPin(setPinValue);
  config.pinLength = setPinValue.length;
  saveConfig(config);
  console.log(chalk.green(`\n  PIN set successfully (${setPinValue.length} digits)\n`));
  process.exit(0);
}

// Get current PIN config
function getPinConfig() {
  const config = loadConfig();
  if (config.pinHash && config.pinLength) {
    return { hash: config.pinHash, length: config.pinLength };
  }
  return null;
}

async function promptForToken() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    console.log();
    rl.question(chalk.cyan('  Enter ngrok authtoken: '), (token) => {
      rl.close();
      resolve(token.trim());
    });
  });
}

async function setupNgrokToken() {
  const config = loadConfig();

  if (config.ngrokToken) {
    return config.ngrokToken;
  }

  console.log(chalk.dim('  No ngrok token found.'));
  console.log(chalk.dim('  Get your token at: ') + chalk.cyan('https://dashboard.ngrok.com/get-started/your-authtoken'));

  const token = await promptForToken();

  if (token) {
    config.ngrokToken = token;
    saveConfig(config);
    console.log(chalk.green('  Token saved!'));
  }

  return token;
}

// Start caffeinate to prevent system sleep
// -d: prevent display sleep, -i: prevent idle sleep, -s: prevent sleep on AC power
let caffeinateProcess = null;
if (useCaffeinate && os.platform() === 'darwin') {
  caffeinateProcess = spawn('caffeinate', ['-dis'], {
    stdio: 'ignore',
    detached: true,
  });
  caffeinateProcess.unref();
}

const DEFAULT_PORT = process.env.PORT || 3000;
let PORT = DEFAULT_PORT;
const MAX_BUFFER_SIZE = 100000;
const BASE_DIR = path.join(os.homedir(), '.web-terminal');
const SESSIONS_DIR = path.join(BASE_DIR, 'sessions');
const SOCKETS_DIR = path.join(BASE_DIR, 'sockets');

// Logging utility
const log = {
  time() {
    return chalk.dim(new Date().toLocaleTimeString('en-US', { hour12: false }));
  },
  info(msg) {
    console.log(`  ${this.time()}  ${chalk.blue('●')}  ${msg}`);
  },
  success(msg) {
    console.log(`  ${this.time()}  ${chalk.green('●')}  ${msg}`);
  },
  warn(msg) {
    console.log(`  ${this.time()}  ${chalk.yellow('●')}  ${msg}`);
  },
  error(msg) {
    console.log(`  ${this.time()}  ${chalk.red('●')}  ${msg}`);
  },
  dim(msg) {
    console.log(`  ${this.time()}  ${chalk.dim('●')}  ${chalk.dim(msg)}`);
  },
  client(action, details = '') {
    const detailStr = details ? chalk.dim(` ${details}`) : '';
    console.log(`  ${this.time()}  ${chalk.magenta('●')}  ${action}${detailStr}`);
  },
  session(action, name, id) {
    console.log(`  ${this.time()}  ${chalk.cyan('●')}  ${action} ${chalk.white(name)} ${chalk.dim(`(${id})`)}`);
  },
};

// Ensure directories exist
fs.mkdirSync(SESSIONS_DIR, { recursive: true });
fs.mkdirSync(SOCKETS_DIR, { recursive: true });

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return null;
}

// Find dtach path
let DTACH_PATH = null;
function findDtach() {
  const searchPaths = [
    '/opt/homebrew/bin/dtach',  // Apple Silicon Homebrew
    '/usr/local/bin/dtach',      // Intel Homebrew
    '/usr/bin/dtach',            // System
  ];

  for (const p of searchPaths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }

  // Try which as fallback
  try {
    return execSync('which dtach', { encoding: 'utf-8' }).trim();
  } catch {
    return null;
  }
}

DTACH_PATH = findDtach();
if (!DTACH_PATH) {
  console.error('\n❌ dtach is not installed!\n');
  console.error('   Install with: brew install dtach\n');
  process.exit(1);
}

// Session manager
const sessions = new Map(); // sessionId -> { pty, buffer, status, name, createdAt, clients }

function generateId() {
  return Math.random().toString(36).substring(2, 10);
}

function getSessionFilePath(sessionId) {
  return path.join(SESSIONS_DIR, `${sessionId}.json`);
}

function getSocketPath(sessionId) {
  return path.join(SOCKETS_DIR, `${sessionId}.sock`);
}

function socketExists(sessionId) {
  return fs.existsSync(getSocketPath(sessionId));
}

function saveSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;

  const data = {
    id: sessionId,
    name: session.name,
    buffer: session.buffer,
    status: session.status,
    createdAt: session.createdAt,
  };

  fs.writeFileSync(getSessionFilePath(sessionId), JSON.stringify(data));
}

function loadSessions() {
  try {
    const files = fs.readdirSync(SESSIONS_DIR);
    for (const file of files) {
      if (!file.endsWith('.json')) continue;

      const filePath = path.join(SESSIONS_DIR, file);
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      const hasSocket = socketExists(data.id);

      // Determine status based on dtach socket existence
      let status;
      if (data.status === 'terminated') {
        status = 'terminated';
      } else if (hasSocket) {
        status = 'detached'; // dtach process still running
      } else {
        status = 'terminated'; // dtach process died
      }

      sessions.set(data.id, {
        pty: null,
        buffer: data.buffer || '',
        status,
        name: data.name,
        createdAt: data.createdAt,
        clients: new Set(),
      });

      log.session('Restored', data.name, data.id);
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      log.error(`Failed to load sessions: ${err.message}`);
    }
  }
}

function createDtachSession(sessionId) {
  const socketPath = getSocketPath(sessionId);
  const shell = process.env.SHELL || '/bin/zsh';

  // Create dtach session in background
  // -n: don't attach, just create
  // -E: don't interpret escape character
  // -z: don't try to suspend dtach
  try {
    execSync(`"${DTACH_PATH}" -n "${socketPath}" -Ez ${shell}`, {
      cwd: os.homedir(),
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
      },
      stdio: 'ignore',
    });
    return true;
  } catch (err) {
    console.error(`Failed to create dtach session: ${err.message}`);
    return false;
  }
}

function attachToDtach(sessionId, session) {
  const socketPath = getSocketPath(sessionId);

  if (!fs.existsSync(socketPath)) {
    return false;
  }

  // Attach to dtach via PTY
  const ptyProcess = pty.spawn(DTACH_PATH, ['-a', socketPath, '-Ez'], {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd: os.homedir(),
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    },
  });

  session.pty = ptyProcess;
  session.status = 'running';

  ptyProcess.onData((data) => {
    session.buffer += data;
    if (session.buffer.length > MAX_BUFFER_SIZE) {
      session.buffer = session.buffer.slice(-MAX_BUFFER_SIZE);
    }

    // Broadcast to all clients attached to this session
    session.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: 'output', sessionId, data }));
      }
    });
  });

  ptyProcess.onExit(() => {
    log.dim(`PTY detached for ${sessionId}`);
    session.pty = null;

    // Check if dtach socket still exists
    if (socketExists(sessionId)) {
      session.status = 'detached';
    } else {
      session.status = 'terminated';
    }

    saveSession(sessionId);
    broadcastSessionList();
  });

  return true;
}

function createSession(name) {
  const sessionId = generateId();

  if (!createDtachSession(sessionId)) {
    return null;
  }

  // Small delay to let dtach start
  const session = {
    pty: null,
    buffer: '',
    status: 'detached',
    name: name || `Session ${sessions.size + 1}`,
    createdAt: Date.now(),
    clients: new Set(),
  };

  sessions.set(sessionId, session);
  saveSession(sessionId);
  log.session('Created', session.name, sessionId);

  return sessionId;
}

function killDtachSocket(socketPath) {
  if (!fs.existsSync(socketPath)) return;

  // Use fuser to find and kill processes using the socket
  try {
    execSync(`fuser -k "${socketPath}" 2>/dev/null`, { stdio: 'ignore' });
  } catch {
    // fuser returns non-zero if no processes found
  }

  // Also try lsof as backup
  try {
    const pids = execSync(`lsof -t "${socketPath}" 2>/dev/null`, { encoding: 'utf-8' }).trim();
    if (pids) {
      for (const pid of pids.split('\n')) {
        try {
          process.kill(parseInt(pid), 'SIGTERM');
        } catch {}
      }
    }
  } catch {}

  // Small delay then force remove socket
  setTimeout(() => {
    try {
      fs.unlinkSync(socketPath);
    } catch {}
  }, 100);
}

function terminateSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return false;

  // Detach PTY if connected
  if (session.pty) {
    session.pty.kill();
    session.pty = null;
  }

  // Kill dtach process using the socket
  const socketPath = getSocketPath(sessionId);
  killDtachSocket(socketPath);

  session.status = 'terminated';
  saveSession(sessionId);

  // Notify all clients
  session.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: 'terminated', sessionId }));
    }
  });

  log.session('Terminated', session.name, sessionId);
  return true;
}

function reactivateSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session || session.status !== 'terminated') return false;

  if (!createDtachSession(sessionId)) {
    return false;
  }

  session.status = 'detached';
  saveSession(sessionId);
  log.session('Reactivated', session.name, sessionId);

  // Notify clients
  session.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: 'reactivated', sessionId }));
    }
  });

  return true;
}

function deleteSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return false;

  // Kill PTY attachment
  if (session.pty) {
    session.pty.kill();
  }

  // Kill dtach process
  const socketPath = getSocketPath(sessionId);
  killDtachSocket(socketPath);

  // Remove from memory immediately
  sessions.delete(sessionId);

  // Delete metadata file
  try {
    fs.unlinkSync(getSessionFilePath(sessionId));
  } catch {}

  // Force remove socket synchronously as well
  try {
    fs.unlinkSync(socketPath);
  } catch {}

  log.warn(`Deleted session ${sessionId}`);
  return true;
}

function getSessionList() {
  const list = [];
  sessions.forEach((session, id) => {
    list.push({
      id,
      name: session.name,
      status: session.status,
      createdAt: session.createdAt,
    });
  });
  list.sort((a, b) => a.createdAt - b.createdAt);
  return list;
}

function broadcastSessionList() {
  const list = getSessionList();
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: 'sessions', sessions: list }));
    }
  });
}

// Load existing sessions on startup
loadSessions();

// HTTP server for static files
const server = http.createServer((req, res) => {
  let filePath;
  const url = req.url.split('?')[0];

  if (url === '/') {
    filePath = path.join(__dirname, 'public', 'index.html');
  } else if (url.startsWith('/node_modules/')) {
    filePath = path.join(__dirname, url);
  } else {
    filePath = path.join(__dirname, 'public', url);
  }

  const extname = path.extname(filePath);
  const contentTypes = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.map': 'application/json',
    '.json': 'application/json',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
  };

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentTypes[extname] || 'text/plain' });
    res.end(content);
  });
});

// WebSocket server
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
  const clientIP = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  const shortIP = clientIP.replace('::ffff:', '').replace('::1', 'localhost');
  ws.clientIP = shortIP;

  log.client('Connected', shortIP);

  ws.isAlive = true;
  ws.attachedSession = null;

  // Check if PIN auth is required
  const pinConfig = getPinConfig();
  if (pinConfig) {
    ws.isAuthenticated = false;
    ws.send(JSON.stringify({ type: 'auth_required', pinLength: pinConfig.length }));
    log.dim(`Auth required for ${shortIP}`);
  } else {
    ws.isAuthenticated = true;
    // Send session list on connect (no auth needed)
    ws.send(JSON.stringify({ type: 'sessions', sessions: getSessionList() }));
  }

  ws.on('message', (message) => {
    try {
      const msg = JSON.parse(message);

      // Handle authentication
      if (msg.type === 'auth') {
        const pinConfig = getPinConfig();
        if (!pinConfig) {
          ws.isAuthenticated = true;
          ws.send(JSON.stringify({ type: 'auth_success' }));
          ws.send(JSON.stringify({ type: 'sessions', sessions: getSessionList() }));
          return;
        }

        if (verifyPin(msg.pin, pinConfig.hash)) {
          ws.isAuthenticated = true;
          log.success(`Authenticated ${ws.clientIP}`);
          ws.send(JSON.stringify({ type: 'auth_success' }));
          ws.send(JSON.stringify({ type: 'sessions', sessions: getSessionList() }));
        } else {
          log.warn(`Auth failed for ${ws.clientIP}`);
          ws.send(JSON.stringify({ type: 'auth_failed' }));
        }
        return;
      }

      // Block all other messages if not authenticated
      if (!ws.isAuthenticated) {
        ws.send(JSON.stringify({ type: 'error', message: 'Not authenticated' }));
        return;
      }

      switch (msg.type) {
        case 'list':
          ws.send(JSON.stringify({ type: 'sessions', sessions: getSessionList() }));
          break;

        case 'create': {
          const sessionId = createSession(msg.name);
          if (sessionId) {
            ws.send(JSON.stringify({ type: 'created', sessionId }));
            broadcastSessionList();
          } else {
            ws.send(JSON.stringify({ type: 'error', message: 'Failed to create session' }));
          }
          break;
        }

        case 'attach': {
          const session = sessions.get(msg.sessionId);
          if (!session) {
            ws.send(JSON.stringify({ type: 'error', message: 'Session not found' }));
            break;
          }

          // Detach from previous session
          if (ws.attachedSession) {
            const prevSession = sessions.get(ws.attachedSession);
            if (prevSession) {
              prevSession.clients.delete(ws);
            }
          }

          // Attach to dtach if not already connected and session is alive
          if (!session.pty && session.status !== 'terminated') {
            if (socketExists(msg.sessionId)) {
              attachToDtach(msg.sessionId, session);
              broadcastSessionList();
            } else {
              // Socket gone, session is dead
              session.status = 'terminated';
              saveSession(msg.sessionId);
              broadcastSessionList();
            }
          }

          // Attach client to session
          ws.attachedSession = msg.sessionId;
          session.clients.add(ws);

          // Send session info and history
          ws.send(JSON.stringify({
            type: 'attached',
            sessionId: msg.sessionId,
            name: session.name,
            status: session.status,
          }));

          if (session.buffer) {
            ws.send(JSON.stringify({ type: 'history', sessionId: msg.sessionId, data: session.buffer }));
          }
          break;
        }

        case 'detach': {
          if (ws.attachedSession) {
            const session = sessions.get(ws.attachedSession);
            if (session) {
              session.clients.delete(ws);
            }
            ws.attachedSession = null;
          }
          break;
        }

        case 'input': {
          if (!ws.attachedSession) break;
          const session = sessions.get(ws.attachedSession);
          if (session && session.pty && session.status === 'running') {
            session.pty.write(msg.data);
          }
          break;
        }

        case 'resize': {
          if (!ws.attachedSession) break;
          const session = sessions.get(ws.attachedSession);
          if (session && session.pty && msg.cols && msg.rows) {
            session.pty.resize(msg.cols, msg.rows);
          }
          break;
        }

        case 'terminate': {
          if (terminateSession(msg.sessionId)) {
            broadcastSessionList();
          }
          break;
        }

        case 'reactivate': {
          if (reactivateSession(msg.sessionId)) {
            broadcastSessionList();
          }
          break;
        }

        case 'delete': {
          if (deleteSession(msg.sessionId)) {
            broadcastSessionList();
          }
          break;
        }

        case 'rename': {
          const session = sessions.get(msg.sessionId);
          if (session && msg.name) {
            session.name = msg.name;
            saveSession(msg.sessionId);
            broadcastSessionList();
          }
          break;
        }

        case 'ping':
          ws.isAlive = true;
          ws.send(JSON.stringify({ type: 'pong' }));
          break;
      }
    } catch (e) {
      log.error(`Parse error: ${e.message}`);
    }
  });

  ws.on('close', () => {
    if (ws.attachedSession) {
      const session = sessions.get(ws.attachedSession);
      if (session) {
        session.clients.delete(ws);
      }
    }
    log.client('Disconnected', ws.clientIP);
  });

  ws.on('error', (err) => {
    log.error(`WebSocket error: ${err.message}`);
  });
});

// Server-side heartbeat
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      log.warn(`Stale connection terminated ${ws.clientIP}`);
      return ws.terminate();
    }
    ws.isAlive = false;
  });
}, 45000);

// Periodic save of all sessions
const saveInterval = setInterval(() => {
  sessions.forEach((session, id) => {
    saveSession(id);
  });
}, 30000);

function tryPort(port) {
  return new Promise((resolve, reject) => {
    const testServer = http.createServer();
    testServer.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        resolve(false);
      } else {
        reject(err);
      }
    });
    testServer.once('listening', () => {
      testServer.close(() => resolve(true));
    });
    testServer.listen(port);
  });
}

async function findAvailablePort(startPort) {
  let port = startPort;
  while (port < startPort + 100) {
    if (await tryPort(port)) {
      return port;
    }
    log.dim(`Port ${port} in use, trying ${port + 1}`);
    port++;
  }
  throw new Error('No available port found');
}

function printBanner(localIP, networkUrl, tunnelUrl) {
  const dim = chalk.dim;
  const cyan = chalk.cyan;
  const green = chalk.green;
  const yellow = chalk.yellow;
  const white = chalk.white;
  const bold = chalk.bold;

  console.log();
  console.log(dim('  ┌────────────────────────────────┐'));
  console.log(dim('  │') + bold.cyan('          PWT Server            ') + dim('│'));
  console.log(dim('  │') + dim('    Persistent Web Terminal     ') + dim('│'));
  console.log(dim('  └────────────────────────────────┘'));
  console.log();

  // Show PIN warning if not set
  const pinConfig = getPinConfig();
  if (!pinConfig) {
    console.log(yellow('  Warning: No PIN set - terminal is unprotected'));
    console.log(dim('  Set one with: ') + white('pwt -p <4-10 digits>'));
    console.log();
  }

  if (useCaffeinate && os.platform() === 'darwin') {
    console.log(dim('  Caffeinate ') + green('enabled'));
  }
  console.log(dim('  Local     ') + green(`http://localhost:${PORT}`));
  if (localIP) {
    console.log(dim('  Network   ') + green(networkUrl));
  }
  if (tunnelUrl) {
    console.log(dim('  Tunnel    ') + green(tunnelUrl));
  }

  // Show QR for tunnel URL if available, otherwise network URL
  const qrUrl = tunnelUrl || networkUrl;
  if (qrUrl) {
    console.log();
    qrcode.generate(qrUrl, { small: true }, (code) => {
      const lines = code.split('\n');
      lines.forEach(line => {
        if (line.trim()) console.log('  ' + line);
      });
      console.log();
      console.log(dim('  Sessions  ') + white(SESSIONS_DIR));
      console.log(dim('  Sockets   ') + white(SOCKETS_DIR));
      console.log();
      console.log(dim('  Press ') + white('n') + dim(' to refresh network  •  ') + white('Ctrl+C') + dim(' to stop'));
      console.log();
    });
  } else {
    console.log();
    console.log(dim('  Sessions  ') + white(SESSIONS_DIR));
    console.log(dim('  Sockets   ') + white(SOCKETS_DIR));
    console.log();
    console.log(dim('  Press ') + white('n') + dim(' to refresh network  •  ') + white('Ctrl+C') + dim(' to stop'));
    console.log();
  }
}

let ngrokListener = null;

async function startServer() {
  // Setup ngrok token if tunnel is requested
  let tunnelUrl = null;
  if (useTunnel) {
    const token = await setupNgrokToken();
    if (!token) {
      console.log(chalk.red('  No ngrok token provided. Tunnel disabled.'));
    }
  }

  PORT = await findAvailablePort(DEFAULT_PORT);

  server.listen(PORT, async () => {
    const localIP = getLocalIP();
    const networkUrl = localIP ? `http://${localIP}:${PORT}` : null;

    // Start ngrok tunnel if requested
    if (useTunnel) {
      const config = loadConfig();
      if (config.ngrokToken) {
        try {
          console.log(chalk.dim('  Starting tunnel...'));
          ngrokListener = await ngrok.connect({
            addr: PORT,
            authtoken: config.ngrokToken,
          });
          tunnelUrl = ngrokListener.url();
        } catch (err) {
          console.log(chalk.red(`  Tunnel error: ${err.message}`));
        }
      }
    }

    printBanner(localIP, networkUrl, tunnelUrl);
  });
}

startServer();

// Listen for 'n' key to refresh network address
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', (key) => {
    if (key[0] === 3) {
      process.emit('SIGINT');
      return;
    }
    if (key[0] === 110 || key[0] === 78) {
      const localIP = getLocalIP();
      if (localIP) {
        console.log(`   Network: http://${localIP}:${PORT}`);
      } else {
        console.log(`   Network: Not connected to WiFi`);
      }
    }
  });
}

// Graceful shutdown - sessions will persist
process.on('SIGINT', async () => {
  console.log(chalk.dim('\n  Shutting down (sessions will persist)...'));
  clearInterval(heartbeatInterval);
  clearInterval(saveInterval);

  // Save all sessions and detach PTYs (but don't kill dtach)
  sessions.forEach((session, id) => {
    if (session.pty) {
      session.pty.kill(); // This just detaches from dtach, doesn't kill it
    }
    session.status = socketExists(id) ? 'detached' : 'terminated';
    saveSession(id);
  });

  wss.clients.forEach((ws) => {
    ws.close();
  });

  // Kill caffeinate process if running
  if (caffeinateProcess) {
    caffeinateProcess.kill();
  }

  // Close ngrok tunnel if running
  if (ngrokListener) {
    try {
      await ngrokListener.close();
    } catch {}
  }

  server.close(() => {
    process.exit(0);
  });
});
