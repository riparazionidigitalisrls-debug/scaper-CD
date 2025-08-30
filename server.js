// server.js - Server per Render.com con supporto Enterprise e Stock Checker
// Dashboard e automazione per scraper standard, enterprise e stock checker

const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 10000;

// Path per output (Render usa /tmp)
const outputBase = process.env.RENDER ? '/tmp' : '.';
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
  const pagesNum = parseInt(pages);
  // Usa enterprise per > 50 pagine o se specificato
  if (pagesNum > 50 || process.env.USE_ENTERPRISE === 'true') {
    return 'scraper_componenti_enterprise.js';
  }
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
          background: #fef3c7;
          border-left: 4px solid #f59e0b;
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
              '<span class="status ok">Enterprise Mode</span>' : 
              '<span class="status warn">Standard Mode</span>'}
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
            <strong>🟢 Stock Check (SOLO disponibilità - sicuro):</strong><br>
            <button class="stock" onclick="runStockCheck(10)">Test 10 prodotti</button>
            <button class="stock" onclick="runStockCheck(100)">Check 100 prodotti</button>
            <button class="stock" onclick="runStockCheck(500)">Check 500 prodotti</button>
            <button class="stock" onclick="runStockCheck(2500)">Sessione 8 ore (2500)</button>
          </div>
          
          <div style="margin: 15px 0;">
            <strong>Standard Mode (scraping completo veloce):</strong><br>
            <button onclick="runScrape(5)">🧪 Test (5 pagine)</button>
            <button onclick="runScrape(20)">🔄 Sync (20 pagine)</button>
            <button onclick="runScrape(50)">📈 Medio (50 pagine)</button>
          </div>
          
          <div style="margin: 15px 0;">
            <strong>Enterprise Mode (scraping completo con checkpoint):</strong><br>
            <button class="enterprise" onclick="runScrape(100)">📦 Extended (100 pagine)</button>
            <button class="enterprise" onclick="runScrape(200)">🏭 Full (200 pagine)</button>
            <button class="enterprise" onclick="runScrape(999)">⚠️ Completo (TUTTE)</button>
          </div>
          
          <div style="margin: 15px 0;">
            <button onclick="downloadCSV()">📥 Download CSV Latest</button>
            <button onclick="viewCheckpoint()">🔍 View Checkpoint</button>
            <button onclick="clearLogs()">🗑️ Clear Logs</button>
          </div>
          
          <div class="alert">
            <strong>⚠️ ATTENZIONE CRON MODIFICATI:</strong><br>
            • <del>Sync ogni 6 ore</del> → <strong>DISABILITATO</strong> (rischio ban)<br>
            • <del>Full scan notturno</del> → <strong>Solo domenica alle 3:00</strong> (ogni 2 settimane)<br>
            • <strong>NUOVO:</strong> Stock check alle 5:00 e 15:00 (solo disponibilità)<br>
            • Stock check rispetta crawl-delay di 12 secondi tra prodotti
          </div>
          
          <div class="info">
            <strong>ℹ️ Scheduling Automatico Aggiornato:</strong><br>
            • Stock check mattina alle 5:00 (2500 prodotti, ~8 ore)<br>
            • Stock check pomeriggio alle 15:00 (2500 prodotti, ~8 ore)<br>
            • Full scraping: domenica alle 3:00 (ogni 2 settimane)<br>
            • WP All Import processa alle 6:00 e 16:00<br>
            • Server: Render.com ${process.env.RENDER ? '<span class="status ok">Production</span>' : '<span class="status warn">Development</span>'}<br>
            • Plan: ${process.env.RENDER_PLAN || 'Free'}<br>
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
            • Prodotti controllati: ${stats.stockProgress.currentIndex}/${stats.stockProgress.totalProducts || 'N/A'}<br>
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
          const mode = pages > 50 ? 'Enterprise' : 'Standard';
          if (!confirm(\`Avviare scraping di \${pages} pagine in modalità \${mode}?\`)) return;
          
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
          if (!confirm(\`Avviare stock check di \${products} prodotti?\\nTempo stimato: \${Math.round(products * 12 / 60)} minuti\`)) return;
          
          const btn = event.target;
          btn.disabled = true;
          btn.textContent = '⏳ Avvio...';
          
          try {
            const res = await fetch(\`/api/stock-check?products=\${products}\`, { method: 'POST' });
            const data = await res.json();
            
            if (data.status === 'started') {
              alert(\`✅ Stock check avviato!\\nProdotti: \${products}\\nPID: \${data.pid}\`);
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
    mode: pages > 50 ? 'enterprise' : 'standard'
  });
});

// NUOVA API: Avvia stock check
app.post('/api/stock-check', (req, res) => {
  const products = req.query.products || '100';
  
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
    estimatedTime: `${Math.round(products * 12 / 60)} minuti`
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
  
  // Cerca tutti i file log
  if (fs.existsSync(outputDir)) {
    const files = fs.readdirSync(outputDir);
    files.forEach(file => {
      if (file.endsWith('.log')) {
        logFiles.push(path.join(outputDir, file));
      }
    });
  }
  
  // Leggi ultimo log
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

// Helper: Get complete stats (AGGIORNATO con stock progress)
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
    stockProgress: null,  // NUOVO
    uptime: formatUptime(process.uptime()),
    memory: getMemoryStats(),
    cpu: getCPULoad(),
    disk: getDiskStats()
  };
  
  try {
    // Cerca tutti i CSV
    if (fs.existsSync(outputDir)) {
      const files = fs.readdirSync(outputDir);
      
      // CSV files
      files.forEach(file => {
        if (file.endsWith('.csv')) {
          stats.csvFiles.push(file);
          const filePath = path.join(outputDir, file);
          const fileStats = fs.statSync(filePath);
          
          // Usa il più recente
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
      
      // Stock checker progress (NUOVO)
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
  // Semplificato per compatibilità
  return { used: 'N/A', total: 'N/A' };
}

// ========================================
// CRON JOBS AGGIORNATI (PIÙ SICURI)
// ========================================
if (process.env.NODE_ENV === 'production' || process.env.RENDER) {
  
  // ❌ DISABILITATO - Sync ogni 6 ore (RISCHIO BAN)
  // cron.schedule('0 */6 * * *', () => {
  //   console.log('[CRON] DISABILITATO - Rischio ban');
  // });
  
  // ✅ Stock check mattina alle 5:00 (SOLO disponibilità)
  cron.schedule('0 5 * * *', () => {
    console.log('[CRON] Avvio stock check mattutino (2500 prodotti)...');
    spawn('node', ['stock-checker-light.js', '2500'], {
      detached: true,
      stdio: 'ignore'
    }).unref();
  });
  
  // ✅ Stock check pomeriggio alle 15:00 (SOLO disponibilità)
  cron.schedule('0 15 * * *', () => {
    console.log('[CRON] Avvio stock check pomeridiano (2500 prodotti)...');
    spawn('node', ['stock-checker-light.js', '2500'], {
      detached: true,
      stdio: 'ignore'
    }).unref();
  });
  
  // ✅ Full scan SOLO domenica alle 3:00 (ogni 2 settimane)
  cron.schedule('0 3 * * 0', () => {
    // Calcola numero settimana per fare ogni 2 settimane
    const weekNumber = Math.floor(Date.now() / (7 * 24 * 60 * 60 * 1000));
    if (weekNumber % 2 === 0) {
      console.log('[CRON] Avvio full scan bisettimanale (200 pagine)...');
      spawn('node', ['scraper_componenti_enterprise.js', '200'], {
        detached: true,
        stdio: 'ignore'
      }).unref();
    } else {
      console.log('[CRON] Settimana dispari, skip full scan');
    }
  });
  
  console.log('⏰ Cron jobs SICURI attivati:');
  console.log('   - Stock check: 5:00 e 15:00 (solo disponibilità)');
  console.log('   - Full scraping: domenica 3:00 (ogni 2 settimane)');
  console.log('   - Sync ogni 6 ore: DISABILITATO (rischio ban)');
  
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
  
  if (process.env.NODE_ENV === 'production' || process.env.RENDER) {
    console.log('\n⚠️  CRON MODIFICATI PER SICUREZZA:');
    console.log('• Sync ogni 6 ore: DISABILITATO');
    console.log('• Stock check: 5:00 e 15:00');
    console.log('• Full scan: solo domenica ogni 2 settimane');
  }
});
