// server.js - Server Professionale FIXED v3.0
// Fix: paths consistenti, lock management, error handling migliorato

const express = require('express');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 10000;

// =====================================================
// CONFIGURAZIONE PATHS E DIRECTORY - FIXED
// =====================================================
const dataDir = process.env.DATA_DIR || (process.env.RENDER ? '/data' : './data');
const outputDir = path.join(dataDir, 'output');
const logsDir = path.join(dataDir, 'logs');
const backupDir = path.join(dataDir, 'backups');

// File paths principali - TUTTI in outputDir per consistenza
const csvLatestPath = path.join(outputDir, 'prodotti_latest.csv');
const systemLogPath = path.join(logsDir, 'system.log');
const scraperLogPath = path.join(logsDir, 'scraper.log');
const stockLogPath = path.join(logsDir, 'stock_checker.log');
const eventsLogPath = path.join(logsDir, 'events.json');

// 🆕 Lock paths
const scraperLockPath = path.join(outputDir, 'scraper.lock');
const stockLockPath = path.join(outputDir, 'stock_checker.lock');

// =====================================================
// ENSURE DIRECTORIES AT STARTUP
// =====================================================
function ensureDirectories() {
  [dataDir, outputDir, logsDir, backupDir, path.join(outputDir, 'images')].forEach(dir => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      console.log(`✓ Created directory: ${dir}`);
    }
  });
}

// =====================================================
// SISTEMA DI LOGGING PROFESSIONALE
// =====================================================
class Logger {
  constructor(logFile) {
    this.logFile = logFile;
  }

  log(message, level = 'INFO', metadata = {}) {
    const timestamp = new Date().toISOString();
    const logEntry = {
      timestamp,
      level,
      message,
      ...metadata
    };

    // Console log
    console.log(`[${timestamp}] [${level}] ${message}`);
    
    // File log
    try {
      const logLine = JSON.stringify(logEntry) + '\n';
      fs.appendFileSync(this.logFile, logLine);
      
      // Aggiungi anche a events.json per eventi importanti
      if (level === 'ERROR' || level === 'WARN' || metadata.event) {
        this.logEvent(logEntry);
      }
    } catch (e) {
      console.error('Log error:', e.message);
    }
  }

  logEvent(entry) {
    try {
      let events = [];
      if (fs.existsSync(eventsLogPath)) {
        const content = fs.readFileSync(eventsLogPath, 'utf8');
        events = JSON.parse(content || '[]');
      }
      
      events.unshift(entry);
      events = events.slice(0, 1000);
      
      fs.writeFileSync(eventsLogPath, JSON.stringify(events, null, 2));
    } catch (e) {
      // Silent fail
    }
  }
}

const logger = new Logger(systemLogPath);

// =====================================================
// LOCK MANAGER - NEW
// =====================================================
class LockManager {
  static checkLock(lockPath, maxAgeMs = 14400000) { // 4h default
    try {
      if (fs.existsSync(lockPath)) {
        const lockData = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        const lockAge = Date.now() - lockData.timestamp;
        
        if (lockAge > maxAgeMs) {
          logger.log(`Lock stale detected (${Math.round(lockAge/3600000)}h), removing`, 'WARN');
          fs.unlinkSync(lockPath);
          return false;
        }
        
        logger.log(`Lock exists (PID ${lockData.pid})`, 'WARN');
        return true;
      }
      return false;
    } catch (e) {
      logger.log(`Error checking lock: ${e.message}`, 'ERROR');
      return false;
    }
  }
  
  static createLock(lockPath, processId) {
    const lockData = {
      pid: process.pid,
      processId,
      timestamp: Date.now(),
      startedAt: new Date().toISOString()
    };
    
    try {
      fs.writeFileSync(lockPath, JSON.stringify(lockData, null, 2));
      logger.log(`Lock created: ${path.basename(lockPath)}`, 'INFO');
      return true;
    } catch (e) {
      logger.log(`Failed to create lock: ${e.message}`, 'ERROR');
      return false;
    }
  }
  
  static removeLock(lockPath) {
    try {
      if (fs.existsSync(lockPath)) {
        fs.unlinkSync(lockPath);
        logger.log(`Lock removed: ${path.basename(lockPath)}`, 'INFO');
      }
    } catch (e) {
      logger.log(`Error removing lock: ${e.message}`, 'WARN');
    }
  }
}

// =====================================================
// TRACKING PROCESSI E STATO
// =====================================================
const processTracker = {
  running: {},
  history: [],
  
  start(processId, type, params) {
    this.running[processId] = {
      id: processId,
      type,
      params,
      startTime: Date.now(),
      status: 'running',
      progress: 0,
      pid: null
    };
    
    logger.log(`Process started: ${type}`, 'INFO', {
      event: 'process_start',
      processId,
      type,
      params
    });
  },
  
  setPid(processId, pid) {
    if (this.running[processId]) {
      this.running[processId].pid = pid;
    }
  },
  
  update(processId, progress, message) {
    if (this.running[processId]) {
      this.running[processId].progress = progress;
      this.running[processId].lastUpdate = Date.now();
      this.running[processId].message = message;
    }
  },
  
  end(processId, status = 'completed', result = {}) {
    const process = this.running[processId];
    if (process) {
      process.endTime = Date.now();
      process.duration = process.endTime - process.startTime;
      process.status = status;
      process.result = result;
      
      this.history.unshift(process);
      this.history = this.history.slice(0, 100);
      
      delete this.running[processId];
      
      logger.log(`Process ended: ${process.type}`, 'INFO', {
        event: 'process_end',
        processId,
        status,
        duration: process.duration,
        result
      });
    }
  },
  
  getRunning() {
    return Object.values(this.running);
  },
  
  getHistory() {
    return this.history;
  }
};

// =====================================================
// MIDDLEWARE E ROUTING STATICO
// =====================================================
app.use(express.json());
app.use('/output', express.static(outputDir));
app.use('/logs', express.static(logsDir));
app.use('/backups', express.static(backupDir));

// Helper per URL pubblico
function getPublicUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`;
  return `${proto}://${host}`;
}

// =====================================================
// API ENDPOINTS - IMPROVED
// =====================================================

// Health check
app.get('/healthz', (req, res) => {
  res.status(200).json({ 
    status: 'healthy',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// System stats API
app.get('/api/stats', (req, res) => {
  const stats = getSystemStats();
  res.json(stats);
});

// Process tracking API
app.get('/api/processes', (req, res) => {
  res.json({
    running: processTracker.getRunning(),
    history: processTracker.getHistory()
  });
});

// Start scraping - WITH LOCK CHECK
app.post('/api/scrape', async (req, res) => {
  const pages = parseInt(req.body.pages) || 20;
  
  // Check lock
  if (LockManager.checkLock(scraperLockPath)) {
    return res.status(409).json({ 
      error: 'Scraper già in esecuzione',
      message: 'Attendi il completamento dello scraping in corso'
    });
  }
  
  const processId = `manual_scrape_${Date.now()}`;
  processTracker.start(processId, 'manual_scraping', { pages });
  
  // Spawn process
  const child = spawn('node', ['scraper_componenti_wpai_min.js', pages.toString()], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false
  });
  
  processTracker.setPid(processId, child.pid);
  
  // Capture output
  let output = '';
  child.stdout.on('data', (data) => {
    output += data.toString();
  });
  
  child.stderr.on('data', (data) => {
    logger.log(`Scraper error: ${data}`, 'ERROR');
  });
  
  child.on('close', (code) => {
    processTracker.end(processId, code === 0 ? 'completed' : 'failed', { 
      exitCode: code,
      output: output.slice(-500)
    });
    LockManager.removeLock(scraperLockPath);
  });
  
  // Timeout safety
  const timeout = setTimeout(() => {
    if (child.pid) {
      logger.log('Scraper timeout, terminating', 'WARN');
      try {
        process.kill(child.pid, 'SIGTERM');
      } catch (e) {
        logger.log(`Kill failed: ${e.message}`, 'ERROR');
      }
    }
  }, 4 * 60 * 60 * 1000); // 4 hours
  
  child.on('close', () => clearTimeout(timeout));
  
  res.json({ 
    success: true, 
    processId,
    message: `Scraping avviato per ${pages} pagine` 
  });
});

// Start stock check - WITH LOCK CHECK
app.post('/api/stock-check', async (req, res) => {
  const count = parseInt(req.body.count) || 1000;
  
  // Check if stock-checker exists
  if (!fs.existsSync(path.join(__dirname, 'stock-checker-light.js'))) {
    return res.status(404).json({ 
      error: 'Stock checker non trovato',
      message: 'File stock-checker-light.js mancante'
    });
  }
  
  // Check lock
  if (LockManager.checkLock(stockLockPath)) {
    return res.status(409).json({ 
      error: 'Stock check già in esecuzione',
      message: 'Attendi il completamento del controllo in corso'
    });
  }
  
  const processId = `manual_stock_${Date.now()}`;
  processTracker.start(processId, 'manual_stock_check', { count });
  LockManager.createLock(stockLockPath, processId);
  
  const child = spawn('node', ['stock-checker-light.js', count.toString()], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false
  });
  
  processTracker.setPid(processId, child.pid);
  
  child.on('close', (code) => {
    processTracker.end(processId, code === 0 ? 'completed' : 'failed', { exitCode: code });
    LockManager.removeLock(stockLockPath);
  });
  
  // Timeout
  const timeout = setTimeout(() => {
    if (child.pid) {
      logger.log('Stock check timeout, terminating', 'WARN');
      try {
        process.kill(child.pid, 'SIGTERM');
      } catch (e) {}
    }
  }, 2 * 60 * 60 * 1000); // 2 hours
  
  child.on('close', () => clearTimeout(timeout));
  
  res.json({ 
    success: true, 
    processId,
    message: `Stock check avviato per ${count} prodotti` 
  });
});

// Download CSV
app.get('/api/download-csv', (req, res) => {
  if (!fs.existsSync(csvLatestPath)) {
    return res.status(404).json({ error: 'CSV non trovato' });
  }
  res.download(csvLatestPath, 'prodotti_componenti.csv');
});

// =====================================================
// DASHBOARD PRINCIPALE
// =====================================================
app.get('/', (req, res) => {
  const stats = getSystemStats();
  const baseUrl = getPublicUrl(req);
  
  res.send(`
<!DOCTYPE html>
<html lang="it">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Scraper CD - Dashboard v3.0</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { 
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      padding: 20px;
    }
    .container { max-width: 1400px; margin: 0 auto; }
    
    .header {
      background: white;
      border-radius: 10px;
      padding: 20px;
      margin-bottom: 20px;
      box-shadow: 0 4px 6px rgba(0,0,0,0.1);
    }
    
    .header h1 { 
      color: #333; 
      font-size: 2em;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    
    .version { 
      font-size: 0.4em; 
      color: #666; 
      background: #f0f0f0; 
      padding: 4px 8px; 
      border-radius: 4px;
      font-weight: normal;
    }
    
    .status-badge {
      display: inline-block;
      padding: 4px 12px;
      border-radius: 20px;
      font-size: 14px;
      font-weight: 500;
    }
    
    .status-badge.active { background: #c6f6d5; color: #22543d; }
    .status-badge.warning { background: #fed7aa; color: #7c2d12; }
    .status-badge.error { background: #fed7d7; color: #742a2a; }
    
    .grid { 
      display: grid; 
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); 
      gap: 20px;
      margin-bottom: 20px;
    }
    
    .card { 
      background: white; 
      border-radius: 10px; 
      padding: 20px; 
      box-shadow: 0 4px 6px rgba(0,0,0,0.1);
      transition: transform 0.2s;
    }
    
    .card:hover { transform: translateY(-2px); }
    
    .card h2 { 
      color: #333; 
      margin-bottom: 15px; 
      font-size: 1.1em;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    
    .metric { 
      font-size: 2.5em; 
      font-weight: bold; 
      color: #667eea; 
      margin: 10px 0;
    }
    
    .metric-label { 
      color: #666; 
      font-size: 0.9em;
      margin-top: 5px;
    }
    
    .action-section {
      background: white;
      border-radius: 10px;
      padding: 20px;
      margin-bottom: 20px;
    }
    
    .button-group {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin: 15px 0;
    }
    
    .btn {
      padding: 12px 24px;
      border: none;
      border-radius: 8px;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.3s;
      text-decoration: none;
      display: inline-block;
      text-align: center;
    }
    
    .btn-primary {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
    }
    
    .btn-primary:hover {
      transform: translateY(-2px);
      box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
    }
    
    .btn-secondary {
      background: #f7fafc;
      color: #2d3748;
      border: 2px solid #e2e8f0;
    }
    
    .btn-secondary:hover {
      background: #edf2f7;
      border-color: #cbd5e0;
    }
    
    .btn-danger {
      background: #fc8181;
      color: white;
    }
    
    .process-list {
      margin-top: 15px;
    }
    
    .process-item {
      background: #f7fafc;
      padding: 12px;
      border-radius: 6px;
      margin-bottom: 8px;
      border-left: 4px solid #667eea;
    }
    
    .process-item.running { border-left-color: #48bb78; }
    .process-item.completed { border-left-color: #4299e1; }
    .process-item.failed { border-left-color: #f56565; }
    
    .log-viewer {
      background: #1a202c;
      color: #a0aec0;
      padding: 15px;
      border-radius: 6px;
      font-family: 'Courier New', monospace;
      font-size: 13px;
      max-height: 400px;
      overflow-y: auto;
      white-space: pre-wrap;
      word-wrap: break-word;
    }
    
    .alert {
      padding: 12px 16px;
      border-radius: 6px;
      margin-bottom: 15px;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    
    .alert-info { background: #bee3f8; color: #2c5282; }
    .alert-warning { background: #feebc8; color: #7c2d12; }
    .alert-success { background: #c6f6d5; color: #22543d; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>
        🔧 Scraper Componenti Digitali
        <span class="version">v3.0 FIXED</span>
      </h1>
      <p style="color: #666; margin-top: 10px;">
        Sistema ottimizzato per scraping e monitoraggio stock
        <span class="status-badge ${stats.systemStatus === 'active' ? 'active' : 'warning'}">
          ${stats.systemStatus === 'active' ? '● Attivo' : '● Attesa'}
        </span>
      </p>
    </div>

    ${stats.activeProcesses > 0 ? `
      <div class="alert alert-info">
        ⚙️ <strong>${stats.activeProcesses} processi in esecuzione</strong> - Verifica lo stato qui sotto
      </div>
    ` : ''}

    <div class="grid">
      <div class="card">
        <h2>📦 Prodotti Totali</h2>
        <div class="metric">${stats.totalProducts.toLocaleString()}</div>
        <div class="metric-label">Prodotti nel catalogo</div>
      </div>

      <div class="card">
        <h2>🕒 Ultimo Aggiornamento</h2>
        <div class="metric" style="font-size: 1.5em;">${stats.lastUpdate.time}</div>
        <div class="metric-label">${stats.lastUpdate.ago}</div>
      </div>

      <div class="card">
        <h2>📊 Dimensione CSV</h2>
        <div class="metric">${stats.csvSize} MB</div>
        <div class="metric-label">File dati principale</div>
      </div>

      <div class="card">
        <h2>🖼️ Immagini</h2>
        <div class="metric">${stats.imagesCount.toLocaleString()}</div>
        <div class="metric-label">Immagini scaricate</div>
      </div>

      <div class="card">
        <h2>⚡ Uptime Server</h2>
        <div class="metric" style="font-size: 1.8em;">${stats.uptime}</div>
        <div class="metric-label">Tempo attivo</div>
      </div>

      <div class="card">
        <h2>💾 Memoria</h2>
        <div class="metric" style="font-size: 1.8em;">${stats.memory.used} MB</div>
        <div class="metric-label">Di ${stats.memory.total} MB disponibili</div>
      </div>
    </div>

    <div class="action-section">
      <h2 style="margin-bottom: 15px;">⚡ Azioni Rapide</h2>
      
      <div class="button-group">
        <button class="btn btn-primary" onclick="startScraping(20)">
          🔄 Scraping Test (20 pagine)
        </button>
        <button class="btn btn-primary" onclick="startScraping(200)">
          🔄 Scraping Completo (200 pagine)
        </button>
        <button class="btn btn-secondary" onclick="startStockCheck(1000)">
          📊 Stock Check (1000 prodotti)
        </button>
        <button class="btn btn-secondary" onclick="startStockCheck(5000)">
          📊 Stock Check Completo (5000)
        </button>
        <a href="/api/download-csv" class="btn btn-secondary">
          ⬇️ Scarica CSV
        </a>
      </div>
    </div>

    ${stats.runningProcesses.length > 0 ? `
      <div class="action-section">
        <h2 style="margin-bottom: 15px;">🔄 Processi in Esecuzione</h2>
        <div class="process-list">
          ${stats.runningProcesses.map(p => `
            <div class="process-item running">
              <strong>${p.type}</strong> (PID: ${p.id})
              <br>
              <small>Avviato: ${new Date(p.startTime).toLocaleTimeString('it-IT')}</small>
              ${p.message ? `<br><small>${p.message}</small>` : ''}
            </div>
          `).join('')}
        </div>
      </div>
    ` : ''}

    <div class="action-section">
      <h2 style="margin-bottom: 15px;">📝 Log Eventi Recenti</h2>
      <div class="log-viewer" id="logViewer">
${stats.recentEvents || 'Nessun evento recente'}
      </div>
    </div>

    <div class="action-section">
      <h2 style="margin-bottom: 15px;">ℹ️ Informazioni Sistema</h2>
      <div style="background: #f7fafc; padding: 15px; border-radius: 6px;">
        <p><strong>Environment:</strong> ${process.env.NODE_ENV || 'development'}</p>
        <p><strong>Render:</strong> ${process.env.RENDER ? 'Yes' : 'No'}</p>
        <p><strong>Data Directory:</strong> ${dataDir}</p>
        <p><strong>Base URL:</strong> ${baseUrl}</p>
        ${process.env.RENDER ? `
          <p style="margin-top: 10px; color: #48bb78;">
            ✓ CRON Jobs attivi: Scraping notturno (02:00), Stock check (ogni 2.5h), Backup (05:00)
          </p>
        ` : `
          <p style="margin-top: 10px; color: #ed8936;">
            ⚠ CRON Jobs disabilitati (modalità development)
          </p>
        `}
      </div>
    </div>
  </div>

  <script>
    async function startScraping(pages) {
      if (!confirm(\`Avviare scraping di \${pages} pagine? (Durata stimata: \${Math.round(pages * 2)} minuti)\`)) return;
      
      try {
        const response = await fetch('/api/scrape', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pages })
        });
        
        const data = await response.json();
        
        if (response.ok) {
          alert('✓ Scraping avviato! Monitora il progresso nella sezione "Processi in Esecuzione".');
          setTimeout(() => location.reload(), 2000);
        } else {
          alert('✗ Errore: ' + (data.message || data.error || 'Errore sconosciuto'));
        }
      } catch (error) {
        alert('✗ Errore di rete: ' + error.message);
      }
    }
    
    async function startStockCheck(count) {
      if (!confirm(\`Controllare stock di \${count} prodotti?\`)) return;
      
      try {
        const response = await fetch('/api/stock-check', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ count })
        });
        
        const data = await response.json();
        
        if (response.ok) {
          alert('✓ Stock check avviato!');
          setTimeout(() => location.reload(), 2000);
        } else {
          alert('✗ Errore: ' + (data.message || data.error || 'Errore sconosciuto'));
        }
      } catch (error) {
        alert('✗ Errore di rete: ' + error.message);
      }
    }
    
    // Auto-refresh ogni 30 secondi se ci sono processi attivi
    ${stats.activeProcesses > 0 ? 'setTimeout(() => location.reload(), 30000);' : ''}
  </script>
</body>
</html>
  `);
});

// =====================================================
// HELPER FUNCTIONS
// =====================================================

function getSystemStats() {
  const stats = {
    systemStatus: 'active',
    totalProducts: 0,
    lastUpdate: {
      time: 'Mai',
      ago: 'N/A'
    },
    csvSize: 0,
    imagesCount: 0,
    activeProcesses: 0,
    runningProcesses: [],
    uptime: formatUptime(process.uptime()),
    memory: {
      used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024)
    },
    recentEvents: 'Caricamento...'
  };
  
  try {
    // CSV stats
    if (fs.existsSync(csvLatestPath)) {
      const csvStats = fs.statSync(csvLatestPath);
      const csvContent = fs.readFileSync(csvLatestPath, 'utf8');
      const lines = csvContent.split('\n').filter(l => l.trim());
      
      stats.totalProducts = Math.max(0, lines.length - 1);
      stats.csvSize = (csvStats.size / 1024 / 1024).toFixed(2);
      
      const lastMod = new Date(csvStats.mtime);
      stats.lastUpdate.time = lastMod.toLocaleString('it-IT', {
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      });
      
      const minutes = Math.floor((Date.now() - lastMod) / 60000);
      if (minutes < 60) {
        stats.lastUpdate.ago = `${minutes} minuti fa`;
      } else if (minutes < 1440) {
        stats.lastUpdate.ago = `${Math.floor(minutes/60)} ore fa`;
      } else {
        stats.lastUpdate.ago = `${Math.floor(minutes/1440)} giorni fa`;
      }
    }
    
    // Images count
    const imagesPath = path.join(outputDir, 'images');
    if (fs.existsSync(imagesPath)) {
      const images = fs.readdirSync(imagesPath);
      stats.imagesCount = images.filter(f => /\.(jpg|jpeg|png)$/i.test(f)).length;
    }
    
    // Running processes
    stats.runningProcesses = processTracker.getRunning();
    stats.activeProcesses = stats.runningProcesses.length;
    
    // Recent events
    if (fs.existsSync(eventsLogPath)) {
      const events = JSON.parse(fs.readFileSync(eventsLogPath, 'utf8') || '[]');
      stats.recentEvents = events.slice(0, 20)
        .map(e => `[${e.timestamp}] [${e.level}] ${e.message}`)
        .join('\n');
    }
    
  } catch (error) {
    logger.log('Error getting stats', 'ERROR', { error: error.message });
  }
  
  return stats;
}

function formatUptime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  
  if (days > 0) return `${days}g ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

// =====================================================
// CRON JOBS - SCHEDULING OTTIMIZZATO
// =====================================================

if (process.env.NODE_ENV === 'production' || process.env.RENDER) {
  
  // SCRAPING COMPLETO NOTTURNO - Ore 2:00 (max 4 ore)
  cron.schedule('0 2 * * *', () => {
    // Check lock prima di avviare
    if (LockManager.checkLock(scraperLockPath)) {
      logger.log('[CRON] Scraper già in corso, skip', 'WARN');
      return;
    }
    
    const processId = `cron_scrape_${Date.now()}`;
    logger.log('[CRON] Starting nightly full scraping', 'INFO', {
      event: 'cron_scrape_start'
    });
    
    processTracker.start(processId, 'cron_scraping', { pages: 200 });
    LockManager.createLock(scraperLockPath, processId);
    
    const child = spawn('node', ['scraper_componenti_wpai_min.js', '200'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false
    });
    
    processTracker.setPid(processId, child.pid);
    
    child.on('close', (code) => {
      processTracker.end(processId, code === 0 ? 'completed' : 'failed');
      LockManager.removeLock(scraperLockPath);
    });
    
    // Timeout dopo 4 ore
    const timeout = setTimeout(() => {
      try {
        if (child.pid) {
          process.kill(child.pid, 'SIGTERM');
        }
        processTracker.end(processId, 'timeout');
        LockManager.removeLock(scraperLockPath);
        logger.log('[CRON] Scraping timeout after 4 hours', 'WARN');
      } catch (e) {
        logger.log(`[CRON] Timeout kill error: ${e.message}`, 'ERROR');
      }
    }, 4 * 60 * 60 * 1000);
    
    child.on('close', () => clearTimeout(timeout));
  });
  
  // STOCK CHECK DIURNO - Ogni 2.5 ore dalle 7:00 alle 22:00
  const stockSchedule = '0 7,9,12,14,17,19,22 * * *';
  cron.schedule(stockSchedule, () => {
    // Check if stock-checker exists
    if (!fs.existsSync(path.join(__dirname, 'stock-checker-light.js'))) {
      logger.log('[CRON] Stock checker file not found, skipping', 'WARN');
      return;
    }
    
    // Check lock
    if (LockManager.checkLock(stockLockPath)) {
      logger.log('[CRON] Stock check già in corso, skip', 'WARN');
      return;
    }
    
    const processId = `cron_stock_${Date.now()}`;
    logger.log('[CRON] Starting stock check', 'INFO', {
      event: 'cron_stock_start'
    });
    
    processTracker.start(processId, 'cron_stock_check', { count: 5000 });
    LockManager.createLock(stockLockPath, processId);
    
    const child = spawn('node', ['stock-checker-light.js', '5000'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false
    });
    
    processTracker.setPid(processId, child.pid);
    
    child.on('close', (code) => {
      processTracker.end(processId, code === 0 ? 'completed' : 'failed');
      LockManager.removeLock(stockLockPath);
    });
    
    // Timeout dopo 2 ore
    const timeout = setTimeout(() => {
      try {
        if (child.pid) {
          process.kill(child.pid, 'SIGTERM');
        }
        processTracker.end(processId, 'timeout');
        LockManager.removeLock(stockLockPath);
        logger.log('[CRON] Stock check timeout after 2 hours', 'WARN');
      } catch (e) {}
    }, 2 * 60 * 60 * 1000);
    
    child.on('close', () => clearTimeout(timeout));
  });
  
  // BACKUP AUTOMATICO GIORNALIERO
  cron.schedule('0 5 * * *', () => {
    logger.log('[CRON] Creating daily backup', 'INFO', {
      event: 'backup_start'
    });
    
    try {
      const date = new Date().toISOString().split('T')[0];
      const backupPath = path.join(backupDir, `backup_${date}.csv`);
      
      if (fs.existsSync(csvLatestPath)) {
        fs.copyFileSync(csvLatestPath, backupPath);
        logger.log('[CRON] Backup created successfully', 'INFO', {
          event: 'backup_complete',
          file: backupPath
        });
        
        // Rimuovi backup più vecchi di 7 giorni
        const files = fs.readdirSync(backupDir);
        const now = Date.now();
        files.forEach(file => {
          const filePath = path.join(backupDir, file);
          const stats = fs.statSync(filePath);
          const age = now - stats.mtime;
          if (age > 7 * 24 * 60 * 60 * 1000) {
            fs.unlinkSync(filePath);
            logger.log(`[CRON] Removed old backup: ${file}`, 'INFO');
          }
        });
      }
    } catch (error) {
      logger.log('[CRON] Backup failed', 'ERROR', {
        error: error.message
      });
    }
  });
  
  logger.log('⏰ CRON JOBS ATTIVATI:', 'INFO', {
    event: 'cron_initialized',
    jobs: [
      'Scraping completo: 02:00 (max 4h)',
      'Stock check: 07:00, 09:00, 12:00, 14:00, 17:00, 19:00, 22:00 (max 2h)',
      'Backup giornaliero: 05:00'
    ]
  });
  
} else {
  logger.log('⏰ CRON JOBS NON ATTIVATI (development mode)', 'INFO');
}

// =====================================================
// GRACEFUL SHUTDOWN
// =====================================================

process.on('SIGTERM', () => {
  logger.log('SIGTERM received, shutting down gracefully...', 'INFO', {
    event: 'shutdown_start'
  });
  
  // Cleanup locks
  LockManager.removeLock(scraperLockPath);
  LockManager.removeLock(stockLockPath);
  
  setTimeout(() => {
    logger.log('Shutdown complete', 'INFO', {
      event: 'shutdown_complete'
    });
    process.exit(0);
  }, 5000);
});

process.on('uncaughtException', (error) => {
  logger.log('Uncaught exception', 'ERROR', {
    event: 'uncaught_exception',
    error: error.message,
    stack: error.stack
  });
});

process.on('unhandledRejection', (reason, promise) => {
  logger.log('Unhandled rejection', 'ERROR', {
    event: 'unhandled_rejection',
    reason: reason
  });
});

// =====================================================
// SERVER START
// =====================================================

// Ensure directories before starting
ensureDirectories();

app.listen(PORT, () => {
  logger.log('╔══════════════════════════════════════════════╗', 'INFO');
  logger.log('║   SCRAPER SERVER v3.0 FIXED - AVVIATO       ║', 'INFO');
  logger.log('╚══════════════════════════════════════════════╝', 'INFO');
  logger.log(`Server: http://localhost:${PORT}`, 'INFO');
  logger.log(`Environment: ${process.env.NODE_ENV || 'development'}`, 'INFO');
  logger.log(`Render: ${process.env.RENDER ? 'Yes' : 'No'}`, 'INFO');
  logger.log(`Data Directory: ${dataDir}`, 'INFO');
  
  if (process.env.NODE_ENV === 'production' || process.env.RENDER) {
    logger.log('\n⚡ SISTEMA OTTIMIZZATO ATTIVO:', 'INFO');
    logger.log('• Scraping completo: ogni notte ore 2:00 (max 4h)', 'INFO');
    logger.log('• Stock check: ogni 2-3h dalle 7:00 alle 22:00 (max 2h)', 'INFO');
    logger.log('• Backup automatico: ogni giorno ore 5:00', 'INFO');
    logger.log('• Lock management: prevenzione esecuzioni multiple', 'INFO');
    logger.log('• Logging professionale: JSON + Eventi', 'INFO');
    logger.log('• Tracking processi: Real-time monitoring', 'INFO');
  }
});

module.exports = app;
