// server.js - v3.3 FINAL - Dashboard + CRON + Logging completo
const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 10000;

// Paths - DISK PERSISTENTE
const dataDir = process.env.DATA_DIR || (process.env.RENDER ? '/data' : './data');
const outputDir = path.join(dataDir, 'output');
const logsDir = path.join(dataDir, 'logs');
const imagesDir = path.join(outputDir, 'images');

const csvPath = path.join(outputDir, 'prodotti_latest.csv');
const scraperLogPath = path.join(logsDir, 'scraper.log');
const scraperEventsPath = path.join(logsDir, 'scraper_events.json');
const scraperProgressPath = path.join(outputDir, 'scraper_progress.json');

// Middleware
app.use(express.json());
app.use('/output', express.static(outputDir));
app.use('/images', express.static(imagesDir));

// Logger
class Logger {
  constructor(logFile) {
    this.logFile = logFile;
  }
  
  log(message, level = 'INFO') {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] [${level}] ${message}`;
    console.log(line);
    try {
      fs.appendFileSync(this.logFile, line + '\n');
    } catch (e) {}
  }
}

const logger = new Logger(path.join(logsDir, 'system.log'));

// Helper
function getPublicUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`;
  return `${proto}://${host}`;
}

// Stats helper
function getSystemStats() {
  const stats = {
    totalProducts: 0,
    lastUpdate: { time: 'Mai', ago: 'N/A' },
    csvSize: 0,
    imagesCount: 0
  };
  
  try {
    if (fs.existsSync(csvPath)) {
      const csvStats = fs.statSync(csvPath);
      const csvContent = fs.readFileSync(csvPath, 'utf8');
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
    
    if (fs.existsSync(imagesDir)) {
      const images = fs.readdirSync(imagesDir);
      stats.imagesCount = images.filter(f => /\.(jpg|jpeg|png)$/i.test(f)).length;
    }
  } catch (error) {
    logger.log('Error getting stats: ' + error.message, 'ERROR');
  }
  
  return stats;
}

// API: Scraper events (per dashboard real-time)
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

// API: Scraper progress
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

// API: Avvia scraping
app.post('/api/scrape', (req, res) => {
  const pages = parseInt(req.body.pages) || 20;
  
  logger.log(`Starting manual scrape: ${pages} pages`, 'INFO');
  
  const child = spawn('node', ['scraper_componenti_wpai_min.js', pages.toString()], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false
  });
  
  child.stdout.on('data', (data) => logger.log(`[SCRAPER] ${data}`, 'INFO'));
  child.stderr.on('data', (data) => logger.log(`[SCRAPER ERROR] ${data}`, 'ERROR'));
  
  res.json({ 
    success: true, 
    pages, 
    pid: child.pid,
    message: `Scraping avviato (${pages} pagine)` 
  });
});

// API: Download CSV
app.get('/api/download-csv', (req, res) => {
  if (!fs.existsSync(csvPath)) {
    return res.status(404).json({ error: 'CSV non trovato' });
  }
  res.download(csvPath, 'prodotti_componenti.csv');
});

// API: Stats
app.get('/api/stats', (req, res) => {
  res.json(getSystemStats());
});

// Health check
app.get('/healthz', (req, res) => {
  res.status(200).json({ status: 'healthy', uptime: process.uptime() });
});

// Dashboard HTML
app.get('/', (req, res) => {
  const stats = getSystemStats();
  const baseUrl = getPublicUrl(req);
  const cronEnabled = process.env.ENABLE_CRON === 'true';
  
  res.send(`
<!DOCTYPE html>
<html lang="it">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Scraper CD - Dashboard v3.3</title>
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
      background: ${cronEnabled ? '#e6fffa' : '#fff5f5'};
      border-left: 4px solid ${cronEnabled ? '#38b2ac' : '#fc8181'};
      padding: 12px;
      margin-top: 15px;
      border-radius: 4px;
      font-size: 0.9em;
      color: ${cronEnabled ? '#234e52' : '#742a2a'};
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
    .metric-label { font-size: 0.9em; color: #718096; }
    .action-section {
      background: white;
      border-radius: 10px;
      padding: 20px;
      margin-bottom: 20px;
      box-shadow: 0 4px 6px rgba(0,0,0,0.1);
    }
    .btn {
      padding: 10px 20px;
      border: none;
      border-radius: 5px;
      font-size: 16px;
      cursor: pointer;
      transition: all 0.3s;
      text-decoration: none;
      display: inline-block;
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
      background: #e2e8f0;
      color: #4a5568;
    }
    .btn-secondary:hover {
      background: #cbd5e0;
    }
    .button-group {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
    }
    .event-viewer {
      background: #f7fafc;
      border-radius: 8px;
      padding: 15px;
      max-height: 300px;
      overflow-y: auto;
      font-family: 'Monaco', 'Consolas', monospace;
      font-size: 12px;
    }
    .event-item {
      padding: 4px 0;
      border-bottom: 1px solid #e2e8f0;
    }
    .event-item.ERROR { color: #e53e3e; }
    .event-item.SUCCESS { color: #38a169; }
    .event-item.WARN { color: #d69e2e; }
    .progress-bar {
      background: #e2e8f0;
      border-radius: 10px;
      overflow: hidden;
      height: 30px;
    }
    .progress-fill {
      background: linear-gradient(90deg, #667eea, #764ba2);
      height: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      color: white;
      font-weight: bold;
      transition: width 0.3s ease;
    }
    .badge {
      display: inline-block;
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: bold;
      text-transform: uppercase;
      margin-left: 10px;
    }
    .badge-idle { background: #e2e8f0; color: #4a5568; }
    .badge-running { background: #48bb78; color: white; }
    a { color: #667eea; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>
        🔧 Scraper Componenti Digitali
        <span class="version">v3.3 FINAL</span>
      </h1>
      <div class="cron-info">
        ${cronEnabled ? 
          '⏰ <b>CRON ATTIVO</b>: Scraping automatico ogni 2 ore dalle 7:00 alle 19:00 (7 esecuzioni al giorno)' : 
          '⚠️ <b>CRON DISATTIVO</b>: Imposta ENABLE_CRON=true per attivare lo scraping automatico'
        }
      </div>
    </div>

    <div class="grid">
      <div class="card">
        <h2>📦 Prodotti Totali</h2>
        <div class="metric">${stats.totalProducts.toLocaleString()}</div>
        <div class="metric-label">Nel catalogo</div>
      </div>

      <div class="card">
        <h2>⏱️ Ultimo Aggiornamento</h2>
        <div class="metric">${stats.lastUpdate.time}</div>
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
      <h2 style="margin-bottom: 15px;">⚡ Azioni Manuali</h2>
      <div class="button-group">
        <button class="btn btn-primary" onclick="startScraping(5)">
          🧪 Test (5 pagine)
        </button>
        <button class="btn btn-primary" onclick="startScraping(20)">
          🔄 Medio (20 pagine)
        </button>
        <button class="btn btn-primary" onclick="startScraping(200)">
          🚀 Completo (200 pagine)
        </button>
        <a href="/api/download-csv" class="btn btn-secondary">
          ⬇️ Scarica CSV
        </a>
        <button class="btn btn-secondary" onclick="location.reload()">
          🔄 Refresh Dashboard
        </button>
      </div>
      <p style="color: #666; font-size: 0.9em; margin-top: 10px;">
        💾 CSV disponibile sempre a: <a href="${baseUrl}/output/prodotti_latest.csv" target="_blank">${baseUrl}/output/prodotti_latest.csv</a>
      </p>
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
        
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 15px; margin-top: 15px;" id="statsGrid">
          <div style="background: #f7fafc; padding: 15px; border-radius: 8px; text-align: center;">
            <div style="font-size: 2em; font-weight: bold; color: #667eea;" id="statPages">0</div>
            <div style="font-size: 0.9em; color: #666; margin-top: 5px;">Pagine</div>
          </div>
          <div style="background: #f7fafc; padding: 15px; border-radius: 8px; text-align: center;">
            <div style="font-size: 2em; font-weight: bold; color: #667eea;" id="statProducts">0</div>
            <div style="font-size: 0.9em; color: #666; margin-top: 5px;">Prodotti</div>
          </div>
          <div style="background: #f7fafc; padding: 15px; border-radius: 8px; text-align: center;">
            <div style="font-size: 2em; font-weight: bold; color: #667eea;" id="statImages">0</div>
            <div style="font-size: 0.9em; color: #666; margin-top: 5px;">Immagini</div>
          </div>
          <div style="background: #f7fafc; padding: 15px; border-radius: 8px; text-align: center;">
            <div style="font-size: 2em; font-weight: bold; color: #667eea;" id="statDuration">0m</div>
            <div style="font-size: 0.9em; color: #666; margin-top: 5px;">Durata</div>
          </div>
        </div>
      </div>
    </div>

    <div class="action-section">
      <h2 style="margin-bottom: 15px;">📝 Eventi Scraper (Live)
        <button class="btn btn-secondary" onclick="refreshEvents()" style="float: right; padding: 6px 12px; font-size: 14px;">
          🔄 Refresh
        </button>
      </h2>
      <div class="event-viewer" id="eventViewer">
        <div style="text-align: center; color: #718096;">Caricamento eventi...</div>
      </div>
    </div>
  </div>

  <script>
    async function startScraping(pages) {
      if (!confirm(\`Avviare scraping di \${pages} pagine?\`)) return;
      
      try {
        const response = await fetch('/api/scrape', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pages })
        });
        
        const data = await response.json();
        
        if (response.ok) {
          alert('✓ Scraping avviato!');
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
              \${e.page ? \` <span style="color: #48bb78;">(Pagina: \${e.page})</span>\` : ''}
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
        
        if (progress.stats && progress.stats.currentPage > 0) {
          document.getElementById('scraperStatus').className = 'badge badge-running';
          document.getElementById('scraperStatus').textContent = 'RUNNING';
          document.getElementById('progressSection').style.display = 'block';
          
          const pct = Math.round((progress.stats.currentPage / (progress.stats.maxPages || 200)) * 100);
          document.getElementById('progressBar').style.width = pct + '%';
          document.getElementById('progressBar').textContent = pct + '%';
          
          document.getElementById('statPages').textContent = progress.stats.currentPage || 0;
          document.getElementById('statProducts').textContent = progress.stats.productsCount || 0;
          document.getElementById('statImages').textContent = progress.stats.imagesDownloaded || 0;
          
          const duration = Math.round((Date.now() - progress.stats.startTime) / 60000);
          document.getElementById('statDuration').textContent = duration + 'm';
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
      }, 3000);
      
      setTimeout(() => {
        fetch('/api/scraper/progress')
          .then(r => r.json())
          .then(p => {
            if (!p.stats || p.stats.currentPage === 0) {
              clearInterval(interval);
            }
          });
      }, 10 * 60 * 1000);
    }
    
    refreshEvents();
    checkProgress();
    setInterval(refreshEvents, 5000);
    setInterval(checkProgress, 3000);
  </script>
</body>
</html>
  `);
});

// CRON SCHEDULING - MODIFICATO: OGNI 2 ORE DALLE 7:00 ALLE 19:00
if (process.env.ENABLE_CRON === 'true') {
  // Scraping alle ore: 7, 9, 11, 13, 15, 17, 19 (7 esecuzioni al giorno)
  // Sintassi cron: '0 7-19/2 * * *' significa minuto 0, ogni 2 ore dalle 7 alle 19
  cron.schedule('0 7-19/2 * * *', () => {
    const now = new Date();
    const hour = now.getHours();
    logger.log(`[CRON] Starting scheduled scraping at ${hour}:00`, 'INFO');
    
    const child = spawn('node', ['scraper_componenti_wpai_min.js', '200'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false
    });
    
    child.stdout.on('data', (data) => logger.log(`[CRON SCRAPER] ${data}`, 'INFO'));
    child.stderr.on('data', (data) => logger.log(`[CRON SCRAPER ERROR] ${data}`, 'ERROR'));
    
    child.on('close', (code) => {
      logger.log(`[CRON] Scraping ${code === 0 ? 'completed' : 'failed'} at ${hour}:00`, code === 0 ? 'INFO' : 'ERROR');
    });
  });
  
  logger.log('⏰ CRON ENABLED - Scraping: 7:00, 9:00, 11:00, 13:00, 15:00, 17:00, 19:00 (7x/day)', 'INFO');
} else {
  logger.log('⏰ CRON DISABLED (set ENABLE_CRON=true to enable)', 'INFO');
}

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.log('SIGTERM - shutting down', 'INFO');
  setTimeout(() => process.exit(0), 5000);
});

// Ensure directories
[outputDir, logsDir, imagesDir].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    logger.log(`✓ Created: ${dir}`, 'INFO');
  }
});

// Start
app.listen(PORT, () => {
  logger.log('╔════════════════════════════════════════╗', 'INFO');
  logger.log('║   SCRAPER SERVER v3.3 FINAL           ║', 'INFO');
  logger.log('╚════════════════════════════════════════╝', 'INFO');
  logger.log(`Server: http://localhost:${PORT}`, 'INFO');
  logger.log(`Data Directory: ${dataDir}`, 'INFO');
  logger.log(`CRON: ${process.env.ENABLE_CRON === 'true' ? 'ENABLED' : 'DISABLED'}`, 'INFO');
});

module.exports = app;
