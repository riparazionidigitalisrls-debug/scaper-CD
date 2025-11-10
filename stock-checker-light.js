// stock-checker-light.js
// Stock checker leggero che aggiorna solo stock_quantity e stock_status

const { chromium } = require('playwright');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

class StockCheckerLight {
  constructor() {
    // Base URL
    this.baseUrl = 'https://www.componentidigitali.com';
    
    const baseDir = process.env.DATA_DIR || (process.env.RENDER ? '/data' : '.');
    this.outputDir = path.join(baseDir, 'output');
    this.csvLatestPath = path.join(this.outputDir, 'prodotti_latest.csv');
    this.csvBackupPath = path.join(this.outputDir, `backup_${Date.now()}.csv`);
    this.progressPath = path.join(this.outputDir, 'stock_checker_progress.json');
    this.logPath = path.join(this.outputDir, `stock_checker_${new Date().toISOString().split('T')[0]}.log`);
    
    // CONFIGURAZIONE BILANCIATA - 1.5 ore per 5000 prodotti
    this.config = {
      crawlDelay: 100,           // 100ms bilanciato
      batchSize: 300,            // Batch medi
      pauseBetweenBatches: 1000, // 1s tra batch
      maxProductsPerSession: 5000,
      sessionTimeout: 5400000,   // 1.5 ore max
      
      userAgents: [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      ],
      
      maxRetries: 1,
      retryDelay: 15000,         // 15s retry
      stopOnErrors: 10,
      randomizeOrder: true,
    };
    
    // Stato
    this.products = [];
    this.currentIndex = 0;
    this.stats = {
      checked: 0,
      updated: 0,
      errors: 0,
      newOutOfStock: 0,
      backInStock: 0
    };
  }

  log(message, level = 'INFO') {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] [${level}] ${message}`;
    console.log(line);
    try {
      fs.appendFileSync(this.logPath, line + '\n');
    } catch (e) {}
  }

  async loadProducts() {
    this.log('Caricamento prodotti dal CSV...');
    
    // Backup CSV prima di modificarlo
    try {
      await fsp.copyFile(this.csvLatestPath, this.csvBackupPath);
      this.log(`Backup creato: ${this.csvBackupPath}`);
      
      // Pulisci backup vecchi (mantieni ultimi 3)
      try {
        const backupFiles = fs.readdirSync(this.outputDir)
          .filter(f => f.startsWith('backup_') && f.endsWith('.csv'))
          .map(f => ({
            name: f,
            time: fs.statSync(path.join(this.outputDir, f)).mtime.getTime()
          }))
          .sort((a, b) => b.time - a.time);
        
        if (backupFiles.length > 3) {
          for (let i = 3; i < backupFiles.length; i++) {
            await fsp.unlink(path.join(this.outputDir, backupFiles[i].name));
            this.log(`Backup vecchio eliminato: ${backupFiles[i].name}`);
          }
        }
      } catch (e) {
        this.log(`Avviso: impossibile pulire backup vecchi: ${e.message}`, 'WARN');
      }
      
      // Leggi e parsa CSV
      const csvContent = await fsp.readFile(this.csvLatestPath, 'utf8');
      const lines = csvContent.split('\n').filter(l => l.trim());
      
      if (lines.length < 2) {
        this.log('CSV vuoto o corrotto', 'ERROR');
        return false;
      }
      
      const headers = this.parseCSVLine(lines[0]);
      const skuIndex = headers.findIndex(h => h.toLowerCase() === 'sku');
      const nameIndex = headers.findIndex(h => h.toLowerCase() === 'name');
      const stockQtyIndex = headers.findIndex(h => h.toLowerCase().includes('stock') && h.toLowerCase().includes('quantity'));
      const stockStatusIndex = headers.findIndex(h => h.toLowerCase().includes('stock') && h.toLowerCase().includes('status'));
      
      if (skuIndex === -1 || stockQtyIndex === -1) {
        this.log('Colonne SKU o Stock non trovate nel CSV', 'ERROR');
        return false;
      }
      
      // Carica progresso se esiste
      const hasProgress = await this.loadProgress();
      
      for (let i = 1; i < lines.length; i++) {
        const cols = this.parseCSVLine(lines[i]);
        if (cols.length < headers.length) continue;
        
        this.products.push({
          lineIndex: i,
          sku: cols[skuIndex],
          name: cols[nameIndex] || '',
          oldStock: parseInt(cols[stockQtyIndex]) || 0,
          oldStatus: cols[stockStatusIndex] || '',
          newStock: null,
          newStatus: null
        });
      }
      
      this.log(`Caricati ${this.products.length} prodotti dal CSV`);
      
      if (hasProgress) {
        this.log(`Resume da prodotto ${this.currentIndex}`);
      }
      
      return true;
    } catch (e) {
      this.log(`Errore caricamento prodotti: ${e.message}`, 'ERROR');
      return false;
    }
  }

  parseCSVLine(line) {
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

  async saveProgress() {
    try {
      const progress = {
        currentIndex: this.currentIndex,
        stats: this.stats,
        timestamp: Date.now(),
        total: this.products.length
      };
      
      await fsp.writeFile(this.progressPath, JSON.stringify(progress, null, 2));
    } catch (e) {
      this.log(`Errore salvataggio progress: ${e.message}`, 'WARN');
    }
  }

  async loadProgress() {
    try {
      if (fs.existsSync(this.progressPath)) {
        const data = await fsp.readFile(this.progressPath, 'utf8');
        const progress = JSON.parse(data);
        
        // Resume solo se < 24 ore
        const hoursOld = (Date.now() - progress.timestamp) / (1000 * 60 * 60);
        if (hoursOld < 24) {
          this.currentIndex = progress.currentIndex;
          this.stats = progress.stats;
          return true;
        }
      }
    } catch (e) {
      this.log(`Errore caricamento progress: ${e.message}`, 'WARN');
    }
    return false;
  }

  async checkProductStock(context, product) {
    const page = await context.newPage();
    
    try {
      // Costruisci URL ricerca per SKU
      const searchUrl = `${this.baseUrl}/default.asp?cmdString=${product.sku}&cmd=searchProd&bFormSearch=1`;
      
      this.log(`Checking: ${product.sku}`);
      
      // Naviga con timeout ridotto
      await page.goto(searchUrl, { 
        waitUntil: 'domcontentloaded',
        timeout: 10000  // 10s invece 30s
      });
      
      await page.waitForTimeout(100);  // 100ms invece 200ms
      
      // Estrai info disponibilità
      const stockInfo = await page.evaluate((targetSku) => {
        const bodyText = document.body.innerText || '';
        
        // Cerca indicatori di disponibilità
        let quantity = null;
        let available = null;
        
        // Pattern specifici per il sito
        const qtyMatch = bodyText.match(new RegExp(`${targetSku}[\\s\\S]*?Disponibile\\s*\\(\\s*(\\d+)\\s*PZ\\s*\\)`, 'i'));
        if (qtyMatch) {
          quantity = parseInt(qtyMatch[1]);
          available = true;
        } else if (bodyText.match(new RegExp(`${targetSku}[\\s\\S]*?(?:non\\s+disponibile|esaurito|sold\\s*out)`, 'i'))) {
          quantity = 0;
          available = false;
        } else if (bodyText.match(new RegExp(`${targetSku}[\\s\\S]*?disponibile`, 'i'))) {
          quantity = 10; // Default conservativo
          available = true;
        }
        
        // Se non trova il prodotto specifico, controlla generale
        if (quantity === null) {
          const generalQty = bodyText.match(/Disponibile\s*\(\s*(\d+)\s*PZ\s*\)/i);
          if (generalQty) {
            quantity = parseInt(generalQty[1]);
            available = true;
          } else if (/non\s+disponibile|esaurito/i.test(bodyText)) {
            quantity = 0;
            available = false;
          }
        }
        
        return { quantity, available };
      }, product.sku);
      
      // Aggiorna prodotto
      if (stockInfo.quantity !== null) {
        product.newStock = stockInfo.quantity;
        product.newStatus = stockInfo.available ? 'instock' : 'outofstock';
        
        // Log cambiamenti importanti
        if (product.oldStock > 0 && stockInfo.quantity === 0) {
          this.log(`📉 Esaurito: ${product.sku} (era ${product.oldStock})`);
          this.stats.newOutOfStock++;
        } else if (product.oldStock === 0 && stockInfo.quantity > 0) {
          this.log(`📈 Disponibile: ${product.sku} (ora ${stockInfo.quantity})`);
          this.stats.backInStock++;
        }
        
        this.stats.updated++;
      } else {
        this.log(`⚠️ Nessun dato stock per ${product.sku}`, 'WARN');
      }
      
      await page.close();
      return true;
    } catch (e) {
      this.log(`❌ Errore check ${product.sku}: ${e.message}`, 'ERROR');
      this.stats.errors++;
      await page.close();
      return false;
    }
  }

  async checkAllProducts() {
    this.log('Avvio check stock prodotti...');
    
    const browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    });
    
    try {
      const context = await browser.newContext({
        userAgent: this.config.userAgents[Math.floor(Math.random() * this.config.userAgents.length)]
      });
      
      // Randomizza ordine se richiesto
      if (this.config.randomizeOrder && this.currentIndex === 0) {
        for (let i = this.products.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [this.products[i], this.products[j]] = [this.products[j], this.products[i]];
        }
      }
      
      const sessionStart = Date.now();
      const productsToCheck = Math.min(this.config.maxProductsPerSession, this.products.length);
      
      this.log(`Controllo ${productsToCheck} prodotti (da ${this.currentIndex})`);
      
      let consecutiveErrors = 0;
      let batchCount = 0;
      
      while (this.currentIndex < this.products.length && this.stats.checked < productsToCheck) {
        const product = this.products[this.currentIndex];
        this.currentIndex++;
        
        const success = await this.checkProductStock(context, product);
        
        if (success) {
          consecutiveErrors = 0;
          this.stats.checked++;
        } else {
          consecutiveErrors++;
          if (consecutiveErrors >= this.config.stopOnErrors) {
            this.log(`❌ Troppi errori consecutivi (${consecutiveErrors}), stop`, 'ERROR');
            break;
          }
        }
        
        // Cambio context ogni 3 batch
        batchCount++;
        if (batchCount % (this.config.batchSize * 3) === 0) {
          await context.close();
          await new Promise(resolve => setTimeout(resolve, 3000));
          const newContext = await browser.newContext({
            userAgent: this.config.userAgents[Math.floor(Math.random() * this.config.userAgents.length)]
          });
          Object.assign(context, newContext);
        }
        
        // Log progresso ogni 5 prodotti
        if (this.stats.checked % 5 === 0) {
          const elapsed = Math.floor((Date.now() - sessionStart) / 1000);
          const rate = this.stats.checked / (elapsed || 1);
          const remaining = Math.floor((productsToCheck - this.stats.checked) / rate);
          this.log(`Progress: ${this.stats.checked}/${productsToCheck} (${remaining}s rimanenti)`);
        }
        
        // Salva progresso ogni 10 prodotti
        if (this.stats.checked % 10 === 0) {
          await this.saveProgress();
          
          // Pausa tra batch
          if (this.stats.checked % this.config.batchSize === 0) {
            await new Promise(resolve => setTimeout(resolve, this.config.pauseBetweenBatches));
          }
        }
        
        // Delay tra prodotti
        if (this.currentIndex < this.products.length && this.stats.checked < productsToCheck) {
          const delay = this.config.crawlDelay + Math.random() * 50; // 50-100ms
          await new Promise(resolve => setTimeout(resolve, delay));
        }
        
        // Check timeout sessione
        if (Date.now() - sessionStart > this.config.sessionTimeout) {
          this.log('⏰ Timeout sessione raggiunto (1.5 ore). Salvataggio e uscita.');
          break;
        }
        
        // Safety: rispetta crawlDelay minimo
        if (this.stats.checked % 100 === 0) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
      
      await context.close();
    } finally {
      await browser.close();
    }
  }

  async saveCSV() {
    this.log('Salvataggio CSV aggiornato...');
    
    try {
      const csvContent = await fsp.readFile(this.csvLatestPath, 'utf8');
      const lines = csvContent.split('\n');
      
      const headers = this.parseCSVLine(lines[0]);
      const stockQtyIndex = headers.findIndex(h => h.toLowerCase().includes('stock') && h.toLowerCase().includes('quantity'));
      const stockStatusIndex = headers.findIndex(h => h.toLowerCase().includes('stock') && h.toLowerCase().includes('status'));
      
      // Aggiorna righe con nuovi stock
      for (const product of this.products) {
        if (product.newStock === null) continue;
        
        const cols = this.parseCSVLine(lines[product.lineIndex]);
        cols[stockQtyIndex] = product.newStock.toString();
        cols[stockStatusIndex] = product.newStatus;
        
        // Ricostruisci riga CSV quotando campi con virgole
        lines[product.lineIndex] = cols.map(col => 
          col.includes(',') ? `"${col}"` : col
        ).join(',');
      }
      
      // Scrivi CSV aggiornato
      await fsp.writeFile(this.csvLatestPath, lines.join('\n'));
      
      this.log(`✅ CSV aggiornato: ${this.stats.updated} prodotti modificati`);
    } catch (e) {
      this.log(`❌ Errore salvataggio CSV: ${e.message}`, 'ERROR');
      throw e;
    }
  }

  async run(maxProducts) {
    const startTime = Date.now();
    
    if (maxProducts) {
      this.config.maxProductsPerSession = parseInt(maxProducts);
    }
    
    this.log('=== STOCK CHECKER AVVIATO ===');
    this.log(`Configurazione: max ${this.config.maxProductsPerSession} prodotti`);
    
    if (!await this.loadProducts()) {
      this.log('Impossibile caricare prodotti, uscita', 'ERROR');
      return;
    }
    
    await this.checkAllProducts();
    await this.saveCSV();
    
    const duration = Math.floor((Date.now() - startTime) / 1000 / 60);
    
    this.log('=== STOCK CHECK COMPLETATO ===');
    this.log(`Durata totale: ${duration} minuti`);
    this.log(`Prodotti controllati: ${this.stats.checked}`);
    this.log(`Prodotti aggiornati: ${this.stats.updated}`);
    this.log(`Nuovi out of stock: ${this.stats.newOutOfStock}`);
    this.log(`Tornati disponibili: ${this.stats.backInStock}`);
    this.log(`Errori: ${this.stats.errors}`);
    
    // Elimina progress file se completato
    try {
      if (this.currentIndex >= this.products.length) {
        await fsp.unlink(this.progressPath);
        this.log('✓ Check completo, progress file eliminato');
      }
    } catch (e) {}
  }
}

// Esegui
const maxProducts = process.argv[2] || 5000;

const checker = new StockCheckerLight();
checker.run(maxProducts).catch(err => {
  console.error('[STOCK CHECKER FATAL]:', err);
  process.exit(1);
});

// Gestione SIGTERM
process.on('SIGTERM', () => {
  console.log('SIGTERM ricevuto, arresto in corso...');
  checker.saveProgress().then(() => {
    process.exit(0);
  });
});
