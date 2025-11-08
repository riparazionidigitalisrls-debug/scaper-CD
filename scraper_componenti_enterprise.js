// scraper_componenti_enterprise.js - PATCHED VERSION
// Versione Enterprise con PATCH URGENTE per:
// - Salvataggio CSV incrementale ogni 10 pagine
// - Gestione SIGTERM corretta
// - Batch ridotti per evitare timeout
// - Heartbeat per Render

const { chromium } = require('playwright');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const https = require('https');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;

class ScraperComponentiEnterprise {
  constructor() {
    this.baseUrl = 'https://www.componentidigitali.com';
    
    // Directory setup compatibile con Render
    const baseDir = process.env.RENDER ? '/tmp' : '.';
    this.outputDir = path.join(baseDir, 'output');
    this.imagesDir = path.join(this.outputDir, 'images');
    this.checkpointFile = path.join(this.outputDir, 'checkpoint.json');
    
    // File naming con timestamp e link latest
    const timestamp = new Date().toISOString().split('T')[0].replace(/-/g, '');
    this.csvFullPath = path.join(this.outputDir, `prodotti_full_${timestamp}.csv`);
    this.csvTmpPath = path.join(this.outputDir, 'prodotti_tmp.csv');
    this.csvLatestPath = path.join(this.outputDir, 'prodotti_latest.csv');
    this.csvMinPath = path.join(this.outputDir, 'prodotti_wpimport_min.csv');
    this.logPath = path.join(this.outputDir, `scraper_${timestamp}.log`);
    
    // URL base per immagini
    this.imagesHostBaseUrl = process.env.IMAGES_BASE_URL || 'https://scraper-componenti.onrender.com/images';
    
    // 🔧 SETTINGS OTTIMIZZATI PER FREE TIER
    this.batchSize = 5; // ⬇️ Da 10 a 5 per ridurre tempo batch
    this.pauseBetweenBatches = 15000; // ⬇️ Da 30s a 15s per evitare timeout
    this.pauseBetweenPages = 2000;
    this.maxRetries = 3;
    this.pageTimeout = 45000;
    this.saveProgressEvery = 10; // 🆕 Salva CSV ogni 10 pagine
    
    // Tracking
    this.products = [];
    this.seen = new Set();
    this.errors = [];
    this.stats = {
      pagesScraped: 0,
      productsFound: 0,
      imagesDownloaded: 0,
      imagesSkipped: 0,
      startTime: Date.now()
    };
    
    // 🆕 Flag per graceful shutdown
    this.isShuttingDown = false;
    this.browser = null;
    
    this.ensureDirs();
    this.initCsvWriter();
    this.setupSignalHandlers(); // 🆕 Setup SIGTERM handler
  }

  // 🆕 GESTIONE SIGTERM
  setupSignalHandlers() {
    const gracefulShutdown = async (signal) => {
      if (this.isShuttingDown) return;
      this.isShuttingDown = true;
      
      this.log(`\n⚠️  ${signal} ricevuto! Salvataggio in corso...`, 'WARN');
      
      try {
        // Salva CSV parziale
        if (this.products.length > 0) {
          this.log(`Salvataggio ${this.products.length} prodotti...`);
          await this.saveCSVPartial();
          this.log('✅ CSV parziale salvato');
        }
        
        // Chiudi browser
        if (this.browser) {
          this.log('Chiusura browser...');
          await this.browser.close();
          this.log('✅ Browser chiuso');
        }
        
        this.log(`✅ Graceful shutdown completato`);
        process.exit(0);
        
      } catch (err) {
        this.log(`❌ Errore durante shutdown: ${err.message}`, 'ERROR');
        process.exit(1);
      }
    };
    
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    
    this.log('✅ Signal handlers registrati (SIGTERM, SIGINT)');
  }

  ensureDirs() {
    [this.outputDir, this.imagesDir].forEach(dir => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    });
  }

  initCsvWriter() {
    this.csvWriter = createCsvWriter({
      path: this.csvTmpPath,
      encoding: 'utf8',
      header: [
        { id: 'sku', title: 'SKU' },
        { id: 'name', title: 'Name' },
        { id: 'regular_price', title: 'Regular price' },
        { id: 'stock_quantity', title: 'Stock quantity' },
        { id: 'stock_status', title: 'Stock status' },
        { id: 'images', title: 'Images' },
        { id: 'categories', title: 'Categories' },
        { id: 'tags', title: 'Tags' },
        { id: 'short_description', title: 'Short description' },
        { id: 'product_type', title: 'Product type' },
        { id: 'brand', title: 'Brand' },
        { id: 'quality', title: 'Quality' },
        { id: 'packaging', title: 'Packaging' },
        { id: 'attribute:pa_colore', title: 'Attribute:Color' },
        { id: 'attribute:pa_modello', title: 'Attribute:Model' },
        { id: 'attribute:pa_compatibilita', title: 'Attribute:Compatibility' }
      ]
    });
  }

  log(message, level = 'INFO') {
    const line = `[${new Date().toISOString()}] [${level}] ${message}`;
    console.log(line);
    try {
      fs.appendFileSync(this.logPath, line + '\n');
    } catch (e) {
      // Ignore log errors
    }
  }

  async saveCheckpoint(currentPage, totalPages) {
    const checkpoint = {
      currentPage,
      totalPages,
      productsScraped: this.products.length,
      timestamp: Date.now(),
      stats: this.stats
    };
    
    try {
      await fsp.writeFile(this.checkpointFile, JSON.stringify(checkpoint, null, 2));
      this.log(`Checkpoint salvato: pagina ${currentPage}/${totalPages}, ${this.products.length} prodotti`);
    } catch (e) {
      this.log(`Errore salvataggio checkpoint: ${e.message}`, 'WARN');
    }
  }

  async loadCheckpoint() {
    try {
      if (fs.existsSync(this.checkpointFile)) {
        const data = await fsp.readFile(this.checkpointFile, 'utf8');
        const checkpoint = JSON.parse(data);
        
        // Checkpoint valido solo se < 24 ore
        const hoursSinceCheckpoint = (Date.now() - checkpoint.timestamp) / (1000 * 60 * 60);
        if (hoursSinceCheckpoint < 24) {
          this.log(`Checkpoint trovato: resume da pagina ${checkpoint.currentPage}`);
          return checkpoint;
        } else {
          this.log('Checkpoint troppo vecchio, inizio da capo');
        }
      }
    } catch (e) {
      this.log(`Errore caricamento checkpoint: ${e.message}`, 'WARN');
    }
    return null;
  }

  async deleteCheckpoint() {
    try {
      if (fs.existsSync(this.checkpointFile)) {
        await fsp.unlink(this.checkpointFile);
        this.log('Checkpoint eliminato dopo completamento');
      }
    } catch (e) {
      // Ignore
    }
  }

  cleanText(text) {
    if (!text) return '';
    return text
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/['"]/g, '')
      .substring(0, 200);
  }

  getImageFilename(sku) {
    const cleanSku = String(sku || '').replace(/[^a-zA-Z0-9]/g, '_');
    return `${cleanSku}.jpg`;
  }

  buildImageCandidates(imageUrl) {
    if (!imageUrl) return [];
    const m = imageUrl.match(/(\d+)(?:_\d)?\.JPG$/i);
    if (!m) return [imageUrl];
    
    const id = m[1];
    const prefixMatch = imageUrl.match(/^(https?:\/\/[^\/]+)?(.*\/)[^\/]+\.JPG$/i);
    const prefix = prefixMatch ? prefixMatch[2] : '';
    
    return [
      prefix + id + '_3.JPG',
      prefix + id + '_2.JPG',
      prefix + id + '_1.JPG',
      prefix + id + '.JPG'
    ];
  }

  async downloadImage(url, filename) {
    return new Promise((resolve) => {
      if (!url) return resolve(false);
      
      const filepath = path.join(this.imagesDir, filename);
      
      // Cache: skip se file esiste e < 30 giorni
      if (fs.existsSync(filepath)) {
        try {
          const stats = fs.statSync(filepath);
          const daysSinceDownload = (Date.now() - stats.mtime) / (1000 * 60 * 60 * 24);
          if (daysSinceDownload < 30) {
            this.stats.imagesSkipped++;
            return resolve(true);
          }
        } catch (e) {
          // Continue with download
        }
      }
      
      const fullUrl = url.startsWith('http') ? url : `${this.baseUrl}/${url.replace(/^\/+/, '')}`;
      const file = fs.createWriteStream(filepath);
      
      // Timeout di 30 secondi per download
      const timeoutId = setTimeout(() => {
        file.close();
        fs.unlink(filepath, () => {});
        resolve(false);
      }, 30000);
      
      https.get(fullUrl, (res) => {
        clearTimeout(timeoutId);
        
        if (res.statusCode === 200) {
          res.pipe(file);
          file.on('finish', () => {
            file.close();
            try {
              const size = fs.statSync(filepath).size;
              if (size < 2000) {
                fs.unlinkSync(filepath);
                resolve(false);
              } else {
                this.stats.imagesDownloaded++;
                resolve(true);
              }
            } catch {
              resolve(false);
            }
          });
        } else {
          file.close();
          fs.unlink(filepath, () => {});
          resolve(false);
        }
      }).on('error', () => {
        clearTimeout(timeoutId);
        file.close();
        fs.unlink(filepath, () => {});
        resolve(false);
      });
    });
  }

  async downloadImageCandidates(imageUrl, filename) {
    const candidates = this.buildImageCandidates(imageUrl);
    for (const candidate of candidates) {
      if (await this.downloadImage(candidate, filename)) {
        return true;
      }
    }
    return false;
  }

  extractBrandFromTitle(title) {
    if (!title) return '';
    
    const brands = [
      'Apple', 'Samsung', 'Huawei', 'Xiaomi', 'Oppo', 'Vivo', 'OnePlus',
      'Motorola', 'LG', 'Sony', 'Nokia', 'Google', 'Asus', 'Lenovo',
      'Realme', 'Honor', 'TCL', 'ZTE', 'Alcatel', 'BlackBerry', 'HTC'
    ];
    
    const upperTitle = title.toUpperCase();
    for (const brand of brands) {
      if (upperTitle.includes(brand.toUpperCase())) {
        return brand;
      }
    }
    
    const firstWord = title.split(/[\s\-\/]/)[0];
    if (firstWord && firstWord.length > 2) {
      return firstWord;
    }
    
    return '';
  }

  extractCompatibility(title, description) {
    const text = (title + ' ' + description).toLowerCase();
    const compatibility = [];
    
    const patterns = [
      /iphone\s*(\d+)(\s*pro)?(\s*max)?/gi,
      /ipad(\s*pro)?(\s*air)?(\s*mini)?/gi,
      /galaxy\s*s(\d+)/gi,
      /galaxy\s*note(\d+)?/gi,
      /redmi\s*(\d+)?/gi,
      /mi\s*(\d+)?/gi
    ];
    
    patterns.forEach(pattern => {
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const found = match[0].trim();
        if (found && !compatibility.includes(found)) {
          compatibility.push(found);
        }
      }
    });
    
    return compatibility.slice(0, 5).join(', ');
  }

  extractColor(title, description) {
    const text = (title + ' ' + description).toLowerCase();
    
    const colors = {
      'nero': 'Nero', 'black': 'Nero',
      'bianco': 'Bianco', 'white': 'Bianco',
      'blu': 'Blu', 'blue': 'Blu',
      'rosso': 'Rosso', 'red': 'Rosso',
      'verde': 'Verde', 'green': 'Verde',
      'giallo': 'Giallo', 'yellow': 'Giallo',
      'viola': 'Viola', 'purple': 'Viola',
      'oro': 'Oro', 'gold': 'Oro',
      'argento': 'Argento', 'silver': 'Argento',
      'rosa': 'Rosa', 'pink': 'Rosa'
    };
    
    for (const [keyword, color] of Object.entries(colors)) {
      if (text.includes(keyword)) {
        return color;
      }
    }
    
    return '';
  }

  async scrapePage(page, url, retries = 0) {
    try {
      // 🆕 Check se shutdown in corso
      if (this.isShuttingDown) {
        this.log('Shutdown in corso, skip pagina');
        return null;
      }

      this.log(`Scraping pagina: ${url} (tentativo ${retries + 1})`);
      
      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: this.pageTimeout
      });

      await page.waitForSelector('.intTestoImg, .titoloProdotto', { timeout: 10000 });

      const pageProducts = await page.evaluate(() => {
        const items = [];
        
        document.querySelectorAll('.intTestoImg').forEach(item => {
          try {
            const titleEl = item.querySelector('.titoloProdotto');
            const priceEl = item.querySelector('.intTestoTxtNostra');
            const stockEl = item.querySelector('.intTestoTxtStock');
            const imageEl = item.querySelector('img[src*=".JPG"]');
            const linkEl = item.querySelector('a[href*="codArt"]');
            
            if (!titleEl || !linkEl) return;
            
            const href = linkEl.href;
            const skuMatch = href.match(/codArt=([^&]+)/);
            const sku = skuMatch ? skuMatch[1] : '';
            
            const title = titleEl.innerText.trim();
            
            let price = '';
            if (priceEl) {
              const priceText = priceEl.innerText.replace(/[^\d,]/g, '');
              price = priceText.replace(',', '.');
            }
            
            let stockQty = 0;
            let stockStatus = 'outofstock';
            if (stockEl) {
              const stockText = stockEl.innerText.toLowerCase();
              if (stockText.includes('disponibile') || stockText.includes('stock')) {
                const qtyMatch = stockText.match(/(\d+)/);
                if (qtyMatch) {
                  stockQty = parseInt(qtyMatch[1]);
                  stockStatus = stockQty > 0 ? 'instock' : 'outofstock';
                } else {
                  stockQty = 1;
                  stockStatus = 'instock';
                }
              }
            }
            
            const imageSrc = imageEl ? imageEl.src : '';
            
            items.push({
              sku,
              title,
              price,
              stockQty,
              stockStatus,
              imageSrc
            });
            
          } catch (e) {
            console.error('Errore parsing prodotto:', e);
          }
        });
        
        return items;
      });

      this.log(`Trovati ${pageProducts.length} prodotti in questa pagina`);

      // Processa prodotti
      for (const prod of pageProducts) {
        if (!prod.sku || this.seen.has(prod.sku)) continue;
        this.seen.add(prod.sku);

        const brand = this.extractBrandFromTitle(prod.title);
        const compatibility = this.extractCompatibility(prod.title, '');
        const color = this.extractColor(prod.title, '');
        
        const imageFilename = this.getImageFilename(prod.sku);
        let imageUrl = '';
        
        if (prod.imageSrc) {
          const downloaded = await this.downloadImageCandidates(prod.imageSrc, imageFilename);
          if (downloaded) {
            imageUrl = `${this.imagesHostBaseUrl}/${imageFilename}`;
          }
        }

        const product = {
          sku: prod.sku,
          name: this.cleanText(prod.title),
          regular_price: prod.price,
          stock_quantity: prod.stockQty,
          stock_status: prod.stockStatus,
          images: imageUrl,
          categories: 'Componenti Smartphone',
          tags: brand ? `${brand}` : '',
          short_description: this.cleanText(prod.title),
          product_type: 'simple',
          brand: brand,
          quality: '',
          packaging: '',
          'attribute:pa_colore': color,
          'attribute:pa_modello': compatibility,
          'attribute:pa_compatibilita': compatibility
        };

        this.products.push(product);
        this.stats.productsFound++;
      }

      // Trova URL pagina successiva
      const nextUrl = await page.evaluate(() => {
        const href = window.location.href;
        const m = href.match(/pg=(\d+)/);
        const curr = m ? parseInt(m[1]) : 1;
        const next = curr + 1;
        
        const link = Array.from(document.querySelectorAll('a[href*="pg="]')).find(a => {
          const mm = a.href.match(/pg=(\d+)/);
          return mm && parseInt(mm[1]) === next;
        });
        
        if (link) return link.href;
        
        if (curr < 200) {
          return href.includes('&pg=') 
            ? href.replace(/pg=\d+/, 'pg=' + next)
            : `${href}&pg=${next}`;
        }
        
        return null;
      });

      this.stats.pagesScraped++;
      return nextUrl;

    } catch (e) {
      this.log(`Errore scraping pagina: ${e.message}`, 'ERROR');
      
      if (retries < this.maxRetries) {
        this.log(`Retry ${retries + 1}/${this.maxRetries} tra 5 secondi...`);
        await page.waitForTimeout(5000);
        return this.scrapePage(page, url, retries + 1);
      }
      
      this.errors.push({ url, error: e.message });
      return null;
    }
  }

  // 🆕 SALVATAGGIO CSV PARZIALE (senza rinominare finale)
  async saveCSVPartial() {
    if (this.products.length === 0) {
      this.log('Nessun prodotto da salvare', 'WARN');
      return;
    }

    try {
      // Scrivi CSV temporaneo
      await this.csvWriter.writeRecords(this.products);
      
      // Copia a latest e legacy (senza rinominare il tmp)
      if (fs.existsSync(this.csvLatestPath)) {
        await fsp.unlink(this.csvLatestPath);
      }
      await fsp.copyFile(this.csvTmpPath, this.csvLatestPath);
      await fsp.copyFile(this.csvTmpPath, this.csvMinPath);
      
      this.log(`✅ CSV parziale salvato: ${this.products.length} prodotti`);
      
    } catch (e) {
      this.log(`❌ Errore salvataggio CSV parziale: ${e.message}`, 'ERROR');
    }
  }

  async scrapeAll(startUrl, maxPages = 200) {
    this.browser = await chromium.launch({
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
      const context = await this.browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        viewport: { width: 1920, height: 1080 }
      });
      
      const page = await context.newPage();
      
      const version = await this.browser.version();
      this.log(`Browser ${version} avviato`);

      // Carica checkpoint se esiste
      const checkpoint = await this.loadCheckpoint();
      let startPage = 1;
      
      if (checkpoint) {
        startPage = checkpoint.currentPage;
        this.stats = checkpoint.stats;
        this.log(`Resume da checkpoint: pagina ${startPage}`);
      }

      // Costruisci URL iniziale
      let url = startUrl;
      if (startPage > 1) {
        url = startUrl + `&pg=${startPage}`;
      }

      let currentPage = startPage;
      let batchCount = 0;

      // Loop principale
      while (url && currentPage <= maxPages && !this.isShuttingDown) {
        this.log(`\n=== PAGINA ${currentPage}/${maxPages} ===`);
        
        const nextUrl = await this.scrapePage(page, url);
        
        // Salva checkpoint ogni 5 pagine
        if (currentPage % 5 === 0) {
          await this.saveCheckpoint(currentPage, maxPages);
        }

        // 🆕 SALVA CSV OGNI 10 PAGINE
        if (currentPage % this.saveProgressEvery === 0) {
          this.log(`\n💾 Salvataggio progresso (${this.products.length} prodotti)...`);
          await this.saveCSVPartial();
        }

        // Gestione batch con pausa
        batchCount++;
        if (batchCount >= this.batchSize) {
          this.log(`Pausa di ${this.pauseBetweenBatches/1000}s dopo ${this.batchSize} pagine...`);
          await page.waitForTimeout(this.pauseBetweenBatches);
          batchCount = 0;
        }

        // Prossima pagina
        if (nextUrl && nextUrl !== url) {
          url = nextUrl;
          currentPage++;
          await page.waitForTimeout(this.pauseBetweenPages + Math.random() * 2000);
        } else {
          this.log('Fine paginazione o limite raggiunto');
          break;
        }
      }

      this.log(`\n=== SCRAPING COMPLETATO ===`);
      this.log(`Pagine processate: ${this.stats.pagesScraped}`);
      this.log(`Prodotti trovati: ${this.products.length}`);

    } finally {
      if (this.browser) {
        await this.browser.close();
      }
    }
  }

  async saveCSV() {
    if (this.products.length === 0) {
      this.log('Nessun prodotto da salvare', 'WARN');
      return;
    }

    // Scrivi CSV temporaneo
    await this.csvWriter.writeRecords(this.products);
    
    // Rename atomico al file finale
    await fsp.rename(this.csvTmpPath, this.csvFullPath);
    
    // Crea link "latest" per WP All Import
    try {
      if (fs.existsSync(this.csvLatestPath)) {
        await fsp.unlink(this.csvLatestPath);
      }
      await fsp.copyFile(this.csvFullPath, this.csvLatestPath);
      await fsp.copyFile(this.csvFullPath, this.csvMinPath);
    } catch (e) {
      this.log(`Errore creazione link latest: ${e.message}`, 'WARN');
    }

    // Statistiche finali
    const duration = (Date.now() - this.stats.startTime) / 1000 / 60;
    
    this.log('\n=== STATISTICHE FINALI ===');
    this.log(`CSV salvato: ${this.csvFullPath}`);
    this.log(`Prodotti totali: ${this.products.length}`);
    this.log(`Pagine processate: ${this.stats.pagesScraped}`);
    this.log(`Immagini scaricate: ${this.stats.imagesDownloaded}`);
    this.log(`Immagini da cache: ${this.stats.imagesSkipped}`);
    this.log(`Tempo totale: ${duration.toFixed(1)} minuti`);
    this.log(`Errori: ${this.errors.length}`);
    
    const withPrices = this.products.filter(p => p.regular_price).length;
    const withBrands = this.products.filter(p => p.brand).length;
    const withCompat = this.products.filter(p => p['attribute:pa_compatibilita']).length;
    const inStock = this.products.filter(p => p.stock_quantity > 0).length;
    
    this.log(`Prodotti con prezzo: ${withPrices}`);
    this.log(`Prodotti con brand: ${withBrands}`);
    this.log(`Prodotti con compatibilità: ${withCompat}`);
    this.log(`Prodotti disponibili: ${inStock}`);
    
    if (this.products.length < 3000 && this.stats.pagesScraped > 150) {
      this.log(`ATTENZIONE: Solo ${this.products.length} prodotti su ${this.stats.pagesScraped} pagine!`, 'ERROR');
    }
    
    if (this.errors.length > 0) {
      this.log(`Pagine con errori: ${JSON.stringify(this.errors)}`, 'WARN');
    }
  }

  async cleanup() {
    await this.deleteCheckpoint();

    try {
      const files = await fsp.readdir(this.outputDir);
      const csvFiles = files
        .filter(f => f.startsWith('prodotti_full_') && f.endsWith('.csv'))
        .sort()
        .reverse();
      
      for (let i = 7; i < csvFiles.length; i++) {
        const oldFile = path.join(this.outputDir, csvFiles[i]);
        await fsp.unlink(oldFile);
        this.log(`Eliminato vecchio CSV: ${csvFiles[i]}`);
      }
    } catch (e) {
      this.log(`Errore pulizia vecchi file: ${e.message}`, 'WARN');
    }
  }

  async run(maxPages = 200) {
    const startUrl = `${this.baseUrl}/default.asp?cmdString=iphone&cmd=searchProd&bFormSearch=1`;
    
    try {
      this.log('╔════════════════════════════════════════╗');
      this.log('║   SCRAPER ENTERPRISE - PATCH v1.1     ║');
      this.log('╚════════════════════════════════════════╝');
      this.log(`Target: ${maxPages} pagine massime`);
      this.log(`Batch size: ${this.batchSize} pagine (ottimizzato)`);
      this.log(`Salvataggio CSV ogni: ${this.saveProgressEvery} pagine`);
      this.log(`Output: ${this.outputDir}`);
      
      await this.scrapeAll(startUrl, maxPages);
      await this.saveCSV();
      await this.cleanup();
      
      this.log('\n✅ SCRAPING COMPLETATO CON SUCCESSO');
      
    } catch (err) {
      this.log(`ERRORE FATALE: ${err.message}`, 'ERROR');
      this.log(`Stack: ${err.stack}`, 'ERROR');
      
      // Salva stato parziale se possibile
      if (this.products.length > 0) {
        this.log('Tentativo salvataggio parziale...');
        await this.saveCSVPartial();
      }
      
      throw err;
    }
  }
}

// Esecuzione
if (require.main === module) {
  const maxPages = process.argv[2] ? parseInt(process.argv[2]) : 200;
  const scraper = new ScraperComponentiEnterprise();
  
  scraper.run(maxPages).catch(err => {
    console.error('[FATAL]:', err);
    process.exit(1);
  });
}

module.exports = ScraperComponentiEnterprise;
