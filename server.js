// SCRAPER SETUP:
// - scraper_componenti_wpai_min.js: Full scan notturno LENTO (4h) con checkpoint
// - stock-checker-light.js: Stock check veloce (1.5h) solo stock/quantity
// - scraper_componenti_enterprise.js: NON USATO (sostituito da wpai_min con checkpoint)

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

// File paths
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

// Helper per check esistenza file
function getLatestCsvPath() {
  if (fs.existsSync(csvLatestPath)) return csvLatestPath;
  if (fs.existsSync(csvMinPath)) return csvMinPath;
  return null;
}

// Dashboard principale
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
        button.danger { background: #ef4444; }
        button.danger:hover { background: #dc2626; }
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
          word-wrap: break-word;
        }
        .alert {
          background: #fef3c7;
          border-left: 4px solid #f59e0b;
          padding: 15px;
          margin: 20px 0;
          border-radius: 5px;
        }
        .success { background: #d1fae5; border-left-color: #10b981; }
        .info { background: #dbeafe; border-left-color: #3b82f6; }
        .files { list-style: none; }
        .files li { 
          padding: 8px; 
          margin: 5px 0; 
          background: #f3f4f6; 
          border-radius: 5px;
          display: flex;
          justify-content: space-between;
          align-items: center;
        }
        .badge {
          background: #667eea;
          color: white;
          padding: 4px 12px;
          border-radius: 12px;
          font-size: 11px;
          font-weight: bold;
          display: inline-block;
          margin-bottom: 10px;
        }
        .badge.green { background: #10b981; }
        .badge.red { background: #ef4444; }
        .badge.orange { background: #f59e0b; }
        .system-health {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
          gap: 10px;
          margin-top: 10px;
        }
        .health-item {
          background: #f9fafb;
          padding: 10px;
          border-radius: 5px;
          text-align: center;
        }
        .health-value {
          font-size: 1.5em;
          font-weight: bold;
          color: #667eea;
        }
        .health-label {
          font-size: 0.8em;
          color: #666;
          margin-top: 5px;
        }
        .progress-bar {
          width: 100%;
          height: 20px;
          background: #e5e7eb;
          border-radius: 10px;
          overflow: hidden;
          margin-top: 10px;
        }
        .progress-fill {
          height: 100%;
          background: linear-gradient(90deg, #667eea, #764ba2);
          transition: width 0.3s;
          display: flex;
          align-items: center;
          justify-content: center;
          color: white;
          font-size: 12px;
          font-weight: bold;
        }
        .section-divider {
          border-top: 2px solid rgba(255,255,255,0.2);
          margin: 15px 0;
          padding-top: 15px;
        }
        .lock-indicator {
          display: inline-block;
          width: 10px;
          height: 10px;
          border-radius: 50%;
          margin-right: 8px;
        }
        .lock-indicator.active { background: #ef4444; animation: pulse 2s infinite; }
        .lock-indicator.idle { background: #10b981; }
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>🚀 Scraper Componenti Digitali - Dashboard v2.4</h1>
        
        <div class="alert">
          <strong>✅ SISTEMA FINALE v2.4:</strong><br>
          • <strong>Full scan notturno (00:00 UTC):</strong> LENTO 4h - Tutti i dati (prezzi, stock, immagini, attributi)<br>
          • <strong>Stock check veloce (6-22 ogni 2h):</strong> VELOCE 1.5h - Solo stock e quantità<br>
          • <strong>45.000 verifiche stock/giorno</strong> ✅<br>
          • <strong>Finestra overselling: MAX 2 ORE</strong> ✅<br>
          • <strong>Sistema di LOCK anti-sovrapposizione</strong> ✅
        </div>

        <div class="grid">
          <div class="card">
            <h2>📦 Prodotti Totali</h2>
            <div class="stat">${stats.totalProducts.toLocaleString()}</div>
            <div class="label">Nel CSV</div>
            <div class="badge green">Database Completo</div>
          </div>

          <div class="card">
            <h2>✅ In Stock</h2>
            <div class="stat">${stats.inStock.toLocaleString()}</div>
            <div class="label">${stats.inStockPercent}% disponibili</div>
            <div class="progress-bar">
              <div class="progress-fill" style="width: ${stats.inStockPercent}%">${stats.inStockPercent}%</div>
            </div>
          </div>

          <div class="card">
            <h2>❌ Out of Stock</h2>
            <div class="stat">${stats.outOfStock.toLocaleString()}</div>
            <div class="label">${stats.outOfStockPercent}% esauriti</div>
            <div class="progress-bar">
              <div class="progress-fill" style="width: ${stats.outOfStockPercent}%; background: #ef4444;">${stats.outOfStockPercent}%</div>
            </div>
          </div>

          <div class="card">
            <h2>🕐 Ultimo Update</h2>
            <div class="stat" style="font-size: 1.2em;">${stats.timeSince}</div>
            <div class="label">${stats.lastUpdate}</div>
          </div>

          <div class="card">
            <h2>💾 CSV Size</h2>
            <div class="stat">${stats.csvSize} MB</div>
            <div class="label">${stats.csvFiles.length} file disponibili</div>
          </div>

          <div class="card">
            <h2>🖼️ Immagini</h2>
            <div class="stat">${stats.imagesCount.toLocaleString()}</div>
            <div class="label">Scaricate (${stats.imagesSize} MB)</div>
          </div>
        </div>

        <div class="card" style="margin-top: 20px;">
          <h2>⚙️ Controlli Manuali</h2>
          
          <div style="margin-bottom: 20px;">
            <div style="display: flex; align-items: center; margin-bottom: 10px;">
              <span class="lock-indicator ${stats.scraperLock ? 'active' : 'idle'}"></span>
              <span class="badge orange">🔄 Full Scan (Tutti i dati - 2-4h)</span>
              ${stats.scraperLock ? '<span style="margin-left: 10px; color: #ef4444; font-weight: bold;">IN CORSO</span>' : ''}
            </div>
            <button onclick="runFullScan(5)" class="enterprise">Test 5 pagine (~10 min)</button>
            <button onclick="runFullScan(20)" class="enterprise">Test 20 pagine (~40 min)</button>
            <button onclick="runFullScan(50)" class="enterprise">Scan 50 pagine (~1.5 h)</button>
            <button onclick="runFullScan(200)" class="enterprise">Full 200 pagine (~4 h)</button>
            ${stats.scraperLock ? '<button onclick="stopFullScan()" class="danger">⏹️ Stop Full Scan</button>' : ''}
          </div>
          
          <div class="section-divider"></div>
          
          <div>
            <div style="display: flex; align-items: center; margin-bottom: 10px;">
              <span class="lock-indicator ${stats.stockCheckerLock ? 'active' : 'idle'}"></span>
              <span class="badge green">📊 Stock Check (Solo stock - max 1.5h)</span>
              ${stats.stockCheckerLock ? '<span style="margin-left: 10px; color: #ef4444; font-weight: bold;">IN CORSO</span>' : ''}
            </div>
            <button class="stock" onclick="runStockCheck(100)">Test 100 prodotti (~10 min)</button>
            <button class="stock" onclick="runStockCheck(500)">Check 500 prodotti (~30 min)</button>
            <button class="stock" onclick="runStockCheck(1000)">Check 1000 prodotti (~1 h)</button>
            <button class="stock" onclick="runStockCheck(5000)">Full 5000 prodotti (~1.5 h)</button>
            ${stats.stockCheckerLock ? '<button onclick="stopStockCheck()" class="danger">⏹️ Stop Stock Check</button>' : ''}
          </div>
        </div>

        ${stats.checkpoint ? `
        <div class="card" style="margin-top: 20px;">
          <h2>🔄 Checkpoint Scraper Attivo</h2>
          <div class="alert info">
            <strong>Resume disponibile:</strong><br>
            Pagina corrente: ${stats.checkpoint.currentPage || 'N/A'}<br>
            Prodotti trovati: ${stats.checkpoint.productsCount || 0}<br>
            Timestamp: ${new Date(stats.checkpoint.timestamp).toLocaleString('it-IT')}
          </div>
        </div>
        ` : ''}

        ${stats.stockProgress ? `
        <div class="card" style="margin-top: 20px;">
          <h2>📊 Stock Check in Corso</h2>
          <div class="alert info">
            <strong>Progresso:</strong><br>
            Prodotti controllati: ${stats.stockProgress.checked || 0} / ${stats.stockProgress.total || 0}<br>
            Aggiornati: ${stats.stockProgress.updated || 0}<br>
            Nuovi esauriti: ${stats.stockProgress.newOutOfStock || 0}<br>
            Tornati disponibili: ${stats.stockProgress.backInStock || 0}<br>
            In corso da: ${new Date(stats.stockProgress.timestamp).toLocaleString('it-IT')}
            <div class="progress-bar" style="margin-top: 10px;">
              <div class="progress-fill" style="width: ${Math.round((stats.stockProgress.checked / stats.stockProgress.total) * 100)}%">
                ${Math.round((stats.stockProgress.checked / stats.stockProgress.total) * 100)}%
              </div>
            </div>
          </div>
        </div>
        ` : ''}

        <div class="card" style="margin-top: 20px;">
          <h2>💻 Sistema Health</h2>
          <div class="system-health">
            <div class="health-item">
              <div class="health-value">${stats.uptime}</div>
              <div class="health-label">Uptime</div>
            </div>
            <div class="health-item">
              <div class="health-value">${stats.memory.used} MB</div>
              <div class="health-label">Memory (${stats.memory.percent}%)</div>
            </div>
            <div class="health-item">
              <div class="health-value">${stats.cpu.toFixed(1)}%</div>
              <div class="health-label">CPU Load</div>
            </div>
            <div class="health-item">
              <div class="health-value">${stats.disk.used} GB</div>
              <div class="health-label">Disk (${stats.disk.percent}%)</div>
            </div>
          </div>
        </div>

        <div class="card" style="margin-top: 20px;">
          <h2>📄 File CSV</h2>
          <ul class="files">
            ${stats.csvFiles.map(f => `
              <li>
                <span>${f}</span>
                <a href="${base}/output/${f}" download>
                  <button style="margin: 0; padding: 8px 16px; font-size: 12px;">⬇️ Download</button>
                </a>
              </li>
            `).join('')}
          </ul>
        </div>

        <div class="card" style="margin-top: 20px;">
          <h2>📋 Ultimi Log (50 righe)</h2>
          <div class="logs">${stats.logs}</div>
        </div>
      </div>

      <script>
        function runFullScan(pages) {
          if (confirm('🔄 Avviare FULL SCAN su ' + pages + ' pagine?\\n\\n⏱️ Durata stimata: ~' + Math.ceil(pages * 1.2) + ' minuti\\n\\n📋 Questa operazione:\\n• Aggiorna TUTTI i dati (prezzi, nomi, descrizioni)\\n• Scarica/aggiorna immagini\\n• Crea nuovo CSV completo\\n• Può richiedere diverse ore per 200 pagine\\n\\n⚠️ Non lanciare se uno scan è già attivo!')) {
            fetch('/run-full-scan?pages=' + pages, { method: 'POST' })
              .then(r => r.json())
              .then(data => {
                if (data.success) {
                  alert('✅ ' + data.message + '\\n\\n⏱️ Tempo previsto: ' + data.estimatedTime + '\\n\\n💡 Aggiorna la pagina tra qualche minuto per vedere i progressi.');
                } else {
                  alert('⚠️ ' + data.message);
                }
                setTimeout(() => location.reload(), 2000);
              })
              .catch(e => alert('❌ Errore: ' + e));
          }
        }

        function runStockCheck(num) {
          if (confirm('📊 Avviare stock check su ' + num + ' prodotti?\\n\\n⏱️ Durata stimata: ~' + Math.ceil(num/60) + ' minuti\\n\\n📋 Questa operazione:\\n• Controlla solo disponibilità e quantità\\n• NON aggiorna prezzi o altri dati\\n• Veloce e leggero')) {
            fetch('/run-stock-check?limit=' + num, { method: 'POST' })
              .then(r => r.json())
              .then(data => {
                if (data.success) {
                  alert('✅ ' + data.message + '\\n\\n⏱️ Tempo previsto: ' + data.estimatedTime);
                } else {
                  alert('⚠️ ' + data.message);
                }
                setTimeout(() => location.reload(), 2000);
              })
              .catch(e => alert('❌ Errore: ' + e));
          }
        }

        function stopFullScan() {
          if (confirm('⚠️ Fermare il Full Scan in corso?\\n\\n• Il checkpoint verrà salvato\\n• Potrai riprendere in seguito dalla stessa pagina')) {
            fetch('/stop-full-scan', { method: 'POST' })
              .then(r => r.json())
              .then(data => {
                alert(data.message);
                setTimeout(() => location.reload(), 2000);
              })
              .catch(e => alert('Errore: ' + e));
          }
        }

        function stopStockCheck() {
          if (confirm('⚠️ Fermare lo Stock Check in corso?\\n\\n• Il progresso verrà salvato\\n• I dati già raccolti verranno mantenuti')) {
            fetch('/stop-stock-check', { method: 'POST' })
              .then(r => r.json())
              .then(data => {
                alert(data.message);
                setTimeout(() => location.reload(), 2000);
              })
              .catch(e => alert('Errore: ' + e));
          }
        }

        // Auto-refresh ogni 30 secondi
        setTimeout(() => location.reload(), 30000);
      </script>
    </body>
    </html>
  `);
});

// 🆕 Endpoint per lanciare FULL SCAN manuale
app.post('/run-full-scan', (req, res) => {
  const pages = req.query.pages || 200;
  
  // Verifica se scraper già in corso
  const scraperLockPath = path.join(outputDir, 'scraper.lock');
  if (fs.existsSync(scraperLockPath)) {
    const lockData = JSON.parse(fs.readFileSync(scraperLockPath, 'utf8'));
    const lockAge = Date.now() - lockData.timestamp;
    
    // Se lock ha più di 4 ore, è stale
    if (lockAge < 14400000) {
      return res.json({ 
        success: false,
        message: 'Full scan già in corso! Avviato da ' + Math.floor(lockAge / 60000) + ' minuti.'
      });
    } else {
      // Rimuovi lock stale
      fs.unlinkSync(scraperLockPath);
    }
  }
  
  // Crea lock file
  fs.writeFileSync(scraperLockPath, JSON.stringify({
    pid: process.pid,
    timestamp: Date.now(),
    startedAt: new Date().toISOString(),
    pages: pages
  }));
  
  spawn('node', ['scraper_componenti_wpai_min.js', pages], {
    detached: true,
    stdio: 'ignore'
  }).unref();
  
  res.json({ 
    success: true,
    message: `Full scan avviato per ${pages} pagine.`,
    estimatedTime: `${Math.ceil(pages * 1.2)} minuti (~${(pages * 1.2 / 60).toFixed(1)} ore)`
  });
});

// 🆕 Endpoint per fermare Full Scan
app.post('/stop-full-scan', (req, res) => {
  const { exec } = require('child_process');
  
  exec('pkill -SIGTERM -f scraper_componenti_wpai_min.js', (error) => {
    if (error) {
      return res.json({ 
        success: false,
        message: 'Nessun Full Scan in corso da fermare.'
      });
    }
    
    // Rimuovi lock
    const scraperLockPath = path.join(outputDir, 'scraper.lock');
    if (fs.existsSync(scraperLockPath)) {
      fs.unlinkSync(scraperLockPath);
    }
    
    res.json({ 
      success: true,
      message: 'Full Scan fermato. Checkpoint salvato.' 
    });
  });
});

// Endpoint per eseguire stock check manuale
app.post('/run-stock-check', (req, res) => {
  const limit = req.query.limit || 100;
  
  // Verifica se stock-checker già in corso
  const stockLockPath = path.join(outputDir, 'stock_checker.lock');
  if (fs.existsSync(stockLockPath)) {
    const lockData = JSON.parse(fs.readFileSync(stockLockPath, 'utf8'));
    const lockAge = Date.now() - lockData.timestamp;
    
    // Se lock ha più di 2 ore, è stale
    if (lockAge < 7200000) {
      return res.json({ 
        success: false,
        message: 'Stock check già in corso! Avviato da ' + Math.floor(lockAge / 60000) + ' minuti.'
      });
    } else {
      fs.unlinkSync(stockLockPath);
    }
  }
  
  spawn('node', ['stock-checker-light.js', limit], {
    detached: true,
    stdio: 'ignore'
  }).unref();
  
  res.json({ 
    success: true,
    message: `Stock check avviato per ${limit} prodotti.`,
    estimatedTime: Math.ceil(limit / 60) + ' minuti'
  });
});

// 🆕 Endpoint per fermare Stock Check
app.post('/stop-stock-check', (req, res) => {
  const { exec } = require('child_process');
  
  exec('pkill -SIGTERM -f stock-checker-light.js', (error) => {
    if (error) {
      return res.json({ 
        success: false,
        message: 'Nessuno Stock Check in corso da fermare.'
      });
    }
    
    const stockLockPath = path.join(outputDir, 'stock_checker.lock');
    if (fs.existsSync(stockLockPath)) {
      fs.unlinkSync(stockLockPath);
    }
    
    res.json({ 
      success: true,
      message: 'Stock Check fermato. Progresso salvato.' 
    });
  });
});

// Health check per Render
app.get('/healthz', (req, res) => {
  res.status(200).send('OK');
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
    scraperLock: null,
    stockCheckerLock: null,
    uptime: formatUptime(process.uptime()),
    memory: getMemoryStats(),
    cpu: getCPULoad(),
    disk: getDiskStats(),
    inStock: 0,
    outOfStock: 0,
    inStockPercent: 0,
    outOfStockPercent: 0
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
            
            const headers = parseCSVLine(lines[0]).map(h => 
              h.toLowerCase().replace(/[\s_]+/g, '')
            );
            
            const stockStatusIndex = headers.findIndex(h => h.includes('stockstatus'));
            const stockQtyIndex = headers.findIndex(h => h.includes('stockquantity'));
            
            for (let i = 1; i < lines.length; i++) {
              const cols = parseCSVLine(lines[i]);
              const stockStatus = cols[stockStatusIndex]?.toLowerCase() || '';
              const stockQty = parseInt(cols[stockQtyIndex]) || 0;
              
              if (stockStatus.includes('instock') || stockQty > 0) {
                stats.inStock++;
              } else {
                stats.outOfStock++;
              }
            }
            
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
      
      // Scraper checkpoint
      const checkpointPath = path.join(outputDir, 'scraper_checkpoint.json');
      if (fs.existsSync(checkpointPath)) {
        stats.checkpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
      }
      
      // Scraper lock
      const scraperLockPath = path.join(outputDir, 'scraper.lock');
      if (fs.existsSync(scraperLockPath)) {
        stats.scraperLock = JSON.parse(fs.readFileSync(scraperLockPath, 'utf8'));
      }
      
      // Stock checker progress
      const stockProgressPath = path.join(outputDir, 'stock_checker_progress.json');
      if (fs.existsSync(stockProgressPath)) {
        stats.stockProgress = JSON.parse(fs.readFileSync(stockProgressPath, 'utf8'));
      }
      
      // Stock checker lock
      const stockLockPath = path.join(outputDir, 'stock_checker.lock');
      if (fs.existsSync(stockLockPath)) {
        stats.stockCheckerLock = JSON.parse(fs.readFileSync(stockLockPath, 'utf8'));
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
  const cpus = require('os').cpus();
  let totalIdle = 0, totalTick = 0;
  
  cpus.forEach(cpu => {
    for (let type in cpu.times) {
      totalTick += cpu.times[type];
    }
    totalIdle += cpu.times.idle;
  });
  
  return 100 - Math.round(100 * totalIdle / totalTick);
}

function getDiskStats() {
  try {
    const stats = fs.statfsSync(outputDir);
    const total = (stats.blocks * stats.bsize) / (1024 ** 3);
    const free = (stats.bfree * stats.bsize) / (1024 ** 3);
    const used = total - free;
    const percent = Math.round((used / total) * 100);
    return { used: used.toFixed(1), total: total.toFixed(1), percent };
  } catch {
    return { used: 0, total: 0, percent: 0 };
  }
}

// Avvia server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server v2.4 avviato su porta ${PORT}`);
  console.log(`📊 Dashboard: http://localhost:${PORT}`);
  console.log(`📁 Output directory: ${outputDir}`);
  
  // Setup cron jobs solo in produzione
  if (process.env.NODE_ENV === 'production' || process.env.RENDER) {
    console.log('\n🔧 Configurazione CRON jobs...');
  
  // ✅ Full scan SOLO mezzanotte - LENTO per accuratezza
  cron.schedule('0 0 * * *', () => {
    console.log('[CRON] Full scan notturno LENTO - 200 pagine ~4h (tutti i dati)');
    
    // Verifica lock prima di lanciare
    const scraperLockPath = path.join(outputDir, 'scraper.lock');
    if (fs.existsSync(scraperLockPath)) {
      console.log('[CRON] ⚠️ Full scan già in corso, skip');
      return;
    }
    
    spawn('node', ['scraper_componenti_wpai_min.js', '200'], {
      detached: true,
      stdio: 'ignore'
    }).unref();
  });
  
  // ✅ Stock check ogni 2h dalle 6 alle 22 - VELOCE
  cron.schedule('0 6,8,10,12,14,16,18,20,22 * * *', () => {
    console.log('[CRON] Stock check VELOCE - 5000 prodotti ~1.5h (solo stock/quantity)');
    
    // Verifica lock prima di lanciare
    const stockLockPath = path.join(outputDir, 'stock_checker.lock');
    if (fs.existsSync(stockLockPath)) {
      console.log('[CRON] ⚠️ Stock check già in corso, skip questo turno');
      return;
    }
    
    spawn('node', ['stock-checker-light.js', '5000'], {
      detached: true,
      stdio: 'ignore'
    }).unref();
  });
  
  console.log('⏰ CRON CONFIGURATI:');
  console.log('   ✅ Full scan: SOLO 00:00 UTC - LENTO (4h) per massima accuratezza');
  console.log('   ✅ Stock check: 6,8,10,12,14,16,18,20,22 UTC - VELOCE (1.5h) solo stock');
  console.log('   ✅ 9 check/giorno × 5000 = 45.000 verifiche stock');
  console.log('   ✅ Sistema LOCK anti-sovrapposizione attivo');
  }
  
  if (process.env.NODE_ENV === 'production' || process.env.RENDER) {
    console.log('\n⚡ SISTEMA FINALE v2.4:');
    console.log('• Full scan notturno 00:00 UTC: LENTO 4h (tutti i dati)');
    console.log('• Stock check 6-22 ogni 2h: VELOCE 1.5h (solo stock)');
    console.log('• 45.000 verifiche stock/giorno');
    console.log('• Checkpoint anti-crash attivo');
    console.log('• Sistema LOCK per evitare sovrapposizioni');
  }
});
