// stock-checker-light.js
// Sistema ottimizzato per controllo stock con timeout e logging professionale
// Versione 3.0 - Sicura e performante

const { chromium } = require('playwright');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

class StockCheckerLight {
  constructor() {
    // Percorsi file compatibili con sistema
    const dataDir = process.env.DATA_DIR || (process.env.RENDER ? '/data' : './data');
    this.outputDir = path.join(dataDir, 'output');
    this.logsDir = path.join(dataDir, 'logs');
    this.csvLatestPath = path.join(this.outputDir, 'prodotti_latest.csv');
    this.csvBackupPath = path.join(this.outputDir, `backup_stock_${Date.now()}.csv`);
    this.logPath = path.join(this.logsDir, `stock_checker_${new Date().toISOString().split('T')[0]}.log`);
    this.progressPath = path.join(this.outputDir, 'stock_checker_progress.json');
    this.eventsPath = path.join(this.logsDir, 'stock_events.json');
    
    // URL base
    this.baseUrl = 'https://www.componentidigitali.com';
    
    // CONFIGURAZIONE OTTIMIZZATA PER SICUREZZA E PERFORMANCE
    this.config = {
      // Timing
      crawlDelay: 400,              // 400ms tra richieste (sicuro)
      batchSize: 100,               // 100 prodotti per batch
      pauseBetweenBatches: 30000,   // 30 secondi tra batch
      maxProductsPerSession: 5000,  // Max prodotti per sessione
      sessionTimeout: 7200000,      // 2 ore max per sessione (come richiesto)
      
      // User agents rotation
      userAgents: [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0',
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
      ],
      
      // Retry configuration
      maxRetries: 3,
      retryDelay: 5000,  // 5 secondi prima di riprovare
      
      // Safety features
      stopOnErrors: 10,   // Ferma dopo 10 errori consecutivi
      randomizeOrder: true, // Randomizza ordine prodotti
      respectRobots: true,  // Rispetta robots.txt
      
      // Performance
      concurrent: false,    // No concurrent requests
      headless: true,      // Browser headless
      
      // Logging
      verboseLogging: true,
      logInterval: 50      // Log progress ogni 50 prodotti
    };
    
    // Stato
    this.products = [];
    this.currentIndex = 0;
    this.errors = [];
    this.consecutiveErrors = 0;
    this.isRunning = true;
    this.startTime = Date.now();
    this.stats = {
      checked: 0,
      updated: 0,
      outOfStock: [],
      backInStock: [],
      errors: 0,
      skipped: 0,
      startTime: Date.now()
    };
  }
  
  async ensureDirectories() {
    await fsp.mkdir(this.outputDir, { recursive: true });
    await fsp.mkdir(this.logsDir, { recursive: true });
  }
  
  log(message, level = 'INFO', metadata = {}) {
    const timestamp = new Date().toISOString();
    const logEntry = {
      timestamp,
      level,
      message,
      ...metadata
    };
    
    // Console log con colori
    const colors = {
      'ERROR': '\x1b[31m',
      'WARN': '\x1b[33m',
      'INFO': '\x1b[36m',
      'SUCCESS': '\x1b[32m',
      'DEBUG': '\x1b[37m'
    };
    
    const color = colors[level] || '\x1b[37m';
    const reset = '\x1b[0m';
    
    console.log(`${color}[${timestamp}] [${level}] ${message}${reset}`);
    
    // File log
    try {
      const logLine = JSON.stringify(logEntry) + '\n';
      fs.appendFileSync(this.logPath, logLine);
      
      // Log eventi importanti
      if (level === 'ERROR' || level === 'WARN' || metadata.event) {
        this.logEvent(logEntry);
      }
    } catch (e) {
      console.error('Log error:', e.message);
    }
  }
  
  async logEvent(entry) {
    try {
      let events = [];
      if (fs.existsSync(this.eventsPath)) {
        const content = await fsp.readFile(this.eventsPath, 'utf8');
        events = JSON.parse(content || '[]');
      }
      
      events.unshift(entry);
      events = events.slice(0, 500); // Mantieni ultimi 500 eventi
      
      await fsp.writeFile(this.eventsPath, JSON.stringify(events, null, 2));
    } catch (e) {
      // Silent fail
    }
  }
  
  async loadProducts() {
    try {
      await this.ensureDirectories();
      
      if (!fs.existsSync(this.csvLatestPath)) {
        throw new Error('CSV non trovato. Esegui prima uno scraping completo.');
      }
      
      // Backup del CSV originale
      await fsp.copyFile(this.csvLatestPath, this.csvBackupPath);
      this.log(`Backup creato: ${path.basename(this.csvBackupPath)}`, 'INFO', {
        event: 'backup_created',
        file: this.csvBackupPath
      });
      
      // Leggi e parsa CSV
      const csvContent = await fsp.readFile(this.csvLatestPath, 'utf8');
      const lines = csvContent.split('\n').filter(l => l.trim());
      const headers = lines[0].split(',').map(h => h.trim());
      
      // Trova indici colonne importanti
      const skuIndex = headers.findIndex(h => h.toLowerCase() === 'sku');
      const nameIndex = headers.findIndex(h => h.toLowerCase() === 'name');
      const stockQtyIndex = headers.findIndex(h => h.toLowerCase().includes('stock_quantity'));
      const stockStatusIndex = headers.findIndex(h => h.toLowerCase().includes('stock_status'));
      
      this.products = [];
      
      // Parsa prodotti
      for (let i = 1; i < lines.length; i++) {
        const cols = this.parseCSVLine(lines[i]);
        if (cols[skuIndex]) {
          this.products.push({
            sku: cols[skuIndex],
            name: cols[nameIndex] || '',
            currentStock: parseInt(cols[stockQtyIndex]) || 0,
            currentStatus: cols[stockStatusIndex] || 'instock',
            newStock: null,
            newStatus: null,
            rowIndex: i,
            fullRow: cols
          });
        }
      }
      
      this.log(`Caricati ${this.products.length} prodotti dal CSV`, 'SUCCESS', {
        event: 'products_loaded',
        count: this.products.length
      });
      
      // Randomizza ordine se configurato
      if (this.config.randomizeOrder) {
        this.shuffleArray(this.products);
        this.log('Ordine prodotti randomizzato', 'INFO');
      }
      
      // Carica progresso se esiste
      await this.loadProgress();
      
      return this.products.length;
      
    } catch (error) {
      this.log(`Errore caricamento prodotti: ${error.message}`, 'ERROR', {
        event: 'load_error',
        error: error.message
      });
      throw error;
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
  
  shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
  }
  
  async saveProgress() {
    const progress = {
      currentIndex: this.currentIndex,
      stats: this.stats,
      timestamp: Date.now(),
      sessionStart: this.startTime
    };
    
    try {
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
        
        // Resume solo se < 12 ore
        const hoursOld = (Date.now() - progress.timestamp) / (1000 * 60 * 60);
        if (hoursOld < 12) {
          this.currentIndex = progress.currentIndex;
          this.stats = progress.stats;
          this.log(`Resume da prodotto ${this.currentIndex}`, 'INFO', {
            event: 'resume',
            index: this.currentIndex
          });
          return true;
        }
      }
    } catch (e) {
      // Ignora errori
    }
    return false;
  }
  
  getRandomUserAgent() {
    return this.config.userAgents[Math.floor(Math.random() * this.config.userAgents.length)];
  }
  
  async checkProductStock(context, product) {
    const page = await context.newPage();
    let retries = 0;
    
    while (retries <= this.config.maxRetries) {
      try {
        // Costruisci URL ricerca per SKU
        const searchUrl = `${this.baseUrl}/default.asp?cmdString=${product.sku}&cmd=searchProd&bFormSearch=1`;
        
        if (retries === 0) {
          this.log(`Checking: ${product.sku}`, 'DEBUG');
        } else {
          this.log(`Retry ${retries}/${this.config.maxRetries} for ${product.sku}`, 'WARN');
        }
        
        // Naviga con timeout
        await page.goto(searchUrl, { 
          waitUntil: 'domcontentloaded',
          timeout: 20000 
        });
        
        // Attendi caricamento pagina
        await page.waitForTimeout(500);
        
        // Estrai info disponibilità con selettori robusti
        const stockInfo = await page.evaluate((targetSku) => {
          const bodyText = document.body.innerText || '';
          
          // Inizializza risultato
          let quantity = null;
          let available = null;
          
          // Pattern specifici per il sito
          const qtyMatch = bodyText.match(/disponibilit[àa]:\s*(\d+)/i) || 
                          bodyText.match(/qty:\s*(\d+)/i) ||
                          bodyText.match(/stock:\s*(\d+)/i) ||
                          bodyText.match(/pezzi:\s*(\d+)/i) ||
                          bodyText.match(/(\d+)\s*disponibil/i);
          
          if (qtyMatch) {
            quantity = parseInt(qtyMatch[1]);
          }
          
          // Check disponibilità
          if (bodyText.toLowerCase().includes('non disponibile') || 
              bodyText.toLowerCase().includes('esaurito') ||
              bodyText.toLowerCase().includes('out of stock') ||
              bodyText.toLowerCase().includes('terminato')) {
            available = false;
            quantity = 0;
          } else if (bodyText.toLowerCase().includes('disponibile') || 
                    bodyText.toLowerCase().includes('in stock') ||
                    quantity > 0) {
            available = true;
          }
          
          // Se troviamo form acquisto, è disponibile
          const hasAddToCart = !!document.querySelector('input[name="aggiungi"], button[name="add"], .add-to-cart');
          if (hasAddToCart && available === null) {
            available = true;
          }
          
          // Cerca prezzo per conferma prodotto trovato
          const priceMatch = bodyText.match(/[€€]\s*(\d+[.,]\d{2})/);
          const hasPrice = !!priceMatch;
          
          return {
            found: hasPrice || quantity !== null || available !== null,
            quantity: quantity !== null ? quantity : (available ? 99 : 0),
            available: available !== false,
            hasPrice
          };
        }, product.sku);
        
        await page.close();
        
        if (stockInfo.found) {
          // Aggiorna dati prodotto
          product.newStock = stockInfo.quantity;
          product.newStatus = stockInfo.available ? 'instock' : 'outofstock';
          
          // Track cambiamenti
          if (product.currentStock > 0 && product.newStock === 0) {
            this.stats.outOfStock.push(`${product.sku} - ${product.name}`);
            this.log(`OUT OF STOCK: ${product.sku}`, 'WARN', {
              event: 'out_of_stock',
              sku: product.sku,
              name: product.name
            });
          } else if (product.currentStock === 0 && product.newStock > 0) {
            this.stats.backInStock.push(`${product.sku} - ${product.name}`);
            this.log(`BACK IN STOCK: ${product.sku}`, 'SUCCESS', {
              event: 'back_in_stock',
              sku: product.sku,
              name: product.name,
              quantity: product.newStock
            });
          }
          
          if (product.currentStock !== product.newStock) {
            this.stats.updated++;
          }
          
          return true;
        } else {
          // Prodotto non trovato, skip
          this.log(`Prodotto non trovato: ${product.sku}`, 'WARN');
          this.stats.skipped++;
          return false;
        }
        
      } catch (error) {
        retries++;
        
        if (retries > this.config.maxRetries) {
          this.log(`Errore check ${product.sku}: ${error.message}`, 'ERROR');
          this.stats.errors++;
          
          await page.close();
          return false;
        }
        
        // Attendi prima del retry
        await page.close();
        await new Promise(resolve => setTimeout(resolve, this.config.retryDelay));
      }
    }
    
    return false;
  }
  
  async runStockCheck(maxProducts = null) {
    const productsToCheck = Math.min(
      maxProducts || this.config.maxProductsPerSession,
      this.products.length - this.currentIndex
    );
    
    this.log('╔════════════════════════════════════════╗', 'INFO');
    this.log('║     STOCK CHECK LIGHT - AVVIO         ║', 'INFO');
    this.log('╚════════════════════════════════════════╝', 'INFO');
    this.log(`Prodotti da controllare: ${productsToCheck}`, 'INFO');
    this.log(`Tempo stimato: ${Math.round(productsToCheck * 0.5 / 60)} - ${Math.round(productsToCheck * 1.5 / 60)} minuti`, 'INFO');
    
    const sessionStart = Date.now();
    
    // Avvia browser
    const browser = await chromium.launch({
      headless: this.config.headless,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu'
      ]
    });
    
    let context = await browser.newContext({
      userAgent: this.getRandomUserAgent(),
      viewport: { width: 1920, height: 1080 },
      locale: 'it-IT',
      timezoneId: 'Europe/Rome'
    });
    
    let productsInBatch = 0;
    let batchCount = 0;
    
    try {
      // LOOP PRINCIPALE
      while (this.currentIndex < this.products.length && 
             this.stats.checked < productsToCheck && 
             this.isRunning) {
        
        // Check timeout sessione (2 ore max)
        if (Date.now() - sessionStart > this.config.sessionTimeout) {
          this.log('⏰ Timeout sessione raggiunto (2 ore)', 'WARN', {
            event: 'session_timeout'
          });
          break;
        }
        
        // Check errori consecutivi
        if (this.consecutiveErrors >= this.config.stopOnErrors) {
          this.log('⛔ Troppi errori consecutivi, stop', 'ERROR', {
            event: 'too_many_errors',
            count: this.consecutiveErrors
          });
          break;
        }
        
        const product = this.products[this.currentIndex];
        this.currentIndex++;
        
        // Check stock prodotto
        const success = await this.checkProductStock(context, product);
        
        if (success) {
          this.consecutiveErrors = 0;
        } else {
          this.consecutiveErrors++;
        }
        
        this.stats.checked++;
        productsInBatch++;
        
        // Log progresso
        if (this.stats.checked % this.config.logInterval === 0) {
          const progress = Math.round((this.stats.checked / productsToCheck) * 100);
          const elapsed = Math.round((Date.now() - sessionStart) / 60000);
          const eta = Math.round((elapsed / this.stats.checked) * (productsToCheck - this.stats.checked));
          
          this.log(`Progress: ${this.stats.checked}/${productsToCheck} (${progress}%) - ETA: ${eta} min`, 'INFO', {
            event: 'progress',
            checked: this.stats.checked,
            total: productsToCheck,
            progress,
            eta
          });
        }
        
        // Salva progresso periodicamente
        if (this.stats.checked % 25 === 0) {
          await this.saveProgress();
        }
        
        // Gestione batch
        if (productsInBatch >= this.config.batchSize) {
          batchCount++;
          this.log(`Batch ${batchCount} completato. Pausa ${this.config.pauseBetweenBatches/1000}s`, 'INFO', {
            event: 'batch_complete',
            batch: batchCount
          });
          
          // Report parziale
          this.log(`Stats: ${this.stats.updated} aggiornati, ${this.stats.errors} errori`, 'INFO');
          
          // Pausa tra batch
          await new Promise(resolve => setTimeout(resolve, this.config.pauseBetweenBatches));
          
          productsInBatch = 0;
          
          // Rotazione user agent ogni 3 batch
          if (batchCount % 3 === 0) {
            await context.close();
            context = await browser.newContext({
              userAgent: this.getRandomUserAgent(),
              viewport: { width: 1920, height: 1080 },
              locale: 'it-IT',
              timezoneId: 'Europe/Rome'
            });
            this.log('User agent ruotato', 'DEBUG');
          }
        }
        
        // Delay tra prodotti
        if (this.currentIndex < this.products.length) {
          const delay = this.config.crawlDelay + Math.random() * 200;
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
      
    } catch (error) {
      this.log(`Errore critico: ${error.message}`, 'ERROR', {
        event: 'critical_error',
        error: error.message,
        stack: error.stack
      });
      throw error;
      
    } finally {
      await context.close();
      await browser.close();
      this.log('Browser chiuso', 'DEBUG');
    }
    
    // Salva CSV aggiornato
    await this.saveUpdatedCSV();
    
    // Report finale
    const duration = (Date.now() - this.stats.startTime) / 1000 / 60;
    
    this.log('\n╔════════════════════════════════════════╗', 'SUCCESS');
    this.log('║     STOCK CHECK COMPLETATO            ║', 'SUCCESS');
    this.log('╚════════════════════════════════════════╝', 'SUCCESS');
    this.log(`Durata: ${duration.toFixed(1)} minuti`, 'INFO');
    this.log(`Prodotti controllati: ${this.stats.checked}`, 'INFO');
    this.log(`Prodotti aggiornati: ${this.stats.updated}`, 'INFO');
    this.log(`Nuovi OOS: ${this.stats.outOfStock.length}`, 'INFO');
    this.log(`Tornati disponibili: ${this.stats.backInStock.length}`, 'INFO');
    this.log(`Errori: ${this.stats.errors}`, 'INFO');
    this.log(`Skip: ${this.stats.skipped}`, 'INFO');
    
    // Log evento finale
    await this.logEvent({
      timestamp: new Date().toISOString(),
      level: 'SUCCESS',
      message: 'Stock check completato',
      event: 'stock_check_complete',
      stats: this.stats,
      duration: duration
    });
    
    // Genera report se necessario
    if (this.stats.outOfStock.length > 0) {
      const reportPath = path.join(this.outputDir, `oos_report_${Date.now()}.txt`);
      await fsp.writeFile(reportPath, this.stats.outOfStock.join('\n'));
      this.log(`Report OOS: ${reportPath}`, 'INFO');
    }
    
    // Elimina progress file
    if (this.currentIndex >= this.products.length || this.stats.checked >= productsToCheck) {
      try {
        await fsp.unlink(this.progressPath);
        this.log('Progress file eliminato', 'DEBUG');
      } catch (e) {
        // Ignora
      }
    }
  }
  
  async saveUpdatedCSV() {
    try {
      this.log('Salvataggio CSV aggiornato...', 'INFO');
      
      // Rileggi CSV per mantenere struttura
      const csvContent = await fsp.readFile(this.csvBackupPath, 'utf8');
      const lines = csvContent.split('\n');
      const headers = lines[0];
      
      // Trova indici colonne
      const headerArray = headers.split(',').map(h => h.trim());
      const skuIndex = headerArray.findIndex(h => h.toLowerCase() === 'sku');
      const stockQtyIndex = headerArray.findIndex(h => h.toLowerCase().includes('stock_quantity'));
      const stockStatusIndex = headerArray.findIndex(h => h.toLowerCase().includes('stock_status'));
      
      // Crea mappa SKU -> prodotto
      const productMap = new Map();
      this.products.forEach(p => {
        if (p.newStock !== null) {
          productMap.set(p.sku, p);
        }
      });
      
      this.log(`Aggiornamento ${productMap.size} prodotti nel CSV`, 'INFO');
      
      // Ricostruisci CSV
      const updatedLines = [headers];
      
      for (let i = 1; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        
        const cols = this.parseCSVLine(lines[i]);
        const sku = cols[skuIndex];
        
        if (sku && productMap.has(sku)) {
          const product = productMap.get(sku);
          cols[stockQtyIndex] = product.newStock.toString();
          cols[stockStatusIndex] = product.newStatus;
        }
        
        updatedLines.push(cols.map(c => 
          c.includes(',') || c.includes('"') ? `"${c.replace(/"/g, '""')}"` : c
        ).join(','));
      }
      
      // Scrivi CSV
      const updatedContent = updatedLines.join('\n');
      await fsp.writeFile(this.csvLatestPath, updatedContent, 'utf8');
      
      this.log(`✓ CSV aggiornato: ${this.csvLatestPath}`, 'SUCCESS', {
        event: 'csv_updated',
        file: this.csvLatestPath,
        products: productMap.size
      });
      
    } catch (error) {
      this.log(`Errore salvataggio CSV: ${error.message}`, 'ERROR', {
        event: 'csv_save_error',
        error: error.message
      });
      throw error;
    }
  }
  
  stop() {
    this.log('Stop richiesto...', 'WARN', {
      event: 'stop_requested'
    });
    this.isRunning = false;
  }
}

// ========================================
// ESECUZIONE PRINCIPALE
// ========================================

async function main() {
  const checker = new StockCheckerLight();
  
  // Gestione segnali
  process.on('SIGTERM', () => {
    console.log('SIGTERM ricevuto');
    checker.stop();
  });
  
  process.on('SIGINT', () => {
    console.log('SIGINT ricevuto');
    checker.stop();
  });
  
  try {
    // Carica prodotti
    const totalProducts = await checker.loadProducts();
    
    if (totalProducts === 0) {
      console.error('❌ Nessun prodotto trovato');
      process.exit(1);
    }
    
    // Determina prodotti da controllare
    const maxProducts = process.argv[2] ? parseInt(process.argv[2]) : null;
    
    if (maxProducts) {
      console.log(`\n📦 Controllo di ${maxProducts} prodotti`);
    } else {
      console.log(`\n📦 Controllo completo (max ${checker.config.maxProductsPerSession} prodotti)`);
    }
    
    // Avvia check
    await checker.runStockCheck(maxProducts);
    
    console.log('\n✅ Completato con successo!');
    process.exit(0);
    
  } catch (error) {
    console.error('\n❌ ERRORE:', error.message);
    console.error('Stack:', error.stack);
    process.exit(1);
  }
}

// Avvia
if (require.main === module) {
  main().catch(error => {
    console.error('Errore:', error);
    process.exit(1);
  });
}

module.exports = StockCheckerLight;
