// server.js - v3.2 NO LOCK + CRON SCHEDULING
// Sistema con scheduling automatico scraping + stock check

const express = require('express');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 10000;

// Configurazione paths
const dataDir = process.env.DATA_DIR || (process.env.RENDER ? '/data' : './data');
const outputDir = path.join(dataDir, 'output');
const logsDir = path.join(dataDir, 'logs');
const backupDir = path.join(dataDir, 'backups');

const csvLatestPath = path.join(outputDir, 'prodotti_latest.csv');
const systemLogPath = path.join(logsDir, 'system.log');
const scraperLogPath = path.join(logsDir, 'scraper.log');
const eventsLogPath = path.join(logsDir, 'events.json');
const scraperEventsPath = path.join(logsDir, 'scraper_events.json');
const scraperProgressPath = path.join(outputDir, 'scraper_progress.json');

// Ensure directories
function ensureDirectories() {
  [dataDir, outputDir, logsDir, backupDir, path.join(outputDir, 'images')].forEach(dir => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      console.log(`✓ Created: ${dir}`);
    }
  });
}

// Logger
class Logger {
  constructor(logFile) {
    this.logFile = logFile;
  }

  log(message, level = 'INFO', metadata = {}) {
    const timestamp = new Date().toISOString();
    const logEntry = { timestamp, level, message, ...metadata };
    console.log(`[${timestamp}] [${level}] ${message}`);
    
    try {
      fs.appendFileSync(this.logFile, JSON.stringify(logEntry) + '\n');
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
        events = JSON.parse(fs.readFileSync(eventsLogPath, 'utf8') || '[]');
      }
      events.unshift(entry);
      events = events.slice(0, 1000);
      fs.writeFileSync(eventsLogPath, JSON.stringify(events, null, 2));
    } catch (e) {}
  }
}

const logger = new Logger(systemLogPath);

// Process tracker
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
      pid: null
    };
    logger.log(`Process started: ${type}`, 'INFO', { event: 'process_start', processId, type });
  },
  
  setPid(processId, pid) {
    if (this.running[processId]) this.running[processId].pid = pid;
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
      logger.log(`Process ended: ${process.type}`, 'INFO', { event: 'process_end', processId, status });
    }
  },
  
  getRunning() { return Object.values(this.running); },
  getHistory() { return this.history; }
};

// Middleware
app.use(express.json());
app.use('/output', express.static(outputDir));
app.use('/logs', express.static(logsDir));
app.use('/backups', express.static(backupDir));

// Helper
function getPublicUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`;
  return `${proto}://${host}`;
}

// API Endpoints
app.get('/healthz', (req, res) => {
  res.status(200).json({ status: 'healthy', uptime: process.uptime() });
});

app.get('/api/stats', (req, res) => {
  res.json(getSystemStats());
});

app.get('/api/processes', (req, res) => {
  res.json({
    running: processTracker.getRunning(),
    history: processTracker.getHistory()
  });
});

// NEW: Scraper events endpoint
app.get('/api/scraper/events', (req, res) => {
  try {
    if (fs.existsSync(scraperEventsPath)) {
      const events = JSON.parse(fs.readFileSync(scraperEventsPath, 'utf8') || '[]');
      res.json({ events: events.slice(0, 100) });
    } else {
      res.json({ events: [] });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// NEW: Scraper progress endpoint
app.get('/api/scraper/progress', (req, res) => {
  try {
    if (fs.existsSync(scraperProgressPath)) {
      const progress = JSON.parse(fs.readFileSync(scraperProgressPath, 'utf8'));
      res.json(progress);
    } else {
      res.json({ status: 'idle' });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/scrape', async (req, res) => {
  const pages = parseInt(req.body.pages) || 20;
  const processId = `manual_scrape_${Date.now()}`;
  
  processTracker.start(processId, 'manual_scraping', { pages });
  
  const child = spawn('node', ['scraper_componenti_wpai_min.js', pages.toString()], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false
  });
  
  processTracker.setPid(processId, child.pid);
  
  child.on('close', (code) => {
    processTracker.end(processId, code === 0 ? 'completed' : 'failed', { exitCode: code });
  });
  
  const timeout = setTimeout(() => {
    if (child.pid) {
      try { process.kill(child.pid, 'SIGTERM'); } catch (e) {}
    }
  }, 4 * 60 * 60 * 1000);
  
  child.on('close', () => clearTimeout(timeout));
  
  res.json({ success: true, processId, message: `Scraping avviato (${pages} pagine)` });
});

app.get('/api/download-csv', (req, res) => {
  if (!fs.existsSync(csvLatestPath)) {
    return res.status(404).json({ error: 'CSV non trovato' });
  }
  res.download(csvLatestPath, 'prodotti_componenti.csv');
});

// Dashboard with live scraper events
app.get('/', (req, res) => {
  const stats = getSystemStats();
  const baseUrl = getPublicUrl(req);
  
  res.send(`
<!DOCTYPE html>
<html lang="it">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Scraper CD - Dashboard v3.2 CRON</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { 
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      padding: 20px;
    }
    .container { max-width: 1600px; margin: 0 auto; }
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
      color: #fff; 
      background: linear-gradient(135deg, #667eea, #764ba2);
      padding: 4px 12px; 
      border-radius: 4px;
      font-weight: normal;
    }
    .cron-info {
      background: #e6fffa;
      border-left: 4px solid #38b2ac;
      padding: 12px;
      margin-top: 15px;
      border-radius: 4px;
      font-size: 0.9em;
      color: #234e52;
    }
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
    }
    .card h2 { 
      color: #333; 
      margin-bottom: 15px; 
      font-size: 1.1em;
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
    .event-viewer {
      background: #1a202c;
      color: #a0aec0;
      padding: 15px;
      border-radius: 6px;
      font-family: 'Courier New', monospace;
      font-size: 12px;
      max-height: 500px;
      overflow-y: auto;
    }
    .event-item {
      padding: 8px;
      margin: 4px 0;
      border-left: 3px solid #4299e1;
      background: rgba(255,255,255,0.05);
      border-radius: 4px;
    }
    .event-item.ERROR { border-left-color: #f56565; }
    .event-item.WARN { border-left-color: #ed8936; }
    .event-item.SUCCESS { border-left-color: #48bb78; }
    .event-item.INFO { border-left-color: #4299e1; }
    .event-item.DEBUG { border-left-color: #718096; }
    .progress-bar {
      width: 100%;
      height: 30px;
      background: #edf2f7;
      border-radius: 15px;
      overflow: hidden;
      position: relative;
    }
    .progress-fill {
      height: 100%;
      background: linear-gradient(90deg, #667eea, #764ba2);
      transition: width 0.5s;
      display: flex;
      align-items: center;
      justify-content: center;
      color: white;
      font-weight: bold;
      font-size: 14px;
    }
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 15px;
      margin-top: 15px;
    }
    .stat-box {
      background: #f7fafc;
      padding: 15px;
      border-radius: 8px;
      text-align: center;
    }
    .stat-value {
      font-size: 2em;
      font-weight: bold;
      color: #667eea;
    }
    .stat-label {
      font-size: 0.9em;
      color: #666;
      margin-top: 5px;
    }
    .badge {
      display: inline-block;
      padding: 4px 12px;
      border-radius: 12px;
      font-size: 12px;
      font-weight: 600;
      margin-left: 10px;
    }
    .badge-success { background: #c6f6d5; color: #22543d; }
    .badge-running { background: #bee3f8; color: #2c5282; animation: pulse 2s infinite; }
    .badge-idle { background: #e2e8f0; color: #4a5568; }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.6; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>
        🔧 Scraper Componenti Digitali
        <span class="version">v3.2 CRON ENABLED</span>
      </h1>
      <p style="color: #666; margin-top: 10px;">
        Dashboard con scheduling automatico e monitoraggio real-time
      </p>
      <div class="cron-info">
        <strong>⏰ Scheduling Automatico Attivo:</strong><br>
        🔄 Scraping completo: Ogni notte alle 02:00<br>
        📊 Stock check: 4x/giorno alle 07:00, 12:00, 17:00, 22:00
      </div>
    </div>

    <div class="grid">
      <div class="card">
        <h2>📦 Prodotti Totali</h2>
        <div class="metric">${stats.totalProducts.toLocaleString()}</div>
        <div class="metric-label">Prodotti catalogati</div>
      </div>

      <div class="card">
        <h2>🕒 Ultimo Aggiornamento</h2>
        <div class="metric" style="font-size: 1.5em;">${stats.lastUpdate.time}</div>
        <div class="metric-label">${stats.lastUpdate.ago}</div>
      </div>

      <div class="card">
        <h2>📊 Dimensione CSV</h2>
        <div class="metric">${stats.csvSize} MB</div>
        <div class="metric-label">File dati</div>
      </div>

      <div class="card">
        <h2>🖼️ Immagini</h2>
        <div class="metric">${stats.imagesCount.toLocaleString()}</div>
        <div class="metric-label">Scaricate</div>
      </div>
    </div>

    <div class="action-section">
      <h2 style="margin-bottom: 15px;">⚡ Azioni Manuali (oltre allo scheduling automatico)</h2>
      <div class="button-group">
        <button class="btn btn-primary" onclick="startScraping(5)">
          🔄 Test (5 pagine)
        </button>
        <button class="btn btn-primary" onclick="startScraping(20)">
          🔄 Medio (20 pagine)
        </button>
        <button class="btn btn-primary" onclick="startScraping(200)">
          🔄 Completo (200 pagine)
        </button>
        <a href="/api/download-csv" class="btn btn-secondary">
          ⬇️ Scarica CSV
        </a>
        <button class="btn btn-secondary" onclick="location.reload()">
          🔄 Refresh Dashboard
        </button>
      </div>
    </div>

    <div class="action-section">
      <h2>
        📊 Scraper Status
        <span class="badge badge-idle" id="scraperStatus">IDLE</span>
      </h2>
      
      <div id="progressSection" style="display: none; margin-top: 15px;">
        <div class="progress-bar">
          <div class="progress-fill" id="progressBar" style="width: 0%;">0%</div>
        </div>
        
        <div class="stats-grid" id="statsGrid">
          <div class="stat-box">
            <div class="stat-value" id="statPages">0</div>
            <div class="stat-label">Pagine</div>
          </div>
          <div class="stat-box">
            <div class="stat-value" id="statProducts">0</div>
            <div class="stat-label">Prodotti</div>
          </div>
          <div class="stat-box">
            <div class="stat-value" id="statImages">0</div>
            <div class="stat-label">Immagini</div>
          </div>
          <div class="stat-box">
            <div class="stat-value" id="statDuration">0m</div>
            <div class="stat-label">Durata</div>
          </div>
        </div>
      </div>
    </div>

    <div class="action-section">
      <h2 style="margin-bottom: 15px;">📝 Eventi Scraper (Live)
        <button class="btn btn-secondary" onclick="refreshEvents()" style="float: right; padding: 6px 12px; font-size: 14px;">
          🔄 Refresh Eventi
        </button>
      </h2>
      <div class="event-viewer" id="eventViewer">
        <div style="text-align: center; color: #718096;">Caricamento eventi...</div>
      </div>
    </div>
  </div>

  <script>
    async function startScraping(pages) {
      if (!confirm(\`Avviare scraping manuale di \${pages} pagine?\`)) return;
      
      try {
        const response = await fetch('/api/scrape', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pages })
        });
        
        const data = await response.json();
        
        if (response.ok) {
          alert('✓ Scraping manuale avviato!');
          startMonitoring();
        } else {
          alert('✗ Errore: ' + (data.message || data.error));
        }
      } catch (error) {
        alert('✗ Errore: ' + error.message);
      }
    }
    
    async function refreshEvents() {
      try {
        const response = await fetch('/api/scraper/events');
        const data = await response.json();
        
        const viewer = document.getElementById('eventViewer');
        if (data.events && data.events.length > 0) {
          viewer.innerHTML = data.events.map(e => \`
            <div class="event-item \${e.level || 'INFO'}">
              <strong>[\${e.level || 'INFO'}]</strong> 
              <span style="color: #718096;">\${new Date(e.timestamp).toLocaleTimeString('it-IT')}</span> - 
              \${e.message}
              \${e.stats ? \` <span style="color: #48bb78;">(Page: \${e.stats.currentPage || 0})</span>\` : ''}
            </div>
          \`).join('');
        } else {
          viewer.innerHTML = '<div style="text-align: center; color: #718096;">Nessun evento registrato</div>';
        }
        
        viewer.scrollTop = 0;
      } catch (error) {
        console.error('Error refreshing events:', error);
      }
    }
    
    async function checkProgress() {
      try {
        const response = await fetch('/api/scraper/progress');
        const progress = await response.json();
        
        if (progress.status === 'running' || progress.stats) {
          document.getElementById('scraperStatus').className = 'badge badge-running';
          document.getElementById('scraperStatus').textContent = 'RUNNING';
          document.getElementById('progressSection').style.display = 'block';
          
          if (progress.stats) {
            const pct = Math.round((progress.currentPage / (progress.stats.maxPages || 200)) * 100);
            document.getElementById('progressBar').style.width = pct + '%';
            document.getElementById('progressBar').textContent = pct + '%';
            
            document.getElementById('statPages').textContent = progress.currentPage || 0;
            document.getElementById('statProducts').textContent = progress.productsCount || 0;
            document.getElementById('statImages').textContent = progress.stats.imagesDownloaded || 0;
            
            const duration = Math.round((Date.now() - progress.stats.startTime) / 60000);
            document.getElementById('statDuration').textContent = duration + 'm';
          }
        } else {
          document.getElementById('scraperStatus').className = 'badge badge-idle';
          document.getElementById('scraperStatus').textContent = 'IDLE';
          document.getElementById('progressSection').style.display = 'none';
        }
      } catch (error) {
        console.error('Error checking progress:', error);
      }
    }
    
    function startMonitoring() {
      refreshEvents();
      checkProgress();
      
      const interval = setInterval(() => {
        refreshEvents();
        checkProgress();
      }, 5000);
      
      setTimeout(() => {
        fetch('/api/scraper/progress')
          .then(r => r.json())
          .then(p => {
            if (p.status !== 'running') {
              clearInterval(interval);
            }
          });
      }, 10 * 60 * 1000);
    }
    
    refreshEvents();
    checkProgress();
    setInterval(refreshEvents, 10000);
    setInterval(checkProgress, 5000);
  </script>
</body>
</html>
  `);
});

// Helper functions
function getSystemStats() {
  const stats = {
    totalProducts: 0,
    lastUpdate: { time: 'Mai', ago: 'N/A' },
    csvSize: 0,
    imagesCount: 0,
    runningProcesses: [],
    activeProcesses: 0
  };
  
  try {
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
    
    const imagesPath = path.join(outputDir, 'images');
    if (fs.existsSync(imagesPath)) {
      const images = fs.readdirSync(imagesPath);
      stats.imagesCount = images.filter(f => /\.(jpg|jpeg|png)$/i.test(f)).length;
    }
    
    stats.runningProcesses = processTracker.getRunning();
    stats.activeProcesses = stats.runningProcesses.length;
    
  } catch (error) {
    logger.log('Error getting stats', 'ERROR', { error: error.message });
  }
  
  return stats;
}

function formatUptime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  
  if (days > 0) return `${days}g ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

// CRON SCHEDULING - SEMPRE ATTIVO
if (process.env.ENABLE_CRON === 'true') {
  // SCRAPING COMPLETO - Ogni notte alle 2 AM
  cron.schedule('0 2 * * *', () => {
    const processId = `cron_scrape_${Date.now()}`;
    logger.log('[CRON] Starting nightly scraping (200 pages)', 'INFO');
    processTracker.start(processId, 'cron_scraping', { pages: 200 });
    
    const child = spawn('node', ['scraper_componenti_wpai_min.js', '200'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false
    });
    
    processTracker.setPid(processId, child.pid);
    child.on('close', (code) => {
      processTracker.end(processId, code === 0 ? 'completed' : 'failed');
      logger.log(`[CRON] Nightly scraping ${code === 0 ? 'completed' : 'failed'}`, code === 0 ? 'INFO' : 'ERROR');
    });
  });
  
  // STOCK CHECK - 4 volte al giorno (7, 12, 17, 22)
  cron.schedule('0 7,12,17,22 * * *', () => {
    const processId = `cron_stock_${Date.now()}`;
    const hour = new Date().getHours();
    logger.log(`[CRON] Starting stock check (${hour}:00)`, 'INFO');
    processTracker.start(processId, 'cron_stock_check', { products: 'all' });
    
    const child = spawn('node', ['stock-checker-light.js', '5000'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false
    });
    
    processTracker.setPid(processId, child.pid);
    child.on('close', (code) => {
      processTracker.end(processId, code === 0 ? 'completed' : 'failed');
      logger.log(`[CRON] Stock check ${code === 0 ? 'completed' : 'failed'}`, code === 0 ? 'INFO' : 'ERROR');
    });
  });
  
  logger.log('⏰ CRON ENABLED - Scraping: 2AM daily | Stock: 7,12,17,22 daily', 'INFO');
} else {
  logger.log('⏰ CRON DISABLED (set ENABLE_CRON=true to activate)', 'INFO');
}

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.log('SIGTERM - shutting down', 'INFO');
  setTimeout(() => process.exit(0), 5000);
});

// Start
ensureDirectories();

app.listen(PORT, () => {
  logger.log('╔════════════════════════════════════════╗', 'INFO');
  logger.log('║   SCRAPER SERVER v3.2 CRON MODE       ║', 'INFO');
  logger.log('╚════════════════════════════════════════╝', 'INFO');
  logger.log(`Server: http://localhost:${PORT}`, 'INFO');
  logger.log(`Environment: ${process.env.NODE_ENV || 'development'}`, 'INFO');
  logger.log(`Data Directory: ${dataDir}`, 'INFO');
  logger.log(`CRON Status: ${process.env.ENABLE_CRON === 'true' ? 'ENABLED' : 'DISABLED'}`, 'INFO');
});

module.exports = app;
