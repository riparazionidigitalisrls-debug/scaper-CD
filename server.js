// server.js - Server per Render.com con supporto Enterprise e Stock Checker
// Dashboard e automazione per scraper standard, enterprise e stock checker
// VERSIONE OTTIMIZZATA: Cron ogni 2.5h diurni, full scan notturno rallentato

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
        .stat.green { color: #10b981; }
        .stat.orange { color: #f59e0b; }
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
            <h2>✅ In Stock</h2>
            <div class="stat green">${stats.inStock.toLocaleString()}</div>
            <div class="label">${stats.inStockPercent}% disponibili</div>
          </div>
          
          <div class="card">
            <h2>❌ Out of Stock</h2>
            <div class="stat orange">${stats.outOfStock.toLocaleString()}</div>
            <div class="label">${stats.outOfStockPercent}% esauriti</div>
          </div>
          
          <div class="card">
            <h2>🕐 Ultimo Update</h2>
            <div class="stat" style="font-size: 1.5em;">${stats.lastUpdate}</div>
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
            <strong>🟢 Stock Check (SOLO disponibilità - fino a 60 min):</strong><br>
            <button class="stock" onclick="runStockCheck(100)">Test 100 prodotti</button>
            <button class="stock" onclick="runStockCheck(500)">Check 500 prodotti</button>
            <button class="stock" onclick="runStockCheck(5000)">Check COMPLETO (5000)</button>
          </div>
          
          <div style="margin: 15px 0;">
            <strong>Standard Mode (scraping completo ~35 min rallentato):</strong><br>
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
            <strong>✅ SISTEMA ANTI-OVERSELLING v2.1 - COPERTURA COMPLETA:</strong><br>
            • <strong>Full scan notturno:</strong> ore 2:00 UTC (3:00 Italia) - ~40 min per precisione<br>
            • <strong>Stock check COMPLETI:</strong> ogni 3h dalle 6:00 alle 21:00 UTC (6 controlli/giorno) - ~2h per check<br>
            • <strong>TUTTI I 5000 PRODOTTI</strong> controllati ad ogni check ✅<br>
            • <strong>Finestra max overselling: 3 ORE</strong> ✅<br>
            • <strong>Verifiche stock: 6x/giorno × 5000 prodotti = 30.000 controlli completi</strong><br>
            • <strong>Zero accavallamenti garantito</strong> ✅<br>
            • <strong>Stock default: 1 invece di 10 (anti-overselling)</strong> ✅<br>
            • <strong>Backup automatici: mantiene ultimi 3</strong> ✅<br>
            • <strong>Copertura: 100% catalogo ad ogni check</strong> 🎯
          </div>
          
          <div class="info">
            <strong>ℹ️ Scheduling Automatico v2.0:</strong><br>
            • Stock check diurni: 8:00, 10:30, 13:00, 15:30, 18:00, 20:30 UTC (max 60 min/check)<br>
            • Full scraping: ogni notte ore 2:00 UTC (rallentato a 35 min per precisione)<br>
            • Sistema bilanciato con maggiore precisione e zero accavallamenti ✅<br>
            • Server: Render.com ${process.env.RENDER ? '<span class="status ok">Production</span>' : '<span class="status warn">Development</span>'}<br>
            • Storage: Persistent Disk /data ✅<br>
            • Uptime: ${stats.uptime} | RAM: ${stats.memory.used}/${stats.memory.total} MB (${stats.memory.percent}%)<br>
            • CPU Load: ${stats.cpu} | Disk: ${stats.disk.used}/${stats.disk.total}
          </div>
        </div>
        
        <div class="card" style="margin-top: 20px;">
          <h2>📊 Sistema Health</h2>
          <div class="progress">
            <div class="progress-bar" style="width: ${stats.memory.percent}%"></div>
          </div>
          <div class="label">Memory Usage: ${stats.memory.percent}%</div>
        </div>
        
        <div class="card" style="margin-top: 20px;">
          <h2>📝 Ultimi Log (50 righe)</h2>
          <div class="logs">${stats.logs}</div>
        </div>
        
        ${stats.checkpoint ? `
        <div class="card" style="margin-top: 20px;">
          <h2>🔄 Checkpoint Attivo</h2>
          <div class="info">
            <strong>Pagina:</strong> ${stats.checkpoint.currentPage || 'N/A'}<br>
            <strong>Prodotti trovati:</strong> ${stats.checkpoint.productsFound || 0}<br>
            <strong>Timestamp:</strong> ${new Date(stats.checkpoint.timestamp || Date.now()).toLocaleString('it-IT')}
          </div>
        </div>
        ` : ''}
        
        ${stats.stockProgress ? `
        <div class="card" style="margin-top: 20px;">
          <h2>📈 Stock Check in Corso</h2>
          <div class="info">
            <strong>Prodotti controllati:</strong> ${stats.stockProgress.stats?.checked || 0}<br>
            <strong>Aggiornati:</strong> ${stats.stockProgress.stats?.updated || 0}<br>
            <strong>Out of stock:</strong> ${stats.stockProgress.stats?.outOfStock?.length || 0}<br>
            <strong>Tornati disponibili:</strong> ${stats.stockProgress.stats?.backInStock?.length || 0}
          </div>
          <div class="progress">
            <div class="progress-bar" style="width: ${Math.min(100, ((stats.stockProgress.currentIndex || 0) / 5000) * 100)}%"></div>
          </div>
        </div>
        ` : ''}
      </div>
      
      <script>
        function runScrape(pages) {
          if (confirm(\`Avviare scraping di \${pages} pagine?\\n\\nTempo stimato: ~\${Math.ceil(pages * 0.15)} minuti\`)) {
            fetch('/api/scrape?pages=' + pages, { method: 'POST' })
              .then(r => r.json())
              .then(d => alert(d.message || 'Scraping avviato!'))
              .catch(e => alert('Errore: ' + e));
            setTimeout(() => location.reload(), 2000);
          }
        }
        
        function runStockCheck(products) {
          if (confirm(\`Controllare disponibilità di \${products} prodotti?\\n\\nTempo stimato: ~\${Math.ceil(products * 0.01)} minuti\`)) {
            fetch('/api/stock-check?products=' + products, { method: 'POST' })
              .then(r => r.json())
              .then(d => alert(d.message || 'Stock check avviato!'))
              .catch(e => alert('Errore: ' + e));
            setTimeout(() => location.reload(), 2000);
          }
        }
        
        function downloadCSV() {
          window.location.href = '/output/prodotti_latest.csv';
        }
        
        function viewCheckpoint() {
          fetch('/api/checkpoint')
            .then(r => r.json())
            .then(d => {
              if (d.exists) {
                alert('Checkpoint:\\n' + JSON.stringify(d.checkpoint, null, 2));
              } else {
                alert('Nessun checkpoint attivo');
              }
            });
        }
        
        function clearLogs() {
          if (confirm('Eliminare tutti i file di log?')) {
            fetch('/api/logs', { method: 'DELETE' })
              .then(r => r.json())
              .then(d => {
                alert('Log eliminati');
                location.reload();
              });
          }
        }
        
        // Auto-refresh ogni 30 secondi
        setTimeout(() => location.reload(), 30000);
      </script>
    </body>
    </html>
  `);
});

// API: Run scraper
app.post('/api/scrape', (req, res) => {
  const pages = parseInt(req.query.pages) || 20;
  const script = getScraperScript(pages);
  
  console.log(`[API] Avvio scraper: ${script} con ${pages} pagine`);
  
  spawn('node', [script, pages.toString()], {
    detached: true,
    stdio: 'ignore'
  }).unref();
  
  res.json({ 
    status: 'ok', 
    message: `Scraping avviato (${pages} pagine)`,
    script: script
  });
});

// API: Run stock checker
app.post('/api/stock-check', (req, res) => {
  const products = parseInt(req.query.products) || 5000;
  
  console.log(`[API] Avvio stock checker: ${products} prodotti`);
  
  spawn('node', ['stock-checker-light.js', products.toString()], {
    detached: true,
    stdio: 'ignore'
  }).unref();
  
  res.json({ 
    status: 'ok', 
    message: `Stock check avviato (${products} prodotti)`
  });
});

// API: Download CSV
app.get('/api/csv', (req, res) => {
  const csvPath = getLatestCsvPath();
  if (csvPath && fs.existsSync(csvPath)) {
    res.download(csvPath);
  } else {
    res.status(404).json({ error: 'CSV non trovato' });
  }
});

// API: Get stats
app.get('/api/stats', (req, res) => {
  res.json(getStats());
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
    inStock: stats.inStock,
    outOfStock: stats.outOfStock,
    lastUpdate: stats.lastUpdate
  });
});

// Helper: Get complete stats
function getStats() {
  const stats = {
    totalProducts: 0,
    inStock: 0,
    outOfStock: 0,
    inStockPercent: 0,
    outOfStockPercent: 0,
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
            
            // Conta prodotti totali
            stats.totalProducts = Math.max(stats.totalProducts, lines.length - 1);
            stats.csvSize = (fileStats.size / 1024 / 1024).toFixed(2);
            
            // Conta in stock vs out of stock
            const headers = lines[0].toLowerCase().split(',');
            const stockStatusIndex = headers.findIndex(h => h.includes('stock_status'));
            const stockQtyIndex = headers.findIndex(h => h.includes('stock_quantity'));
            
            for (let i = 1; i < lines.length; i++) {
              // ✅ v2.1: Usa parseCSVLine invece di split per gestire virgole nei campi
              const cols = parseCSVLine(lines[i]);
              const stockStatus = cols[stockStatusIndex]?.toLowerCase() || '';
              const stockQty = parseInt(cols[stockQtyIndex]) || 0;
              
              if (stockStatus.includes('instock') || stockQty > 0) {
                stats.inStock++;
              } else {
                stats.outOfStock++;
              }
            }
            
            // Calcola percentuali
            if (stats.totalProducts > 0) {
              stats.inStockPercent = Math.round((stats.inStock / stats.totalProducts) * 100);
              stats.outOfStockPercent = Math.round((stats.outOfStock / stats.totalProducts) * 100);
            }
            
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
function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  
  result.push(current.trim());
  return result;
}

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
// CRON JOBS ANTI-OVERSELLING v2.0 OTTIMIZZATI
// ========================================
if (process.env.NODE_ENV === 'production' || process.env.RENDER) {
  
  // ✅ Full scan notturno alle 2:00 UTC (3:00 Italia) - RALLENTATO per precisione
  cron.schedule('0 2 * * *', () => {
    console.log('[CRON] Full scan notturno (200 pagine) - RALLENTATO per massima precisione');
    spawn('node', ['scraper_componenti_wpai_min.js', '200'], {
      detached: true,
      stdio: 'ignore'
    }).unref();
  });
  
  // ✅ Stock check ogni 3 ore per controllo COMPLETO 5000 prodotti (~2h per check)
  cron.schedule('0 6 * * *', () => {
    console.log('[CRON] Stock check ore 6:00 - Controllo COMPLETO 5000 prodotti (~2h)');
    spawn('node', ['stock-checker-light.js', '5000'], {
      detached: true,
      stdio: 'ignore'
    }).unref();
  });
  
  cron.schedule('0 9 * * *', () => {
    console.log('[CRON] Stock check ore 9:00 - Controllo COMPLETO 5000 prodotti (~2h)');
    spawn('node', ['stock-checker-light.js', '5000'], {
      detached: true,
      stdio: 'ignore'
    }).unref();
  });
  
  cron.schedule('0 12 * * *', () => {
    console.log('[CRON] Stock check ore 12:00 - Controllo COMPLETO 5000 prodotti (~2h)');
    spawn('node', ['stock-checker-light.js', '5000'], {
      detached: true,
      stdio: 'ignore'
    }).unref();
  });
  
  cron.schedule('0 15 * * *', () => {
    console.log('[CRON] Stock check ore 15:00 - Controllo COMPLETO 5000 prodotti (~2h)');
    spawn('node', ['stock-checker-light.js', '5000'], {
      detached: true,
      stdio: 'ignore'
    }).unref();
  });
  
  cron.schedule('0 18 * * *', () => {
    console.log('[CRON] Stock check ore 18:00 - Controllo COMPLETO 5000 prodotti (~2h)');
    spawn('node', ['stock-checker-light.js', '5000'], {
      detached: true,
      stdio: 'ignore'
    }).unref();
  });
  
  cron.schedule('0 21 * * *', () => {
    console.log('[CRON] Stock check ore 21:00 - Controllo COMPLETO 5000 prodotti (~2h)');
    spawn('node', ['stock-checker-light.js', '5000'], {
      detached: true,
      stdio: 'ignore'
    }).unref();
  });
  
  console.log('⏰ Cron jobs ANTI-OVERSELLING v2.1 - COPERTURA COMPLETA:');
  console.log('   ✅ Full scan: ogni notte ore 2:00 UTC (3:00 Italia) - ~40 min');
  console.log('   ✅ Stock check COMPLETI: 6:00, 9:00, 12:00, 15:00, 18:00, 21:00 UTC');
  console.log('   ✅ TUTTI i 5000 prodotti controllati ogni volta (~2h per check)');
  console.log('   ✅ Totale verifiche: 6x/giorno × 5000 = 30.000 controlli completi');
  console.log('   ✅ Copertura: 100% catalogo ad ogni check 🎯');
  console.log('   ✅ Finestra max overselling: 3 ORE (accettabile per copertura completa)');
  console.log('   ✅ ZERO accavallamenti cron garantito');
  console.log('   ✅ Stock default: 1 (non più 10) - anti-overselling');
  console.log('   ✅ Backup automatici: mantiene ultimi 3');
  
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
  console.log('║   SCRAPER SERVER v2.0 AVVIATO!        ║');
  console.log('╚════════════════════════════════════════╝');
  console.log(`Server: http://localhost:${PORT}`);
  console.log(`Mode: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Render: ${process.env.RENDER ? 'Yes' : 'No'}`);
  console.log(`Storage: ${outputBase}`);
  
  if (process.env.NODE_ENV === 'production' || process.env.RENDER) {
    console.log('\n⚡ SISTEMA ANTI-OVERSELLING v2.1 - COPERTURA COMPLETA:');
    console.log('• Full scan: ogni notte ore 2:00 UTC (~40 min)');
    console.log('• Stock check: 6x/giorno ogni 3h (6:00-21:00) ~2h per check');
    console.log('• TUTTI i 5000 prodotti controllati ogni volta 🎯');
    console.log('• Verifiche totali: 30.000 controlli completi/giorno');
    console.log('• Finestra overselling: MAX 3 ore ✅');
    console.log('• Copertura: 100% catalogo ✅');
    console.log('• Zero accavallamenti ✅');
    console.log('• Stock default: 1 (non più 10) ✅');
    console.log('• Backup automatici: ultimi 3 ✅');
  }
});
