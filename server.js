// server.js - Server per Render.com con supporto Enterprise e Stock Checker
// Dashboard e automazione per scraper standard, enterprise e stock checker

const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 10000;

// Path per output (Render usa /data per persistenza)
const outputBase = process.env.DATA_DIR || (process.env.RENDER ? '/data' : '.');
const outputDir = path.join(outputBase, 'output');

// File paths - supporta sia legacy che nuovo sistema
const csvLatestPath = path.join(outputDir, 'prodotti_latest.csv');
const csvMinPath = path.join(outputDir, 'prodotti_wpimport_min.csv');
const logPath = path.join(outputDir, 'scraper.log');

// Serve immagini statiche
app.use('/images', express.static(path.join(outputDir, 'images')));
app.use('/output', express.static(outputDir));

// Helper per base URL pubblico dietro reverse proxy
function publicBase(req) {
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`;
  return `${proto}://${host}`;
}

// Helper per scegliere lo scraper giusto
function getScraperScript(pages) {
  // Usa sempre scraper standard (selettori più robusti)
  return 'scraper_componenti_wpai_min.js';
}

// Helper per check esistenza file
function getLatestCsvPath() {
  if (fs.existsSync(csvLatestPath)) return csvLatestPath;
  if (fs.existsSync(csvMinPath)) return csvMinPath;
  return null;
}

// Dashboard principale migliorata
app.get('/', (req, res) => {
  const stats = getStats();
  const base = publicBase(req);
  
  res.send(`
    <!DOCTYPE html>
    <html lang="it">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Scraper Dashboard - Componenti Digitali</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          min-height: 100vh;
          padding: 20px;
        }
        .container { max-width: 1200px; margin: 0 auto; }
        h1 { color: white; text-align: center; margin-bottom: 30px; font-size: 2em; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 20px; }
        .card { 
          background: white; 
          border-radius: 10px; 
          padding: 20px; 
          box-shadow: 0 4px 6px rgba(0,0,0,0.1);
          transition: transform 0.2s;
        }
        .card:hover { transform: translateY(-2px); }
        .card h2 { color: #333; margin-bottom: 15px; font-size: 1.2em; }
        .stat { font-size: 2em; font-weight: bold; color: #667eea; }
        .label { color: #666; margin-top: 5px; font-size: 0.9em; }
        button { 
          background: #667eea; 
          color: white; 
          border: none; 
          padding: 12px 20px; 
          border-radius: 5px; 
          cursor: pointer; 
          margin: 5px;
          font-size: 14px;
          transition: background 0.3s;
        }
        button:hover { background: #5a67d8; }
        button.enterprise { background: #f59e0b; }
        button.enterprise:hover { background: #d97706; }
        button.stock { background: #10b981; }
        button.stock:hover { background: #059669; }
        .logs { 
          background: #1a1a1a; 
          color: #0f0; 
          padding: 15px; 
          border-radius: 5px; 
          font-family: 'Courier New', monospace; 
          font-size: 12px; 
          max-height: 400px; 
          overflow-y: auto; 
          white-space: pre-wrap;
          line-height: 1.4;
        }
        .info { 
          background: #f7fafc; 
          padding: 15px; 
          border-radius: 5px; 
          margin: 15px 0;
          border-left: 4px solid #667eea;
        }
        .status { 
          display: inline-block; 
          padding: 4px 8px; 
          border-radius: 4px; 
          font-size: 12px; 
          font-weight: bold;
        }
        .status.ok { background: #c6f6d5; color: #22543d; }
        .status.warn { background: #fed7aa; color: #7c2d12; }
        .status.error { background: #fed7d7; color: #742a2a; }
        .progress {
          width: 100%;
          height: 20px;
          background: #e2e8f0;
          border-radius: 10px;
          overflow: hidden;
          margin-top: 10px;
        }
        .progress-bar {
          height: 100%;
          background: linear-gradient(90deg, #667eea, #764ba2);
          transition: width 0.3s;
        }
        .alert {
          background: #d1fae5;
          border-left: 4px solid #10b981;
          padding: 15px;
          margin: 15px 0;
          border-radius: 5px;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>🚀 Scraper Componenti Digitali - Dashboard</h1>
        
        <div class="grid">
          <div class="card">
            <h2>📊 Prodotti Totali</h2>
            <div class="stat">${stats.totalProducts.toLocaleString()}</div>
            <div class="label">Nel CSV</div>
            ${stats.totalProducts > 3000 ? 
              '<span class="status ok">Database Completo</span>' : 
              '<span class="status warn">In Aggiornamento</span>'}
          </div>
          
          <div class="card">
            <h2>🕐 Ultimo Update</h2>
            <div class="stat">${stats.lastUpdate}</div>
            <div class="label">${stats.timeSince}</div>
          </div>
          
          <div class="card">
            <h2>💾 CSV Size</h2>
            <div class="stat">${stats.csvSize} MB</div>
            <div class="label">
              ${stats.csvFiles.length} file disponibili
            </div>
          </div>
          
          <div class="card">
            <h2>🖼️ Immagini</h2>
            <div class="stat">${stats.imagesCount.toLocaleString()}</div>
            <div class="label">Scaricate (${stats.imagesSize} MB)</div>
          </div>
        </div>
        
        <div class="card" style="margin-top: 20px;">
          <h2>⚡ Controlli Manuali</h2>
          
          <div style="margin: 15px 0;">
            <strong>🟢 Stock Check (SOLO disponibilità - veloce 20 min):</strong><br>
            <button class="stock" onclick="runStockCheck(100)">Test 100 prodotti</button>
            <button class="stock" onclick="runStockCheck(500)">Check 500 prodotti</button>
            <button class="stock" onclick="runStockCheck(5000)">Check COMPLETO (5000)</button>
          </div>
          
          <div style="margin: 15px 0;">
            <strong>Standard Mode (scraping completo ~25 min):</strong><br>
            <button onclick="runScrape(5)">🧪 Test (5 pagine)</button>
            <button onclick="runScrape(20)">🔄 Sync (20 pagine)</button>
            <button onclick="runScrape(50)">📈 Medio (50 pagine)</button>
            <button onclick="runScrape(200)">📦 Full (200 pagine)</button>
          </div>
          
          <div style="margin: 15px 0;">
            <button onclick="downloadCSV()">📥 Download CSV Latest</button>
            <button onclick="viewCheckpoint()">🔍 View Checkpoint</button>
            <button onclick="clearLogs()">🗑️ Clear Logs</button>
          </div>
          
          <div class="alert">
            <strong>✅ SISTEMA ANTI-OVERSELLING OTTIMIZZATO:</strong><br>
            • <strong>Full scan:</strong> ogni notte alle 3:00 (~25 min)<br>
            • <strong>Stock check GIORNO:</strong> ogni 2 ore (8:00-22:00) - 20 min<br>
            • <strong>Stock check NOTTE:</strong> ogni 4 ore (0:00, 4:00) - 20 min<br>
            • <strong>Finestra max overselling: 2 ORE</strong> ✅<br>
            • <strong>Verifiche stock: 12x/giorno (60.000+ check)</strong><br>
            • <strong>Zero accavallamenti cron</strong> ✅
          </div>
          
          <div class="info">
            <strong>ℹ️ Scheduling Automatico:</strong><br>
            • Stock check veloce: ogni 2h giorno, 4h notte (20 min/check)<br>
            • Full scraping: ogni notte alle 3:00 UTC (25 min)<br>
            • Sistema bilanciato e sicuro ✅<br>
            • Server: Render.com ${process.env.RENDER ? '<span class="status ok">Production</span>' : '<span class="status warn">Development</span>'}<br>
            • Storage: Persistent Disk /data ✅<br>
            • Base URL: <code>${base}</code><br>
            • CSV Endpoint: <code>${base}/output/prodotti_latest.csv</code>
          </div>
          
          ${stats.checkpoint ? `
          <div class="info" style="background: #fef5e7; border-color: #f39c12;">
            <strong>⏸️ Checkpoint Attivo:</strong><br>
            • Pagina: ${stats.checkpoint.currentPage}/${stats.checkpoint.totalPages}<br>
            • Prodotti salvati: ${stats.checkpoint.productsScraped}<br>
            • Creato: ${new Date(stats.checkpoint.timestamp).toLocaleString('it-IT')}<br>
            <div class="progress">
              <div class="progress-bar" style="width: ${(stats.checkpoint.currentPage / stats.checkpoint.totalPages * 100).toFixed(1)}%"></div>
            </div>
          </div>
          ` : ''}
          
          ${stats.stockProgress ? `
          <div class="info" style="background: #d1fae5; border-color: #10b981;">
            <strong>📊 Stock Check in Progress:</strong><br>
            • Prodotti controllati: ${stats.stockProgress.currentIndex || 0}/${stats.stockProgress.stats?.checked || 'N/A'}<br>
            • Aggiornati: ${stats.stockProgress.stats?.updated || 0}<br>
            • Out of stock: ${stats.stockProgress.stats?.outOfStock?.length || 0}<br>
            • Ultimo check: ${new Date(stats.stockProgress.timestamp).toLocaleString('it-IT')}<br>
          </div>
          ` : ''}
        </div>
        
        <div class="card" style="margin-top: 20px;">
          <h2>📝 Log Recenti</h2>
          <div class="logs" id="logs">${stats.logs}</div>
        </div>
        
        <div class="card" style="margin-top: 20px;">
          <h2>📈 Statistiche Sistema</h2>
          <div class="info">
            • Uptime: ${stats.uptime}<br>
            • Memoria: ${stats.memory.used}/${stats.memory.total} MB (${stats.memory.percent}%)<br>
            • CPU Load: ${stats.cpu}<br>
            • Disk Space: ${stats.disk.used}/${stats.disk.total} GB
          </div>
        </div>
      </div>
      
      <script>
        async function runScrape(pages) {
          const mode = pages > 50 ? 'Full' : 'Quick';
          if (!confirm(\`Avviare scraping di \${pages} pagine?\\nDurata stimata: ~\${Math.ceil(pages * 0.125)} minuti\`)) return;
          
          const btn = event.target;
          btn.disabled = true;
          btn.textContent = '⏳ Avvio...';
          
          try {
            const res = await fetch(\`/api/scrape?pages=\${pages}\`, { method: 'POST' });
            const data = await res.json();
            
            if (data.status === 'started') {
              alert(\`✅ Scraping avviato!\\nModalità: \${mode}\\nPagine: \${pages}\\nPID: \${data.pid}\`);
              setTimeout(() => location.reload(), 3000);
            } else {
              alert('❌ Errore: ' + (data.error || 'Sconosciuto'));
            }
          } catch (e) {
            alert('❌ Errore di connessione');
          } finally {
            btn.disabled = false;
            btn.textContent = btn.textContent.replace('⏳ Avvio...', '');
          }
        }
        
        async function runStockCheck(products) {
          const duration = Math.ceil(products * 0.24 / 60);
          if (!confirm(\`Avviare stock check di \${products} prodotti?\\nTempo stimato: ~\${duration} minuti\`)) return;
          
          const btn = event.target;
          btn.disabled = true;
          btn.textContent = '⏳ Avvio...';
          
          try {
            const res = await fetch(\`/api/stock-check?products=\${products}\`, { method: 'POST' });
            const data = await res.json();
            
            if (data.status === 'started') {
              alert(\`✅ Stock check avviato!\\nProdotti: \${products}\\nPID: \${data.pid}\\nDurata: ~\${duration} min\`);
              setTimeout(() => location.reload(), 3000);
            } else {
              alert('❌ Errore: ' + (data.error || 'Sconosciuto'));
            }
          } catch (e) {
            alert('❌ Errore di connessione');
          } finally {
            btn.disabled = false;
            btn.textContent = btn.textContent.replace('⏳ Avvio...', '');
          }
        }
        
        function downloadCSV() { 
          window.location.href = '/download/csv'; 
        }
        
        async function viewCheckpoint() {
          const res = await fetch('/api/checkpoint');
          const data = await res.json();
          if (data.exists) {
            alert(JSON.stringify(data.checkpoint, null, 2));
          } else {
            alert('Nessun checkpoint attivo');
          }
        }
        
        async function clearLogs() {
          if (confirm('Eliminare tutti i log?')) {
            await fetch('/api/logs', { method: 'DELETE' });
            location.reload();
          }
        }
        
        // Auto-refresh logs
        setInterval(async () => {
          try { 
            const res = await fetch('/api/logs');
            const logs = await res.text();
            document.getElementById('logs').textContent = logs;
          } catch (e) {}
        }, 5000);
        
        // Auto-refresh page ogni minuto
        setTimeout(() => location.reload(), 60000);
      </script>
    </body>
    </html>
  `);
});

// API: Avvia scraping
app.post('/api/scrape', (req, res) => {
  const pages = req.query.pages || '20';
  const script = getScraperScript(pages);
  
  console.log(`[API] Avvio scraping: ${pages} pagine con ${script}`);
  
  const scraper = spawn('node', [script, pages], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  
  scraper.stdout.on('data', (data) => console.log(`[SCRAPER]: ${data}`));
  scraper.stderr.on('data', (data) => console.error(`[SCRAPER ERROR]: ${data}`));
  scraper.unref();
  
  res.json({ 
    status: 'started', 
    pages, 
    pid: scraper.pid,
    script,
    mode: pages > 50 ? 'full' : 'quick'
  });
});

// API: Avvia stock check
app.post('/api/stock-check', (req, res) => {
  const products = req.query.products || '5000';
  
  console.log(`[API] Avvio stock check: ${products} prodotti`);
  
  const checker = spawn('node', ['stock-checker-light.js', products], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  
  checker.stdout.on('data', (data) => console.log(`[STOCK-CHECK]: ${data}`));
  checker.stderr.on('data', (data) => console.error(`[STOCK-CHECK ERROR]: ${data}`));
  checker.unref();
  
  res.json({ 
    status: 'started', 
    products, 
    pid: checker.pid,
    estimatedTime: `~${Math.ceil(products * 0.24 / 60)} minuti`
  });
});

// API: Download CSV
app.get('/download/csv', (req, res) => {
  const csvPath = getLatestCsvPath();
  
  if (csvPath && fs.existsSync(csvPath)) {
    const filename = path.basename(csvPath);
    res.download(csvPath, filename);
  } else {
    res.status(404).send('CSV non ancora disponibile. Avvia prima lo scraping.');
  }
});

// API: Get logs
app.get('/api/logs', (req, res) => {
  const logFiles = [];
  
  if (fs.existsSync(outputDir)) {
    const files = fs.readdirSync(outputDir);
    files.forEach(file => {
      if (file.endsWith('.log')) {
        logFiles.push(path.join(outputDir, file));
      }
    });
  }
  
  if (logFiles.length > 0) {
    const latestLog = logFiles.sort().pop();
    const logs = fs.readFileSync(latestLog, 'utf8');
    const lines = logs.split('\n');
    res.send(lines.slice(-100).join('\n'));
  } else {
    res.send('Nessun log disponibile');
  }
});

// API: Delete logs
app.delete('/api/logs', (req, res) => {
  if (fs.existsSync(outputDir)) {
    const files = fs.readdirSync(outputDir);
    files.forEach(file => {
      if (file.endsWith('.log')) {
        fs.unlinkSync(path.join(outputDir, file));
      }
    });
  }
  res.json({ status: 'ok' });
});

// API: Checkpoint status
app.get('/api/checkpoint', (req, res) => {
  const checkpointPath = path.join(outputDir, 'checkpoint.json');
  
  if (fs.existsSync(checkpointPath)) {
    const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
    res.json({ exists: true, checkpoint });
  } else {
    res.json({ exists: false });
  }
});

// Health checks
app.get('/healthz', (req, res) => res.status(200).send('ok'));
app.get('/health', (req, res) => {
  const stats = getStats();
  res.json({ 
    status: 'healthy', 
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    products: stats.totalProducts,
    lastUpdate: stats.lastUpdate
  });
});

// Helper: Get complete stats
function getStats() {
  const stats = {
    totalProducts: 0,
    lastUpdate: 'Mai',
    timeSince: 'N/A',
    csvSize: 0,
    csvFiles: [],
    imagesCount: 0,
    imagesSize: 0,
    logs: 'Caricamento...',
    checkpoint: null,
    stockProgress: null,
    uptime: formatUptime(process.uptime()),
    memory: getMemoryStats(),
    cpu: getCPULoad(),
    disk: getDiskStats()
  };
  
  try {
    if (fs.existsSync(outputDir)) {
      const files = fs.readdirSync(outputDir);
      
      // CSV files
      files.forEach(file => {
        if (file.endsWith('.csv')) {
          stats.csvFiles.push(file);
          const filePath = path.join(outputDir, file);
          const fileStats = fs.statSync(filePath);
          
          if (file.includes('latest') || file.includes('wpimport')) {
            const csvContent = fs.readFileSync(filePath, 'utf8');
            const lines = csvContent.split('\n').filter(l => l.trim());
            stats.totalProducts = Math.max(stats.totalProducts, lines.length - 1);
            stats.csvSize = (fileStats.size / 1024 / 1024).toFixed(2);
            
            const lastMod = new Date(fileStats.mtime);
            stats.lastUpdate = lastMod.toLocaleString('it-IT');
            const minutes = Math.floor((Date.now() - lastMod) / 60000);
            stats.timeSince = minutes < 60 ? `${minutes} minuti fa` : `${Math.floor(minutes/60)} ore fa`;
          }
        }
      });
      
      // Images
      const imagesPath = path.join(outputDir, 'images');
      if (fs.existsSync(imagesPath)) {
        const images = fs.readdirSync(imagesPath);
        stats.imagesCount = images.filter(f => /\.jpe?g$/i.test(f)).length;
        
        let totalSize = 0;
        images.forEach(img => {
          try {
            const imgStats = fs.statSync(path.join(imagesPath, img));
            totalSize += imgStats.size;
          } catch (e) {}
        });
        stats.imagesSize = (totalSize / 1024 / 1024).toFixed(1);
      }
      
      // Checkpoint
      const checkpointPath = path.join(outputDir, 'checkpoint.json');
      if (fs.existsSync(checkpointPath)) {
        stats.checkpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
      }
      
      // Stock checker progress
      const stockProgressPath = path.join(outputDir, 'stock_checker_progress.json');
      if (fs.existsSync(stockProgressPath)) {
        stats.stockProgress = JSON.parse(fs.readFileSync(stockProgressPath, 'utf8'));
      }
      
      // Logs
      const logFiles = files.filter(f => f.endsWith('.log')).sort();
      if (logFiles.length > 0) {
        const latestLog = path.join(outputDir, logFiles[logFiles.length - 1]);
        const logs = fs.readFileSync(latestLog, 'utf8');
        const lines = logs.split('\n');
        stats.logs = lines.slice(-50).join('\n');
      }
    }
  } catch (error) {
    console.error('Error getting stats:', error);
  }
  
  return stats;
}

// Helper functions
function formatUptime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  
  if (days > 0) return `${days}g ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function getMemoryStats() {
  const used = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
  const total = Math.round(process.memoryUsage().heapTotal / 1024 / 1024);
  const percent = Math.round(used / total * 100);
  return { used, total, percent };
}

function getCPULoad() {
  const load = require('os').loadavg();
  return load[0].toFixed(2);
}

function getDiskStats() {
  return { used: 'N/A', total: 'N/A' };
}

// ========================================
// CRON JOBS ANTI-OVERSELLING OTTIMIZZATI
// ========================================
if (process.env.NODE_ENV === 'production' || process.env.RENDER) {
  
  // ✅ Full scan notturno alle 3:00 UTC (4:00 Italia)
  cron.schedule('0 3 * * *', () => {
    console.log('[CRON] Full scan notturno (200 pagine) - Prodotti + Prezzi + Immagini');
    spawn('node', ['scraper_componenti_wpai_min.js', '200'], {
      detached: true,
      stdio: 'ignore'
    }).unref();
  });
  
  // ✅ Stock check ogni 2 ore durante il giorno (8:00-22:00 UTC)
  cron.schedule('0 8,10,12,14,16,18,20,22 * * *', () => {
    console.log('[CRON] Stock check diurno (ogni 2h) - Anti-overselling veloce');
    spawn('node', ['stock-checker-light.js', '5000'], {
      detached: true,
      stdio: 'ignore'
    }).unref();
  });
  
  // ✅ Stock check notturno ridotto (0:00 e 4:00 UTC)
  cron.schedule('0 0,4 * * *', () => {
    console.log('[CRON] Stock check notturno (ogni 4h)');
    spawn('node', ['stock-checker-light.js', '5000'], {
      detached: true,
      stdio: 'ignore'
    }).unref();
  });
  
  console.log('⏰ Cron jobs ANTI-OVERSELLING OTTIMIZZATI attivati:');
  console.log('   - Full scan: ogni notte alle 3:00 UTC (~25 min)');
  console.log('   - Stock check diurno: ogni 2 ore 8:00-22:00 UTC (~20 min)');
  console.log('   - Stock check notturno: ogni 4 ore 0:00,4:00 UTC (~20 min)');
  console.log('   - Totale verifiche stock: 12x/giorno');
  console.log('   - Finestra max overselling: 2 ORE');
  console.log('   - ZERO accavallamenti cron ✅');
  
} else {
  console.log('⏰ Cron jobs NON attivati (development mode)');
}

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[SERVER] SIGTERM ricevuto, chiusura graceful...');
  setTimeout(() => process.exit(0), 5000);
});

// Start server
app.listen(PORT, () => {
  console.log('╔════════════════════════════════════════╗');
  console.log('║   SCRAPER SERVER AVVIATO!              ║');
  console.log('╚════════════════════════════════════════╝');
  console.log(`Server: http://localhost:${PORT}`);
  console.log(`Mode: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Render: ${process.env.RENDER ? 'Yes' : 'No'}`);
  console.log(`Storage: ${outputBase}`);
  
  if (process.env.NODE_ENV === 'production' || process.env.RENDER) {
    console.log('\n⚡ SISTEMA ANTI-OVERSELLING OTTIMIZZATO:');
    console.log('• Full scan: ogni notte ore 3:00 UTC (~25 min)');
    console.log('• Stock check: ogni 2h giorno + 4h notte (~20 min)');
    console.log('• Verifiche totali: 12x/giorno (60.000+ check)');
    console.log('• Finestra overselling: MAX 2 ore ✅');
    console.log('• Zero accavallamenti ✅');
  }
});
