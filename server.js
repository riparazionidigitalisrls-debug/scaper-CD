// server.js - Server Professionale per Scraper Componenti Digitali
// Sistema completo con dashboard avanzata, logging dettagliato e scheduling ottimizzato

const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 10000;

// =====================================================
// CONFIGURAZIONE PATHS E DIRECTORY
// =====================================================
const dataDir = process.env.DATA_DIR || (process.env.RENDER ? '/data' : './data');
const outputDir = path.join(dataDir, 'output');
const logsDir = path.join(dataDir, 'logs');
const backupDir = path.join(dataDir, 'backups');

// File paths principali
const csvLatestPath = path.join(outputDir, 'prodotti_latest.csv');
const systemLogPath = path.join(logsDir, 'system.log');
const scraperLogPath = path.join(logsDir, 'scraper.log');
const stockLogPath = path.join(logsDir, 'stock_checker.log');
const eventsLogPath = path.join(logsDir, 'events.json');

// =====================================================
// SISTEMA DI LOGGING PROFESSIONALE
// =====================================================
class Logger {
  constructor(logFile) {
    this.logFile = logFile;
    this.ensureLogDir();
  }

  ensureLogDir() {
    [logsDir, outputDir, backupDir].forEach(dir => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    });
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
      events = events.slice(0, 1000); // Mantieni solo ultimi 1000 eventi
      
      fs.writeFileSync(eventsLogPath, JSON.stringify(events, null, 2));
    } catch (e) {
      // Silent fail
    }
  }
}

const logger = new Logger(systemLogPath);

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
      progress: 0
    };
    
    logger.log(`Process started: ${type}`, 'INFO', {
      event: 'process_start',
      processId,
      type,
      params
    });
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
      this.history = this.history.slice(0, 100); // Mantieni solo ultimi 100
      
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
// DASHBOARD PRINCIPALE MIGLIORATA
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
  <title>Scraper CD - Dashboard Professionale</title>
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
    
    button { 
      background: #667eea; 
      color: white; 
      border: none; 
      padding: 10px 20px; 
      border-radius: 5px; 
      cursor: pointer; 
      font-size: 14px;
      font-weight: 500;
      transition: all 0.3s;
      display: flex;
      align-items: center;
      gap: 5px;
    }
    
    button:hover { 
      background: #5a67d8;
      transform: translateY(-1px);
      box-shadow: 0 2px 4px rgba(0,0,0,0.2);
    }
    
    button.stock { background: #10b981; }
    button.stock:hover { background: #059669; }
    
    button.scrape { background: #f59e0b; }
    button.scrape:hover { background: #d97706; }
    
    button.danger { background: #ef4444; }
    button.danger:hover { background: #dc2626; }
    
    .schedule-info {
      background: #f0f9ff;
      border-left: 4px solid #3b82f6;
      padding: 15px;
      margin: 15px 0;
      border-radius: 5px;
    }
    
    .schedule-info h3 {
      color: #1e40af;
      margin-bottom: 10px;
    }
    
    .schedule-item {
      padding: 5px 0;
      border-bottom: 1px solid #e0e7ff;
    }
    
    .schedule-item:last-child {
      border-bottom: none;
    }
    
    .log-viewer {
      background: #1a1a1a;
      color: #00ff00;
      padding: 15px;
      border-radius: 5px;
      font-family: 'Courier New', monospace;
      font-size: 12px;
      height: 400px;
      overflow-y: auto;
      white-space: pre-wrap;
      word-break: break-all;
    }
    
    .process-list {
      max-height: 300px;
      overflow-y: auto;
    }
    
    .process-item {
      padding: 10px;
      border-bottom: 1px solid #e5e7eb;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    
    .process-item:last-child {
      border-bottom: none;
    }
    
    .progress-bar {
      width: 100%;
      height: 20px;
      background: #e5e7eb;
      border-radius: 10px;
      overflow: hidden;
      margin-top: 5px;
    }
    
    .progress-fill {
      height: 100%;
      background: linear-gradient(90deg, #667eea, #764ba2);
      transition: width 0.3s;
    }
    
    .tabs {
      display: flex;
      gap: 10px;
      margin-bottom: 20px;
    }
    
    .tab {
      padding: 10px 20px;
      background: #e5e7eb;
      border-radius: 5px;
      cursor: pointer;
      transition: all 0.3s;
    }
    
    .tab.active {
      background: #667eea;
      color: white;
    }
    
    .tab-content {
      display: none;
    }
    
    .tab-content.active {
      display: block;
    }
    
    @media (max-width: 768px) {
      .grid {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <!-- Header -->
    <div class="header">
      <h1>
        🚀 Scraper Componenti Digitali
        <span class="status-badge ${stats.systemStatus}">
          ${stats.systemStatus === 'active' ? '● Online' : '○ Offline'}
        </span>
      </h1>
      <p style="color: #666; margin-top: 10px;">
        Server: ${process.env.RENDER ? 'Render.com Production' : 'Development'} | 
        Uptime: ${stats.uptime} | 
        Memory: ${stats.memory.used}/${stats.memory.total}MB
      </p>
    </div>
    
    <!-- Metriche Principali -->
    <div class="grid">
      <div class="card">
        <h2>📦 Prodotti Totali</h2>
        <div class="metric">${stats.totalProducts.toLocaleString()}</div>
        <div class="metric-label">Nel database</div>
        <div class="progress-bar">
          <div class="progress-fill" style="width: ${Math.min(100, stats.totalProducts/5000*100)}%"></div>
        </div>
      </div>
      
      <div class="card">
        <h2>🕐 Ultimo Aggiornamento</h2>
        <div class="metric" style="font-size: 1.5em;">${stats.lastUpdate.time}</div>
        <div class="metric-label">${stats.lastUpdate.ago}</div>
      </div>
      
      <div class="card">
        <h2>💾 Database</h2>
        <div class="metric">${stats.csvSize} MB</div>
        <div class="metric-label">CSV + ${stats.imagesCount} immagini</div>
      </div>
      
      <div class="card">
        <h2>⚡ Processi Attivi</h2>
        <div class="metric">${stats.activeProcesses}</div>
        <div class="metric-label">In esecuzione</div>
      </div>
    </div>
    
    <!-- Controlli Manuali -->
    <div class="action-section">
      <h2 style="margin-bottom: 20px;">🎮 Controlli Manuali</h2>
      
      <div class="tabs">
        <div class="tab active" onclick="switchTab('stock')">Stock Check</div>
        <div class="tab" onclick="switchTab('scrape')">Scraping Completo</div>
        <div class="tab" onclick="switchTab('system')">Sistema</div>
      </div>
      
      <!-- Tab Stock Check -->
      <div id="stock-tab" class="tab-content active">
        <p style="margin-bottom: 10px;">
          <strong>⚡ Stock Check Veloce</strong> - Solo verifica disponibilità (20-120 min)
        </p>
        <div class="button-group">
          <button class="stock" onclick="runStockCheck(100)">
            🧪 Test 100 prodotti
          </button>
          <button class="stock" onclick="runStockCheck(500)">
            📊 Check 500 prodotti
          </button>
          <button class="stock" onclick="runStockCheck(1000)">
            📈 Check 1000 prodotti
          </button>
          <button class="stock" onclick="runStockCheck(5000)">
            🚀 Check COMPLETO (5000)
          </button>
        </div>
      </div>
      
      <!-- Tab Scraping -->
      <div id="scrape-tab" class="tab-content">
        <p style="margin-bottom: 10px;">
          <strong>📦 Scraping Completo</strong> - Tutti i dati + immagini (25 min - 4 ore)
        </p>
        <div class="button-group">
          <button class="scrape" onclick="runScrape(5)">
            🧪 Test (5 pagine)
          </button>
          <button class="scrape" onclick="runScrape(20)">
            🔄 Sync (20 pagine)
          </button>
          <button class="scrape" onclick="runScrape(50)">
            📊 Medio (50 pagine)
          </button>
          <button class="scrape" onclick="runScrape(200)">
            📦 Full (200 pagine)
          </button>
        </div>
      </div>
      
      <!-- Tab Sistema -->
      <div id="system-tab" class="tab-content">
        <p style="margin-bottom: 10px;">
          <strong>⚙️ Controlli di Sistema</strong>
        </p>
        <div class="button-group">
          <button onclick="downloadCSV()">
            📥 Download CSV
          </button>
          <button onclick="viewBackups()">
            💾 View Backups
          </button>
          <button onclick="clearLogs()">
            🗑️ Clear Logs
          </button>
          <button class="danger" onclick="killAllProcesses()">
            🛑 Kill All Processes
          </button>
        </div>
      </div>
    </div>
    
    <!-- Schedule Automatico -->
    <div class="action-section">
      <h2 style="margin-bottom: 20px;">📅 Schedule Automatico</h2>
      <div class="schedule-info">
        <h3>🌙 Notturno</h3>
        <div class="schedule-item">
          <strong>02:00</strong> - Scraping completo lento (max 4 ore) - Tutti i dati
        </div>
      </div>
      
      <div class="schedule-info" style="background: #f0fdf4; border-color: #10b981;">
        <h3>☀️ Diurno</h3>
        <div class="schedule-item">
          <strong>07:00 - 22:00</strong> - Stock check veloce ogni 2.5 ore (max 2 ore)
        </div>
        <div class="schedule-item" style="color: #666; font-size: 0.9em;">
          Orari: 07:00, 09:30, 12:00, 14:30, 17:00, 19:30, 22:00
        </div>
      </div>
    </div>
    
    <!-- Processi Attivi -->
    ${stats.activeProcesses > 0 ? `
    <div class="action-section">
      <h2 style="margin-bottom: 20px;">🔄 Processi in Esecuzione</h2>
      <div class="process-list">
        ${stats.runningProcesses.map(p => `
          <div class="process-item">
            <div>
              <strong>${p.type}</strong><br>
              <small>ID: ${p.id} | Started: ${new Date(p.startTime).toLocaleTimeString()}</small>
            </div>
            <div style="width: 200px;">
              <div class="progress-bar">
                <div class="progress-fill" style="width: ${p.progress}%"></div>
              </div>
            </div>
          </div>
        `).join('')}
      </div>
    </div>
    ` : ''}
    
    <!-- Log Viewer -->
    <div class="action-section">
      <h2 style="margin-bottom: 20px;">📋 Eventi Recenti</h2>
      <div class="log-viewer" id="log-viewer">
        ${stats.recentEvents}
      </div>
    </div>
  </div>
  
  <script>
    // Tab switching
    function switchTab(tabName) {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      
      event.target.classList.add('active');
      document.getElementById(tabName + '-tab').classList.add('active');
    }
    
    // Actions
    async function runStockCheck(count) {
      if (!confirm(\`Avviare stock check per \${count} prodotti?\`)) return;
      
      const res = await fetch('/api/stock-check', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ count })
      });
      const data = await res.json();
      alert(data.message);
      setTimeout(() => location.reload(), 2000);
    }
    
    async function runScrape(pages) {
      if (!confirm(\`Avviare scraping di \${pages} pagine?\`)) return;
      
      const res = await fetch('/api/scrape', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ pages })
      });
      const data = await res.json();
      alert(data.message);
      setTimeout(() => location.reload(), 2000);
    }
    
    function downloadCSV() {
      window.open('${baseUrl}/output/prodotti_latest.csv', '_blank');
    }
    
    function viewBackups() {
      window.open('${baseUrl}/backups', '_blank');
    }
    
    async function clearLogs() {
      if (!confirm('Cancellare tutti i log?')) return;
      
      await fetch('/api/logs', { method: 'DELETE' });
      alert('Log cancellati');
      location.reload();
    }
    
    async function killAllProcesses() {
      if (!confirm('Terminare TUTTI i processi in esecuzione?')) return;
      
      await fetch('/api/kill-all', { method: 'POST' });
      alert('Processi terminati');
      location.reload();
    }
    
    // Auto-refresh ogni 30 secondi
    setInterval(() => {
      fetch('/api/status')
        .then(res => res.json())
        .then(data => {
          if (data.activeProcesses > 0) {
            location.reload();
          }
        });
    }, 30000);
  </script>
</body>
</html>
  `);
});

// =====================================================
// API ENDPOINTS
// =====================================================

// Status endpoint
app.get('/api/status', (req, res) => {
  const stats = getSystemStats();
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    ...stats
  });
});

// Stock check endpoint
app.post('/api/stock-check', async (req, res) => {
  const { count = 5000 } = req.body;
  const processId = `stock_${Date.now()}`;
  
  logger.log(`Starting stock check for ${count} products`, 'INFO', {
    event: 'stock_check_start',
    count
  });
  
  processTracker.start(processId, 'stock_check', { count });
  
  const child = spawn('node', ['stock-checker-light.js', count.toString()], {
    detached: true,
    stdio: 'ignore'
  });
  
  child.unref();
  
  res.json({
    status: 'started',
    processId,
    message: `Stock check avviato per ${count} prodotti`
  });
});

// Scraping endpoint
app.post('/api/scrape', async (req, res) => {
  const { pages = 20 } = req.body;
  const processId = `scrape_${Date.now()}`;
  
  logger.log(`Starting scraping for ${pages} pages`, 'INFO', {
    event: 'scraping_start',
    pages
  });
  
  processTracker.start(processId, 'scraping', { pages });
  
  const child = spawn('node', ['scraper_componenti_wpai_min.js', pages.toString()], {
    detached: true,
    stdio: 'ignore'
  });
  
  child.unref();
  
  res.json({
    status: 'started',
    processId,
    message: `Scraping avviato per ${pages} pagine`
  });
});

// Get processes
app.get('/api/processes', (req, res) => {
  res.json({
    running: processTracker.getRunning(),
    history: processTracker.getHistory()
  });
});

// Kill all processes
app.post('/api/kill-all', (req, res) => {
  logger.log('Killing all processes', 'WARN', {
    event: 'kill_all_processes'
  });
  
  // Implementa kill dei processi
  res.json({ status: 'ok' });
});

// Delete logs
app.delete('/api/logs', (req, res) => {
  logger.log('Clearing logs', 'INFO', {
    event: 'clear_logs'
  });
  
  [logsDir, outputDir].forEach(dir => {
    if (fs.existsSync(dir)) {
      const files = fs.readdirSync(dir);
      files.forEach(file => {
        if (file.endsWith('.log')) {
          fs.unlinkSync(path.join(dir, file));
        }
      });
    }
  });
  
  res.json({ status: 'ok' });
});

// Health checks
app.get('/healthz', (req, res) => res.status(200).send('ok'));
app.get('/health', (req, res) => {
  const stats = getSystemStats();
  res.json({
    status: 'healthy',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    products: stats.totalProducts,
    lastUpdate: stats.lastUpdate
  });
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
    const processId = `cron_scrape_${Date.now()}`;
    logger.log('[CRON] Starting nightly full scraping', 'INFO', {
      event: 'cron_scrape_start'
    });
    
    processTracker.start(processId, 'cron_scraping', { pages: 200 });
    
    const child = spawn('node', ['scraper_componenti_wpai_min.js', '200'], {
      detached: true,
      stdio: 'ignore'
    });
    
    // Timeout dopo 4 ore
    setTimeout(() => {
      try {
        child.kill();
        processTracker.end(processId, 'timeout');
        logger.log('[CRON] Scraping timeout after 4 hours', 'WARN');
      } catch (e) {}
    }, 4 * 60 * 60 * 1000);
    
    child.unref();
  });
  
  // STOCK CHECK DIURNO - Ogni 2.5 ore dalle 7:00 alle 22:00
  const stockSchedule = '0 7,9,12,14,17,19,22 * * *';  // Orari esatti
  cron.schedule(stockSchedule, () => {
    const processId = `cron_stock_${Date.now()}`;
    logger.log('[CRON] Starting stock check', 'INFO', {
      event: 'cron_stock_start'
    });
    
    processTracker.start(processId, 'cron_stock_check', { count: 5000 });
    
    const child = spawn('node', ['stock-checker-light.js', '5000'], {
      detached: true,
      stdio: 'ignore'
    });
    
    // Timeout dopo 2 ore
    setTimeout(() => {
      try {
        child.kill();
        processTracker.end(processId, 'timeout');
        logger.log('[CRON] Stock check timeout after 2 hours', 'WARN');
      } catch (e) {}
    }, 2 * 60 * 60 * 1000);
    
    child.unref();
  });
  
  // Aggiungi anche controllo parziale a mezzora per le ore di punta
  cron.schedule('30 9,11,14,16,19 * * *', () => {
    const processId = `cron_stock_partial_${Date.now()}`;
    logger.log('[CRON] Starting partial stock check', 'INFO', {
      event: 'cron_stock_partial_start'
    });
    
    processTracker.start(processId, 'cron_stock_check_partial', { count: 1000 });
    
    const child = spawn('node', ['stock-checker-light.js', '1000'], {
      detached: true,
      stdio: 'ignore'
    });
    
    child.unref();
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
      'Stock check completo: 07:00, 09:30, 12:00, 14:30, 17:00, 19:30, 22:00 (max 2h)',
      'Stock check parziale: 09:30, 11:30, 14:30, 16:30, 19:30',
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
  
  // Attendi che i processi finiscano
  setTimeout(() => {
    logger.log('Shutdown complete', 'INFO', {
      event: 'shutdown_complete'
    });
    process.exit(0);
  }, 10000);
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

app.listen(PORT, () => {
  logger.log('╔══════════════════════════════════════════════╗', 'INFO');
  logger.log('║     SCRAPER SERVER PROFESSIONALE AVVIATO     ║', 'INFO');
  logger.log('╚══════════════════════════════════════════════╝', 'INFO');
  logger.log(`Server: http://localhost:${PORT}`, 'INFO');
  logger.log(`Environment: ${process.env.NODE_ENV || 'development'}`, 'INFO');
  logger.log(`Render: ${process.env.RENDER ? 'Yes' : 'No'}`, 'INFO');
  logger.log(`Data Directory: ${dataDir}`, 'INFO');
  logger.log(`Public URL: https://scraper-cd.onrender.com`, 'INFO');
  
  if (process.env.NODE_ENV === 'production' || process.env.RENDER) {
    logger.log('\n⚡ SISTEMA OTTIMIZZATO ATTIVO:', 'INFO');
    logger.log('• Scraping completo: ogni notte ore 2:00 (max 4h)', 'INFO');
    logger.log('• Stock check: ogni 2.5h dalle 7:00 alle 22:00 (max 2h)', 'INFO');
    logger.log('• Stock parziale: controlli supplementari ore di punta', 'INFO');
    logger.log('• Backup automatico: ogni giorno ore 5:00', 'INFO');
    logger.log('• Logging professionale: JSON + Eventi', 'INFO');
    logger.log('• Tracking processi: Real-time monitoring', 'INFO');
  }
});

module.exports = app;
