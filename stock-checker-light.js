// stock-checker-balanced.js
// VERSIONE BILANCIATA: 5000 prodotti in 40 minuti con protezione anti-ban
// Strategia: velocità adattiva che rallenta solo se rileva problemi

const { chromium } = require('playwright');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

class StockCheckerBalanced {
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
    
    // ⚡ CONFIGURAZIONE BILANCIATA PER 40 MINUTI
    this.config = {
      // TIMING ADATTIVO
      crawlDelayMin: 400,           // ✅ Minimo 400ms quando tutto ok
      crawlDelayMax: 3000,          // ✅ Max 3 secondi se problemi
      crawlDelayCurrent: 500,       // ✅ Inizio con 500ms (sicuro)
      
      // BATCH INTELLIGENTE
      batchSize: 50,                // 50 prodotti per batch
      pauseBetweenBatches: 5000,    // 5 secondi tra batch (recupero)
      pauseAfterError: 10000,       // 10 secondi dopo errore
      pauseAfterBlock: 30000,       // 30 secondi se sospetto blocco
      
      // LIMITI
      maxProductsPerSession: 5000,
      targetTimeMinutes: 40,        // Target 40 minuti
      
      // PARALLELISMO CONTROLLATO
      maxConcurrentPages: 2,        // Max 2 pagine in parallelo
      useParallel: false,           // Inizia sequenziale, attiva se veloce
      
      // ADATTAMENTO DINAMICO
      adaptiveSpeed: true,          // ✅ Velocità adattiva
      errorThreshold: 5,            // Errori prima di rallentare
      successThreshold: 20,         // Successi prima di accelerare
      
      // USER AGENTS (solo i più comuni)
      userAgents: [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0'
      ],
      
      // RETRY STRATEGY
      maxRetries: 1,
      retryDelay: 5000,
      
      // SAFETY
      stopOnErrors: 10,
      randomizeOrder: false,        // No random per velocità
      skipSlowProducts: true,       // Salta prodotti che rallentano
      
      // MONITORING
      checkRateEvery: 50,           // Controlla velocità ogni 50 prodotti
      targetRate: 2.08,             // Target 2.08 prodotti/secondo
    };
    
    // Stato
    this.products = [];
    this.currentIndex = 0;
    this.consecutiveErrors = 0;
    this.consecutiveSuccesses = 0;
    this.isRunning = true;
    this.lastRateCheck = Date.now();
    this.productsAtLastCheck = 0;
    
    this.stats = {
      checked: 0,
      updated: 0,
      outOfStock: [],
      backInStock: [],
      errors: 0,
      skipped: 0,
      blocked: 0,
      startTime: Date.now(),
      avgResponseTime: 500,
      currentRate: 0
    };
  }
  
  log(message, level = 'INFO') {
    const prefix = '[BALANCED]:';
    const line = `${prefix} [${new Date().toISOString()}] [${level}] ${message}`;
    console.log(line);
    try {
      fs.appendFileSync(this.logPath, line + '\n');
    } catch (e) {}
  }
  
  async ensureDirectories() {
    await fsp.mkdir(this.outputDir, { recursive: true });
  }
  
  async loadProducts() {
    try {
      await this.ensureDirectories();
      
      if (!fs.existsSync(this.csvLatestPath)) {
        throw new Error('CSV non trovato');
      }
      
      // Backup
      await fsp.copyFile(this.csvLatestPath, this.csvBackupPath);
      this.log(`Backup creato`);
      
      // Leggi CSV
      const csvContent = await fsp.readFile(this.csvLatestPath, 'utf8');
      const lines = csvContent.split('\n').filter(l => l.trim());
      const headers = lines[0].split(',').map(h => h.trim());
      
      const skuIndex = headers.findIndex(h => h.toLowerCase() === 'sku');
      const stockQtyIndex = headers.findIndex(h => h.toLowerCase().includes('stock_quantity'));
      const stockStatusIndex = headers.findIndex(h => h.toLowerCase().includes('stock_status'));
      
      this.products = [];
      
      // Carica prodotti con priorità (stock basso prima)
      const priorityProducts = [];
      const normalProducts = [];
      
      for (let i = 1; i < lines.length && this.products.length < 5000; i++) {
        const cols = this.parseCSVLine(lines[i]);
        if (cols[skuIndex]) {
          const product = {
            sku: cols[skuIndex],
            currentStock: parseInt(cols[stockQtyIndex]) || 0,
            currentStatus: cols[stockStatusIndex] || 'instock',
            newStock: null,
            newStatus: null,
            rowIndex: i,
            fullRow: cols
          };
          
          // Priorità a prodotti con stock basso
          if (product.currentStock <= 10) {
            priorityProducts.push(product);
          } else {
            normalProducts.push(product);
          }
        }
      }
      
      // Combina: prima priorità, poi normali
      this.products = [...priorityProducts, ...normalProducts];
      
      this.log(`Caricati ${this.products.length} prodotti (${priorityProducts.length} prioritari)`);
      
      // Carica progresso
      await this.loadProgress();
      
      return this.products.length;
      
    } catch (error) {
      this.log(`Errore caricamento: ${error.message}`, 'ERROR');
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
  
  async saveProgress() {
    const progress = {
      currentIndex: this.currentIndex,
      stats: this.stats,
      config: {
        crawlDelayCurrent: this.config.crawlDelayCurrent,
        useParallel: this.config.useParallel
      },
      timestamp: Date.now()
    };
    
    try {
      await fsp.writeFile(this.progressPath, JSON.stringify(progress, null, 2));
    } catch (e) {}
  }
  
  async loadProgress() {
    try {
      if (fs.existsSync(this.progressPath)) {
        const data = await fsp.readFile(this.progressPath, 'utf8');
        const progress = JSON.parse(data);
        
        // Resume solo se recente
        const hoursOld = (Date.now() - progress.timestamp) / (1000 * 60 * 60);
        if (hoursOld < 2) {
          this.currentIndex = progress.currentIndex;
          this.stats = progress.stats;
          this.config.crawlDelayCurrent = progress.config.crawlDelayCurrent || 500;
          this.config.useParallel = progress.config.useParallel || false;
          this.log(`Resume da prodotto ${this.currentIndex} con delay ${this.config.crawlDelayCurrent}ms`);
          return true;
        }
      }
    } catch (e) {}
    return false;
  }
  
  getRandomUserAgent() {
    return this.config.userAgents[Math.floor(Math.random() * this.config.userAgents.length)];
  }
  
  // 🎯 VELOCITÀ ADATTIVA
  adjustSpeed(success, responseTime = null) {
    if (!this.config.adaptiveSpeed) return;
    
    if (success) {
      this.consecutiveSuccesses++;
      this.consecutiveErrors = 0;
      
      // Se abbastanza successi, accelera
      if (this.consecutiveSuccesses >= this.config.successThreshold) {
        const newDelay = Math.max(
          this.config.crawlDelayMin,
          this.config.crawlDelayCurrent - 50
        );
        
        if (newDelay < this.config.crawlDelayCurrent) {
          this.log(`⚡ Accelerazione: ${this.config.crawlDelayCurrent}ms → ${newDelay}ms`);
          this.config.crawlDelayCurrent = newDelay;
        }
        
        this.consecutiveSuccesses = 0;
        
        // Attiva parallelismo se molto veloce
        if (newDelay <= 600 && !this.config.useParallel) {
          this.config.useParallel = true;
          this.log(`🚀 Parallelismo ATTIVATO`);
        }
      }
      
    } else {
      this.consecutiveErrors++;
      this.consecutiveSuccesses = 0;
      
      // Se troppi errori, rallenta
      if (this.consecutiveErrors >= this.config.errorThreshold) {
        const newDelay = Math.min(
          this.config.crawlDelayMax,
          this.config.crawlDelayCurrent + 200
        );
        
        if (newDelay > this.config.crawlDelayCurrent) {
          this.log(`⚠️ Rallentamento: ${this.config.crawlDelayCurrent}ms → ${newDelay}ms`);
          this.config.crawlDelayCurrent = newDelay;
        }
        
        // Disattiva parallelismo se problemi
        if (this.config.useParallel) {
          this.config.useParallel = false;
          this.log(`⚠️ Parallelismo DISATTIVATO`);
        }
        
        this.consecutiveErrors = 0;
      }
    }
    
    // Aggiorna tempo medio risposta
    if (responseTime) {
      this.stats.avgResponseTime = Math.round(
        (this.stats.avgResponseTime * 0.9) + (responseTime * 0.1)
      );
    }
  }
  
  // 📊 CONTROLLO RATE
  checkRate() {
    const now = Date.now();
    const elapsed = (now - this.lastRateCheck) / 1000;
    const productsDone = this.stats.checked - this.productsAtLastCheck;
    
    if (productsDone >= this.config.checkRateEvery) {
      const currentRate = productsDone / elapsed;
      this.stats.currentRate = currentRate;
      
      this.log(`📊 Rate: ${currentRate.toFixed(2)} prod/sec (target: ${this.config.targetRate})`);
      
      // Aggiusta velocità in base al rate
      if (currentRate < this.config.targetRate * 0.8) {
        // Troppo lento, accelera
        this.config.crawlDelayCurrent = Math.max(
          this.config.crawlDelayMin,
          this.config.crawlDelayCurrent - 100
        );
        this.log(`⚡ Boost velocità per raggiungere target`);
        
      } else if (currentRate > this.config.targetRate * 1.5) {
        // Troppo veloce, rallenta
        this.config.crawlDelayCurrent = Math.min(
          this.config.crawlDelayMax,
          this.config.crawlDelayCurrent + 100
        );
        this.log(`⚠️ Riduco velocità per sicurezza`);
      }
      
      // Calcola ETA
      const remaining = this.products.length - this.currentIndex;
      const eta = remaining / currentRate / 60;
      this.log(`⏱️ ETA: ${eta.toFixed(1)} minuti per ${remaining} prodotti rimanenti`);
      
      // Se siamo in ritardo, attiva misure aggressive
      if (eta > 45 && this.config.crawlDelayCurrent > this.config.crawlDelayMin) {
        this.log(`🚨 Rischio superamento 40 minuti! Accelerazione forzata`);
        this.config.crawlDelayCurrent = this.config.crawlDelayMin;
        this.config.useParallel = true;
        this.config.pauseBetweenBatches = 2000; // Riduco pause
      }
      
      this.lastRateCheck = now;
      this.productsAtLastCheck = this.stats.checked;
    }
  }
  
  // 🔍 CHECK PRODOTTO OTTIMIZZATO
  async checkProductStock(page, product, timeout = 10000) {
    const startTime = Date.now();
    
    try {
      const searchUrl = `${this.baseUrl}/default.asp?cmdString=${product.sku}&cmd=searchProd&bFormSearch=1`;
      
      // Navigazione veloce
      const response = await page.goto(searchUrl, { 
        waitUntil: 'domcontentloaded',  // Solo DOM
        timeout: timeout
      });
      
      // Check blocco
      if (!response || response.status() === 429 || response.status() === 403) {
        this.stats.blocked++;
        this.log(`🚫 BLOCCO RILEVATO: ${response ? response.status() : 'null'}`, 'WARN');
        
        // Rallenta immediatamente
        this.config.crawlDelayCurrent = Math.min(
          this.config.crawlDelayMax,
          this.config.crawlDelayCurrent * 2
        );
        
        await new Promise(resolve => setTimeout(resolve, this.config.pauseAfterBlock));
        return false;
      }
      
      // Wait minimo (solo se necessario)
      if (this.config.crawlDelayCurrent > 1000) {
        await page.waitForTimeout(500);
      }
      
      // Estrazione veloce
      const stockInfo = await page.evaluate((targetSku) => {
        const bodyText = document.body?.innerText || '';
        
        // Check veloce presenza SKU
        if (!bodyText.toLowerCase().includes(targetSku.toLowerCase())) {
          return { foundProduct: false };
        }
        
        // Pattern ottimizzati
        const qtyMatch = bodyText.match(/(?:disponibilit[àa]|giacenza|stock|quantit[àa])\s*:?\s*(\d+)/i);
        if (qtyMatch) {
          const qty = parseInt(qtyMatch[1]);
          return {
            quantity: qty,
            available: qty > 0,
            foundProduct: true
          };
        }
        
        // Check stato
        const isOut = /non disponibile|esaurito|out of stock/i.test(bodyText);
        const isIn = /disponibile|in stock|acquista/i.test(bodyText);
        
        return {
          quantity: isOut ? 0 : (isIn ? 1 : 0),
          available: !isOut && isIn,
          foundProduct: true
        };
      }, product.sku);
      
      const responseTime = Date.now() - startTime;
      
      // Aggiorna se trovato
      if (stockInfo.foundProduct) {
        product.newStock = stockInfo.quantity || 0;
        product.newStatus = stockInfo.available ? 'instock' : 'outofstock';
        
        // Log solo cambiamenti
        if (product.currentStock !== product.newStock) {
          if (product.currentStock > 0 && product.newStock === 0) {
            this.stats.outOfStock.push(product.sku);
            this.log(`❌ OUT: ${product.sku}`);
          } else if (product.currentStock === 0 && product.newStock > 0) {
            this.stats.backInStock.push(product.sku);
            this.log(`✓ IN: ${product.sku} (${product.newStock})`);
          }
          this.stats.updated++;
        }
        
        // Aggiusta velocità
        this.adjustSpeed(true, responseTime);
        return true;
        
      } else {
        this.log(`⚠️ ${product.sku} non trovato`, 'WARN');
        this.adjustSpeed(false, responseTime);
        return false;
      }
      
    } catch (error) {
      // Se timeout, salta prodotto
      if (error.message.includes('timeout')) {
        this.stats.skipped++;
        this.log(`⏭️ Skip ${product.sku} (timeout)`);
        return false;
      }
      
      this.stats.errors++;
      this.adjustSpeed(false);
      
      // Pausa dopo errore
      await new Promise(resolve => setTimeout(resolve, this.config.pauseAfterError));
      
      return false;
      
    } finally {
      try { await page.close(); } catch {}
    }
  }
  
  // 🚀 ELABORAZIONE PARALLELA
  async processParallel(context, products) {
    const promises = products.map(async (product) => {
      const page = await context.newPage();
      const success = await this.checkProductStock(page, product, 8000);
      if (success) this.stats.checked++;
      return success;
    });
    
    await Promise.all(promises);
  }
  
  // 🎯 LOOP PRINCIPALE
  async runStockCheck(maxProducts = null) {
    const productsToCheck = Math.min(
      maxProducts || this.config.maxProductsPerSession,
      this.products.length - this.currentIndex
    );
    
    this.log('╔════════════════════════════════════════╗');
    this.log('║   STOCK CHECKER BALANCED              ║');
    this.log('╚════════════════════════════════════════╝');
    this.log(`⚡ Target: ${productsToCheck} prodotti in ${this.config.targetTimeMinutes} minuti`);
    this.log(`📊 Rate richiesto: ${this.config.targetRate} prod/sec`);
    this.log(`🎯 Delay iniziale: ${this.config.crawlDelayCurrent}ms`);
    this.log(`🔄 Velocità adattiva: SI`);
    
    const browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-web-security',
        '--disable-blink-features=AutomationControlled'
      ]
    });
    
    let context = await browser.newContext({
      userAgent: this.getRandomUserAgent(),
      viewport: { width: 1920, height: 1080 },
      bypassCSP: true,
      ignoreHTTPSErrors: true,
      extraHTTPHeaders: {
        'Accept-Language': 'it-IT,it;q=0.9',
        'Cache-Control': 'no-cache'
      }
    });
    
    const sessionStart = Date.now();
    let batchCount = 0;
    let productsInBatch = 0;
    
    try {
      // 🔥 LOOP OTTIMIZZATO
      while (this.currentIndex < this.products.length && 
             this.stats.checked < productsToCheck && 
             this.isRunning) {
        
        // Check rate periodico
        this.checkRate();
        
        if (this.config.useParallel && productsInBatch === 0) {
          // MODALITÀ PARALLELA (quando veloce)
          const parallelBatch = [];
          const parallelSize = Math.min(
            this.config.maxConcurrentPages,
            productsToCheck - this.stats.checked,
            this.products.length - this.currentIndex
          );
          
          for (let i = 0; i < parallelSize; i++) {
            if (this.currentIndex < this.products.length) {
              parallelBatch.push(this.products[this.currentIndex++]);
            }
          }
          
          if (parallelBatch.length > 0) {
            await this.processParallel(context, parallelBatch);
            productsInBatch += parallelBatch.length;
          }
          
        } else {
          // MODALITÀ SEQUENZIALE (default)
          const product = this.products[this.currentIndex++];
          const page = await context.newPage();
          
          const success = await this.checkProductStock(page, product);
          if (success) {
            this.stats.checked++;
            productsInBatch++;
          }
          
          // Delay adattivo
          if (this.currentIndex < this.products.length) {
            const delay = this.config.crawlDelayCurrent + (Math.random() * 100);
            await new Promise(resolve => setTimeout(resolve, delay));
          }
        }
        
        // Log progress
        if (this.stats.checked % 10 === 0) {
          const elapsed = (Date.now() - sessionStart) / 1000;
          const rate = this.stats.checked / elapsed;
          const percent = (this.stats.checked / productsToCheck * 100).toFixed(1);
          
          this.log(`📈 ${this.stats.checked}/${productsToCheck} (${percent}%) - ${rate.toFixed(2)} prod/sec - Delay: ${this.config.crawlDelayCurrent}ms`);
        }
        
        // Save progress
        if (this.stats.checked % 50 === 0) {
          await this.saveProgress();
        }
        
        // Gestione batch
        if (productsInBatch >= this.config.batchSize) {
          batchCount++;
          
          // Pausa solo se necessario
          if (this.config.crawlDelayCurrent > 600 || this.consecutiveErrors > 0) {
            this.log(`Batch ${batchCount} - Pausa ${this.config.pauseBetweenBatches}ms`);
            await new Promise(resolve => setTimeout(resolve, this.config.pauseBetweenBatches));
          }
          
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
          }
        }
        
        // Emergency stop se troppo lento
        const totalElapsed = (Date.now() - sessionStart) / 1000 / 60;
        if (totalElapsed > this.config.targetTimeMinutes + 5) {
          this.log(`⏰ Timeout: superati ${this.config.targetTimeMinutes} minuti`);
          break;
        }
      }
      
    } catch (error) {
      this.log(`Errore: ${error.message}`, 'ERROR');
      
    } finally {
      if (context) await context.close();
      await browser.close();
    }
    
    // Salva CSV
    await this.saveUpdatedCSV();
    
    // Report finale
    const duration = (Date.now() - this.stats.startTime) / 1000 / 60;
    const rate = this.stats.checked / (duration * 60);
    
    this.log('\n╔════════════════════════════════════════╗');
    this.log('║        REPORT FINALE                  ║');
    this.log('╚════════════════════════════════════════╝');
    this.log(`⏱️ Durata: ${duration.toFixed(1)} minuti`);
    this.log(`✅ Controllati: ${this.stats.checked} prodotti`);
    this.log(`🚀 Velocità media: ${rate.toFixed(2)} prod/sec`);
    this.log(`📊 Aggiornati: ${this.stats.updated}`);
    this.log(`❌ Out of stock: ${this.stats.outOfStock.length}`);
    this.log(`✓ Back in stock: ${this.stats.backInStock.length}`);
    this.log(`⚠️ Errori: ${this.stats.errors}`);
    this.log(`⏭️ Saltati: ${this.stats.skipped}`);
    this.log(`🚫 Blocchi: ${this.stats.blocked}`);
    
    if (duration <= this.config.targetTimeMinutes) {
      this.log(`\n✅ OBIETTIVO RAGGIUNTO: Completato in ${duration.toFixed(1)} minuti!`);
    } else {
      this.log(`\n⚠️ Tempo target superato di ${(duration - this.config.targetTimeMinutes).toFixed(1)} minuti`);
    }
    
    // Cleanup
    try {
      await fsp.unlink(this.progressPath);
    } catch {}
  }
  
  async saveUpdatedCSV() {
    try {
      this.log('Salvataggio CSV...');
      
      const csvContent = await fsp.readFile(this.csvBackupPath, 'utf8');
      const lines = csvContent.split('\n');
      const headers = lines[0];
      
      const headerArray = headers.split(',').map(h => h.trim());
      const skuIndex = headerArray.findIndex(h => h.toLowerCase() === 'sku');
      const stockQtyIndex = headerArray.findIndex(h => h.toLowerCase().includes('stock_quantity'));
      const stockStatusIndex = headerArray.findIndex(h => h.toLowerCase().includes('stock_status'));
      
      const productMap = new Map();
      this.products.forEach(p => {
        if (p.newStock !== null) {
          productMap.set(p.sku, p);
        }
      });
      
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
      
      await fsp.writeFile(this.csvLatestPath, updatedLines.join('\n'), 'utf8');
      this.log(`✓ CSV salvato`);
      
    } catch (error) {
      this.log(`Errore CSV: ${error.message}`, 'ERROR');
    }
  }
  
  stop() {
    this.isRunning = false;
  }
}

// MAIN
async function main() {
  const checker = new StockCheckerBalanced();
  
  process.on('SIGTERM', () => checker.stop());
  process.on('SIGINT', () => checker.stop());
  
  try {
    const total = await checker.loadProducts();
    
    if (total === 0) {
      console.error('❌ Nessun prodotto');
      process.exit(1);
    }
    
    const max = process.argv[2] ? parseInt(process.argv[2]) : 5000;
    
    console.log('\n⚡ STOCK CHECKER BALANCED');
    console.log(`📦 Target: ${Math.min(max, total)} prodotti in 40 minuti`);
    console.log(`🎯 Velocità richiesta: 125 prodotti/minuto`);
    
    await checker.runStockCheck(max);
    
    console.log('\n✅ Completato!');
    process.exit(0);
    
  } catch (error) {
    console.error('❌ ERRORE:', error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch(console.error);
}

module.exports = StockCheckerBalanced;
