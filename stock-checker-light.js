// stock-checker-light.js - VERSIONE CORRETTA E OTTIMIZZATA
// Sistema ultra-veloce per controllo stock/disponibilità
// Target: 200ms per prodotto = 5000 prodotti in ~20 minuti

const { chromium } = require('playwright');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

class StockCheckerLight {
  constructor() {
    // Percorsi file
    const baseDir = process.env.DATA_DIR || (process.env.RENDER ? '/data' : '.');
    this.outputDir = path.join(baseDir, 'output');
    this.csvLatestPath = path.join(this.outputDir, 'prodotti_latest.csv');
    this.csvBackupPath = path.join(this.outputDir, `backup_${Date.now()}.csv`);
    this.logPath = path.join(this.outputDir, `stock_checker_${new Date().toISOString().split('T')[0]}.log`);
    this.progressPath = path.join(this.outputDir, 'stock_checker_progress.json');
    
    // URL base
    this.baseUrl = 'https://www.componentidigitali.com';
    
    // 🚀 CONFIGURAZIONE ULTRA-VELOCE CORRETTA
    this.config = {
      crawlDelay: 200,              // ✅ 200ms tra richieste (rispetta robots.txt)
      batchSize: 50,                // ✅ Batch più piccoli per controllo migliore
      pauseBetweenBatches: 2000,    // ✅ Solo 2 secondi tra batch
      maxProductsPerSession: 5000,  // Max prodotti per sessione
      sessionTimeout: 1800000,      // 30 minuti max per sessione
      pageLoadTimeout: 15000,       // ✅ Timeout più veloce per pagine
      
      // User agents rotation
      userAgents: [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0',
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0'
      ],
      
      // Retry configuration
      maxRetries: 1,            // ✅ Solo 1 retry per velocità
      retryDelay: 5000,         // ✅ 5 secondi prima di riprovare
      
      // Safety features
      stopOnErrors: 10,         // Ferma dopo 10 errori consecutivi
      randomizeOrder: true,     // Randomizza ordine prodotti
    };
    
    // Stato
    this.products = [];
    this.currentIndex = 0;
    this.errors = [];
    this.consecutiveErrors = 0;
    this.isRunning = true;
    this.stats = {
      checked: 0,
      updated: 0,
      outOfStock: [],
      backInStock: [],
      errors: 0,
      startTime: Date.now()
    };
  }
  
  log(message, level = 'INFO') {
    const prefix = '[STOCK-CHECK]:';
    const line = `${prefix} [${new Date().toISOString()}] [${level}] ${message}`;
    console.log(line);
    try {
      fs.appendFileSync(this.logPath, line + '\n');
    } catch (e) {
      console.error('Log error:', e.message);
    }
  }
  
  async ensureDirectories() {
    await fsp.mkdir(this.outputDir, { recursive: true });
  }
  
  async loadProducts() {
    try {
      await this.ensureDirectories();
      
      if (!fs.existsSync(this.csvLatestPath)) {
        throw new Error('CSV non trovato. Esegui prima uno scraping completo.');
      }
      
      // Backup del CSV originale
      await fsp.copyFile(this.csvLatestPath, this.csvBackupPath);
      this.log(`Backup creato: ${this.csvBackupPath}`);
      
      // Leggi e parsa CSV
      const csvContent = await fsp.readFile(this.csvLatestPath, 'utf8');
      const lines = csvContent.split('\n').filter(l => l.trim());
      const headers = lines[0].split(',').map(h => h.trim());
      
      // Trova indici colonne
      const skuIndex = headers.findIndex(h => h.toLowerCase() === 'sku');
      const nameIndex = headers.findIndex(h => h.toLowerCase() === 'name');
      const stockQtyIndex = headers.findIndex(h => h.toLowerCase().includes('stock_quantity'));
      const stockStatusIndex = headers.findIndex(h => h.toLowerCase().includes('stock_status'));
      
      this.products = [];
      
      // Parsa prodotti
      for (let i = 1; i < lines.length && i < 5001; i++) { // Max 5000 prodotti
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
      
      this.log(`Caricati ${this.products.length} prodotti dal CSV`);
      
      // Randomizza ordine se configurato
      if (this.config.randomizeOrder) {
        this.shuffleArray(this.products);
        this.log('Ordine prodotti randomizzato');
      }
      
      // Carica progresso se esiste
      await this.loadProgress();
      
      return this.products.length;
      
    } catch (error) {
      this.log(`Errore caricamento prodotti: ${error.message}`, 'ERROR');
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
      timestamp: Date.now()
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
        
        // Resume solo se < 2 ore
        const hoursOld = (Date.now() - progress.timestamp) / (1000 * 60 * 60);
        if (hoursOld < 2) {
          this.currentIndex = progress.currentIndex;
          this.stats = progress.stats;
          this.log(`Resume da prodotto ${this.currentIndex}`);
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
  
  async checkProductStock(page, product) {
    try {
      // Costruisci URL ricerca per SKU
      const searchUrl = `${this.baseUrl}/default.asp?cmdString=${product.sku}&cmd=searchProd&bFormSearch=1`;
      
      this.log(`Checking: ${product.sku}`);
      
      // 🚀 NAVIGAZIONE VELOCE - NO WAIT INUTILI!
      await page.goto(searchUrl, { 
        waitUntil: 'domcontentloaded',  // ✅ Solo DOM, non aspetta tutto
        timeout: this.config.pageLoadTimeout 
      });
      
      // ⚡ NESSUN WAIT FISSO! Solo se serve veramente
      // await page.waitForTimeout(2000); // ❌ RIMOSSO!
      
      // 🚀 Estrai info disponibilità IMMEDIATAMENTE
      const stockInfo = await page.evaluate((targetSku) => {
        const bodyText = document.body.innerText || '';
        
        // Cerca indicatori di disponibilità
        let quantity = null;
        let available = null;
        
        // Pattern veloci e diretti
        const patterns = [
          /disponibilit[àa]\s*:\s*(\d+)/i,
          /giacenza\s*:\s*(\d+)/i,
          /stock\s*:\s*(\d+)/i,
          /quantit[àa]\s*:\s*(\d+)/i,
          /pezzi\s+disponibili\s*:\s*(\d+)/i,
          /\b(\d+)\s+disponibil[ei]/i,
          /\b(\d+)\s+pezz[oi]/i,
          /\b(\d+)\s+in\s+stock/i
        ];
        
        for (const pattern of patterns) {
          const match = bodyText.match(pattern);
          if (match && match[1]) {
            quantity = parseInt(match[1]);
            break;
          }
        }
        
        // Check disponibilità generale
        if (quantity === null) {
          if (/non disponibile|esaurito|terminato|sold out|out of stock/i.test(bodyText)) {
            quantity = 0;
            available = false;
          } else if (/disponibile|in stock|acquista|aggiungi/i.test(bodyText)) {
            quantity = 1; // Disponibile ma quantità non specificata
            available = true;
          }
        } else {
          available = quantity > 0;
        }
        
        // Verifica che siamo sulla pagina giusta
        const isCorrectProduct = bodyText.toLowerCase().includes(targetSku.toLowerCase());
        
        return {
          quantity: quantity !== null ? quantity : 0,
          available: available !== null ? available : false,
          foundProduct: isCorrectProduct
        };
      }, product.sku);
      
      // Aggiorna prodotto solo se trovato
      if (stockInfo.foundProduct) {
        product.newStock = stockInfo.quantity;
        product.newStatus = stockInfo.available ? 'instock' : 'outofstock';
        
        // Log cambimenti importanti
        if (product.currentStock > 0 && product.newStock === 0) {
          this.stats.outOfStock.push(product.sku);
          this.log(`❌ OUT OF STOCK: ${product.sku} (era ${product.currentStock})`, 'WARN');
        } else if (product.currentStock === 0 && product.newStock > 0) {
          this.stats.backInStock.push(product.sku);
          this.log(`✓ BACK IN STOCK: ${product.sku} (ora ${product.newStock})`);
        } else if (product.currentStock !== product.newStock) {
          this.log(`📊 Stock update: ${product.sku} da ${product.currentStock} a ${product.newStock}`);
        }
        
        if (product.currentStock !== product.newStock) {
          this.stats.updated++;
        }
        
        this.consecutiveErrors = 0; // Reset errori consecutivi
        return true;
      } else {
        this.log(`⚠️ Prodotto ${product.sku} non trovato nella pagina`, 'WARN');
        return false;
      }
      
    } catch (error) {
      this.log(`Errore check ${product.sku}: ${error.message}`, 'ERROR');
      this.stats.errors++;
      this.consecutiveErrors++;
      
      if (this.consecutiveErrors >= this.config.stopOnErrors) {
        throw new Error(`Troppi errori consecutivi (${this.consecutiveErrors}), stop.`);
      }
      
      return false;
      
    } finally {
      // Chiudi sempre la pagina per liberare memoria
      await page.close();
    }
  }
  
  async runStockCheck(maxProducts = null) {
    const productsToCheck = Math.min(
      maxProducts || this.config.maxProductsPerSession,
      this.products.length - this.currentIndex
    );
    
    this.log('╔════════════════════════════════════════╗');
    this.log('║   STOCK CHECKER LIGHT - AVVIO         ║');
    this.log('╚════════════════════════════════════════╝');
    this.log(`Modalità: Ultra-veloce (${this.config.crawlDelay}ms/prodotto)`);
    this.log(`Prodotti da controllare: ${productsToCheck}`);
    this.log(`Tempo stimato: ${Math.ceil((productsToCheck * (this.config.crawlDelay + 500)) / 60000)} minuti`);
    
    const browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-web-security',
        '--disable-features=IsolateOrigins',
        '--disable-site-isolation-trials',
        '--disable-blink-features=AutomationControlled'
      ]
    });
    
    let context = await browser.newContext({
      userAgent: this.getRandomUserAgent(),
      viewport: { width: 1920, height: 1080 },
      bypassCSP: true,
      ignoreHTTPSErrors: true
    });
    
    // 🚀 PRE-CARICA UNA PAGINA VUOTA PER WARMUP
    const warmupPage = await context.newPage();
    await warmupPage.goto('about:blank');
    await warmupPage.close();
    
    const sessionStart = Date.now();
    let productsInBatch = 0;
    let batchCount = 0;
    
    try {
      // 🔥 LOOP PRINCIPALE OTTIMIZZATO
      while (this.currentIndex < this.products.length && 
             this.stats.checked < productsToCheck && 
             this.isRunning) {
        
        const product = this.products[this.currentIndex];
        this.currentIndex++;
        
        // 🚀 CREA PAGINA VELOCE
        const page = await context.newPage();
        
        // Check prodotto
        const success = await this.checkProductStock(page, product);
        
        if (success) {
          this.stats.checked++;
          productsInBatch++;
          
          // Log progresso ogni 10 prodotti
          if (this.stats.checked % 10 === 0) {
            const elapsed = (Date.now() - sessionStart) / 1000;
            const rate = this.stats.checked / elapsed;
            this.log(`Progress: ${this.stats.checked}/${productsToCheck} (${rate.toFixed(1)} prod/sec)`);
          }
          
          // Salva progresso ogni 25 prodotti
          if (this.stats.checked % 25 === 0) {
            await this.saveProgress();
          }
        }
        
        // Gestione batch
        if (productsInBatch >= this.config.batchSize) {
          batchCount++;
          this.log(`Batch ${batchCount} completato. Mini-pausa ${this.config.pauseBetweenBatches}ms...`);
          
          // ⚡ PAUSA BREVISSIMA TRA BATCH
          await new Promise(resolve => setTimeout(resolve, this.config.pauseBetweenBatches));
          
          productsInBatch = 0;
          
          // Rotazione context ogni 5 batch
          if (batchCount % 5 === 0) {
            await context.close();
            context = await browser.newContext({
              userAgent: this.getRandomUserAgent(),
              viewport: { width: 1920, height: 1080 },
              bypassCSP: true,
              ignoreHTTPSErrors: true
            });
            this.log('Context rotated');
          }
        }
        
        // ⚡ DELAY MINIMO TRA PRODOTTI (rispetta robots.txt)
        if (this.currentIndex < this.products.length && this.stats.checked < productsToCheck) {
          await new Promise(resolve => setTimeout(resolve, this.config.crawlDelay));
        }
        
        // Check timeout sessione
        if (Date.now() - sessionStart > this.config.sessionTimeout) {
          this.log('⏰ Timeout sessione raggiunto. Salvataggio...');
          break;
        }
      }
      
      this.log('Loop principale completato');
      
    } catch (error) {
      this.log(`Errore nel loop principale: ${error.message}`, 'ERROR');
      throw error;
      
    } finally {
      if (context) await context.close();
      await browser.close();
      this.log('Browser chiuso');
    }
    
    // Salva CSV aggiornato
    await this.saveUpdatedCSV();
    
    // Report finale
    const duration = (Date.now() - this.stats.startTime) / 1000 / 60;
    const productsPerMinute = Math.round(this.stats.checked / duration);
    
    this.log('\n╔════════════════════════════════════════╗');
    this.log('║     STOCK CHECK COMPLETATO            ║');
    this.log('╚════════════════════════════════════════╝');
    this.log(`✅ Durata: ${duration.toFixed(1)} minuti`);
    this.log(`✅ Prodotti controllati: ${this.stats.checked}`);
    this.log(`✅ Velocità: ${productsPerMinute} prodotti/minuto`);
    this.log(`📊 Prodotti aggiornati: ${this.stats.updated}`);
    this.log(`❌ Out of stock: ${this.stats.outOfStock.length}`);
    this.log(`✓ Back in stock: ${this.stats.backInStock.length}`);
    this.log(`⚠️ Errori: ${this.stats.errors}`);
    
    // Genera report se necessario
    if (this.stats.outOfStock.length > 0) {
      const reportPath = path.join(this.outputDir, `out_of_stock_${Date.now()}.txt`);
      await fsp.writeFile(reportPath, this.stats.outOfStock.join('\n'));
      this.log(`📋 Report OOS: ${reportPath}`);
    }
    
    // Cleanup progress file
    if (this.currentIndex >= this.products.length || this.stats.checked >= productsToCheck) {
      try {
        await fsp.unlink(this.progressPath);
        this.log('✓ Progress file eliminato');
      } catch (e) {
        // Ignora
      }
    }
  }
  
  async saveUpdatedCSV() {
    try {
      this.log('Salvataggio CSV aggiornato...');
      
      // Rileggi CSV originale
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
      
      this.log(`Aggiornamento di ${productMap.size} prodotti nel CSV...`);
      
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
      
      // Scrivi CSV aggiornato
      const updatedContent = updatedLines.join('\n');
      await fsp.writeFile(this.csvLatestPath, updatedContent, 'utf8');
      
      this.log(`✓ CSV aggiornato: ${this.csvLatestPath}`);
      
    } catch (error) {
      this.log(`Errore salvataggio CSV: ${error.message}`, 'ERROR');
      throw error;
    }
  }
  
  stop() {
    this.log('Stop richiesto...');
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
      console.error('❌ Nessun prodotto trovato nel CSV');
      process.exit(1);
    }
    
    // Determina quanti prodotti controllare
    const maxProducts = process.argv[2] ? parseInt(process.argv[2]) : 5000;
    
    console.log('\n🚀 STOCK CHECKER ULTRA-VELOCE');
    console.log(`📦 Prodotti da controllare: ${Math.min(maxProducts, totalProducts)}`);
    console.log(`⏱️ Tempo stimato: ${Math.ceil((Math.min(maxProducts, totalProducts) * 250) / 60000)} minuti`);
    
    // Avvia check
    await checker.runStockCheck(maxProducts);
    
    console.log('\n✅ Stock check completato!');
    process.exit(0);
    
  } catch (error) {
    console.error('\n❌ ERRORE:', error.message);
    process.exit(1);
  }
}

// Avvia se chiamato direttamente
if (require.main === module) {
  main().catch(error => {
    console.error('Errore:', error);
    process.exit(1);
  });
}

module.exports = StockCheckerLight;
