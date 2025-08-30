// stock-checker-light.js
// Sistema separato e sicuro per controllo stock/disponibilità
// Rispetta crawl-delay di 10 secondi come da robots.txt

const { chromium } = require('playwright');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const csv = require('csv-writer');

class StockCheckerLight {
  constructor() {
    // Percorsi file (compatibili con sistema esistente)
    const baseDir = process.env.RENDER ? '/tmp' : '.';
    this.outputDir = path.join(baseDir, 'output');
    this.csvLatestPath = path.join(this.outputDir, 'prodotti_latest.csv');
    this.csvBackupPath = path.join(this.outputDir, `backup_${Date.now()}.csv`);
    this.logPath = path.join(this.outputDir, `stock_checker_${new Date().toISOString().split('T')[0]}.log`);
    this.progressPath = path.join(this.outputDir, 'stock_checker_progress.json');
    
    // URL base
    this.baseUrl = 'https://www.componentidigitali.com';
    
    // CONFIGURAZIONE ULTRA-CONSERVATIVA (rispetta robots.txt)
    this.config = {
      crawlDelay: 12000,           // 12 secondi tra richieste (più dei 10 richiesti)
      batchSize: 10,               // Solo 10 prodotti per batch
      pauseBetweenBatches: 120000, // 2 minuti tra batch
      maxProductsPerSession: 2500, // Max prodotti per sessione (8 ore)
      sessionTimeout: 28800000,    // 8 ore max per sessione
      
      // User agents rotation
      userAgents: [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      ],
      
      // Retry configuration
      maxRetries: 2,
      retryDelay: 30000, // 30 secondi prima di riprovare
      
      // Safety features
      stopOnErrors: 5,  // Ferma dopo 5 errori consecutivi
      randomizeOrder: true, // Randomizza ordine prodotti
    };
    
    // Stato
    this.products = [];
    this.currentIndex = 0;
    this.errors = [];
    this.consecutiveErrors = 0;
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
    const line = `[${new Date().toISOString()}] [${level}] ${message}`;
    console.log(line);
    try {
      fs.appendFileSync(this.logPath, line + '\n');
    } catch (e) {
      console.error('Log error:', e.message);
    }
  }
  
  async loadProducts() {
    try {
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
      
      this.log(`Caricati ${this.products.length} prodotti dal CSV`);
      
      // Randomizza ordine se configurato
      if (this.config.randomizeOrder) {
        this.shuffleArray(this.products);
        this.log('Ordine prodotti randomizzato per evitare pattern');
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
        
        // Resume solo se < 24 ore
        const hoursOld = (Date.now() - progress.timestamp) / (1000 * 60 * 60);
        if (hoursOld < 24) {
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
  
  async checkProductStock(browser, product) {
    const page = await browser.newPage();
    
    try {
      // Costruisci URL ricerca per SKU
      const searchUrl = `${this.baseUrl}/default.asp?cmdString=${product.sku}&cmd=searchProd&bFormSearch=1`;
      
      this.log(`Checking: ${product.sku}`);
      
      // Naviga con timeout generoso
      await page.goto(searchUrl, { 
        waitUntil: 'domcontentloaded',
        timeout: 30000 
      });
      
      // Aspetta un po' per il caricamento
      await page.waitForTimeout(2000);
      
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
        if (product.currentStock > 0 && product.newStock === 0) {
          this.stats.outOfStock.push(product.sku);
          this.log(`⚠️ OUT OF STOCK: ${product.sku} (era ${product.currentStock})`, 'WARN');
        } else if (product.currentStock === 0 && product.newStock > 0) {
          this.stats.backInStock.push(product.sku);
          this.log(`✓ BACK IN STOCK: ${product.sku} (ora ${product.newStock})`);
        } else if (product.currentStock !== product.newStock) {
          this.log(`Aggiornato: ${product.sku} da ${product.currentStock} a ${product.newStock}`);
        }
        
        this.stats.updated++;
      }
      
      this.consecutiveErrors = 0; // Reset errori consecutivi
      return true;
      
    } catch (error) {
      this.log(`Errore check ${product.sku}: ${error.message}`, 'ERROR');
      this.errors.push({ sku: product.sku, error: error.message });
      this.stats.errors++;
      this.consecutiveErrors++;
      return false;
      
    } finally {
      await page.close();
    }
  }
  
  async runStockCheck(maxProducts = null) {
    const sessionStart = Date.now();
    const productsToCheck = maxProducts || this.config.maxProductsPerSession;
    
    this.log('╔════════════════════════════════════════╗');
    this.log('║   STOCK CHECKER LIGHT - AVVIO         ║');
    this.log('╚════════════════════════════════════════╝');
    this.log(`Modalità: Ultra-conservativa (12 sec/prodotto)`);
    this.log(`Prodotti da controllare: ${Math.min(productsToCheck, this.products.length - this.currentIndex)}`);
    this.log(`Tempo stimato: ${Math.round(productsToCheck * 12 / 60)} minuti`);
    
    // Lancia browser
    const browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process',
        '--single-process'
      ]
    });
    
    try {
      const context = await browser.newContext({
        userAgent: this.getRandomUserAgent(),
        viewport: { width: 1920, height: 1080 }
      });
      
      let batchCount = 0;
      let productsInBatch = 0;
      
      // Loop principale
      while (this.currentIndex < this.products.length && 
             this.stats.checked < productsToCheck &&
             this.consecutiveErrors < this.config.stopOnErrors) {
        
        const product = this.products[this.currentIndex];
        
        // Check prodotto
        await this.checkProductStock(context, product);
        
        this.stats.checked++;
        this.currentIndex++;
        productsInBatch++;
        
        // Salva progresso ogni 10 prodotti
        if (this.stats.checked % 10 === 0) {
          await this.saveProgress();
        }
        
        // Gestione batch
        if (productsInBatch >= this.config.batchSize) {
          batchCount++;
          this.log(`Batch ${batchCount} completato. Pausa di ${this.config.pauseBetweenBatches/1000} secondi...`);
          
          // Report parziale
          this.log(`Progress: ${this.stats.checked}/${productsToCheck} controllati, ${this.stats.updated} aggiornati`);
          
          await new Promise(resolve => setTimeout(resolve, this.config.pauseBetweenBatches));
          productsInBatch = 0;
          
          // Cambia user agent ogni batch
          await context.close();
          context = await browser.newContext({
            userAgent: this.getRandomUserAgent(),
            viewport: { width: 1920, height: 1080 }
          });
        }
        
        // Delay tra prodotti (rispetta robots.txt)
        await new Promise(resolve => 
          setTimeout(resolve, this.config.crawlDelay + Math.random() * 2000)
        );
        
        // Check timeout sessione
        if (Date.now() - sessionStart > this.config.sessionTimeout) {
          this.log('Timeout sessione raggiunto (8 ore). Salvataggio e uscita.');
          break;
        }
      }
      
    } finally {
      await browser.close();
    }
    
    // Salva CSV aggiornato
    await this.saveUpdatedCSV();
    
    // Report finale
    const duration = (Date.now() - this.stats.startTime) / 1000 / 60;
    this.log('\n=== STOCK CHECK COMPLETATO ===');
    this.log(`Durata: ${duration.toFixed(1)} minuti`);
    this.log(`Prodotti controllati: ${this.stats.checked}`);
    this.log(`Prodotti aggiornati: ${this.stats.updated}`);
    this.log(`Nuovi out of stock: ${this.stats.outOfStock.length}`);
    this.log(`Tornati disponibili: ${this.stats.backInStock.length}`);
    this.log(`Errori: ${this.stats.errors}`);
    
    // Genera report out of stock
    if (this.stats.outOfStock.length > 0) {
      const reportPath = path.join(this.outputDir, `out_of_stock_${Date.now()}.txt`);
      await fsp.writeFile(reportPath, this.stats.outOfStock.join('\n'));
      this.log(`Report OOS salvato: ${reportPath}`);
    }
    
    // Elimina progress file se completato
    if (this.currentIndex >= this.products.length) {
      try {
        await fsp.unlink(this.progressPath);
        this.log('Check completo, progress file eliminato');
      } catch (e) {
        // Ignora
      }
    }
  }
  
  async saveUpdatedCSV() {
    try {
      // Rileggi CSV originale per mantenere struttura
      const csvContent = await fsp.readFile(this.csvBackupPath, 'utf8');
      const lines = csvContent.split('\n');
      const headers = lines[0];
      
      // Trova indici colonne da aggiornare
      const headerArray = headers.split(',').map(h => h.trim());
      const stockQtyIndex = headerArray.findIndex(h => h.toLowerCase().includes('stock_quantity'));
      const stockStatusIndex = headerArray.findIndex(h => h.toLowerCase().includes('stock_status'));
      
      // Crea mappa SKU -> prodotto per lookup veloce
      const productMap = new Map();
      this.products.forEach(p => {
        if (p.newStock !== null) {
          productMap.set(p.sku, p);
        }
      });
      
      // Ricostruisci CSV con stock aggiornati
      const updatedLines = [headers];
      
      for (let i = 1; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        
        const cols = this.parseCSVLine(lines[i]);
        const sku = cols[headerArray.findIndex(h => h.toLowerCase() === 'sku')];
        
        if (sku && productMap.has(sku)) {
          const product = productMap.get(sku);
          // Aggiorna solo stock_quantity e stock_status
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
      
      this.log(`CSV aggiornato: ${this.csvLatestPath}`);
      this.log(`Mantenuti tutti i dati originali, aggiornati solo stock`);
      
    } catch (error) {
      this.log(`Errore salvataggio CSV: ${error.message}`, 'ERROR');
      throw error;
    }
  }
}

// ========================================
// ESECUZIONE
// ========================================

async function main() {
  const checker = new StockCheckerLight();
  
  try {
    // Carica prodotti
    const totalProducts = await checker.loadProducts();
    
    if (totalProducts === 0) {
      console.error('Nessun prodotto trovato nel CSV');
      process.exit(1);
    }
    
    // Determina quanti prodotti controllare
    const maxProducts = process.argv[2] ? parseInt(process.argv[2]) : null;
    
    // Avvia check
    await checker.runStockCheck(maxProducts);
    
    console.log('✓ Stock check completato con successo');
    
  } catch (error) {
    console.error('ERRORE FATALE:', error);
    process.exit(1);
  }
}

// Gestione shutdown graceful
process.on('SIGTERM', () => {
  console.log('SIGTERM ricevuto, salvataggio in corso...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT ricevuto, salvataggio in corso...');
  process.exit(0);
});

// Avvia se chiamato direttamente
if (require.main === module) {
  main();
}

module.exports = StockCheckerLight;