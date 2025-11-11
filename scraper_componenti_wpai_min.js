// scraper_componenti_wpai_min.js v3.0 NO LOCK
// Versione senza sistema di lock, con logging avanzato verso server

const { chromium } = require('playwright');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const https = require('https');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;

class ScraperWPAINoLock {
  constructor() {
    this.baseUrl = 'https://www.componentidigitali.com';

    const baseDir = process.env.DATA_DIR || (process.env.RENDER ? '/data' : '.');
    this.outputDir = path.join(baseDir, 'output');
    this.imagesDir = path.join(this.outputDir, 'images');
    this.logsDir = path.join(baseDir, 'logs');

    this.csvFinalPath = path.join(this.outputDir, 'prodotti_latest.csv');
    this.csvTmpPath   = path.join(this.outputDir, 'prodotti_latest.tmp.csv');
    this.logPath      = path.join(this.logsDir, 'scraper.log');
    this.progressPath = path.join(this.outputDir, 'scraper_progress.json');
    this.eventsPath   = path.join(this.logsDir, 'scraper_events.json');

    this.imagesHostBaseUrl = process.env.IMAGES_BASE_URL || '';
    
    this.saveProgressEvery = 10; // Più frequente per dashboard
    this.isShuttingDown = false;
    this.startTime = Date.now();
    this.sessionId = `scraper_${Date.now()}`;

    this.ensureDirs();
    
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

    this.products = [];
    this.seen = new Set();
    this.stats = {
      pagesProcessed: 0,
      productsFound: 0,
      imagesDownloaded: 0,
      errors: 0,
      currentPage: 0,
      startTime: Date.now(),
      lastUpdate: Date.now()
    };
  }

  ensureDirs() {
    if (!fs.existsSync(this.outputDir)) fs.mkdirSync(this.outputDir, { recursive: true });
    if (!fs.existsSync(this.imagesDir)) fs.mkdirSync(this.imagesDir, { recursive: true });
    if (!fs.existsSync(this.logsDir)) fs.mkdirSync(this.logsDir, { recursive: true });
  }

  log(m, level = 'INFO', event = null) {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] [${level}] ${m}`;
    console.log(line);
    
    try { 
      fs.appendFileSync(this.logPath, line + '\n'); 
    } catch (_) {}

    // Log eventi importanti per dashboard
    if (event || level === 'ERROR' || level === 'WARN' || level === 'SUCCESS') {
      this.logEvent({
        timestamp,
        level,
        message: m,
        event: event || 'log',
        sessionId: this.sessionId,
        stats: {...this.stats}
      });
    }
  }

  logEvent(entry) {
    try {
      let events = [];
      if (fs.existsSync(this.eventsPath)) {
        const content = fs.readFileSync(this.eventsPath, 'utf8');
        events = JSON.parse(content || '[]');
      }
      
      events.unshift(entry);
      events = events.slice(0, 500); // Mantieni ultimi 500 eventi
      
      fs.writeFileSync(this.eventsPath, JSON.stringify(events, null, 2));
    } catch (e) {
      // Silent fail
    }
  }

  async saveProgress(currentPage, status = 'running') {
    try {
      const progress = {
        sessionId: this.sessionId,
        currentPage,
        status,
        stats: this.stats,
        productsCount: this.products.length,
        seenCount: this.seen.size,
        timestamp: Date.now(),
        duration: Date.now() - this.startTime,
        lastUrl: this.lastUrl || null
      };
      await fsp.writeFile(this.progressPath, JSON.stringify(progress, null, 2));
      this.log(`✓ Progress salvato: pagina ${currentPage}, ${this.products.length} prodotti`, 'DEBUG', 'progress_saved');
    } catch (e) {
      this.log(`Errore progress: ${e.message}`, 'ERROR');
    }
  }

  async loadProgress() {
    try {
      if (fs.existsSync(this.progressPath)) {
        const data = await fsp.readFile(this.progressPath, 'utf8');
        const progress = JSON.parse(data);
        
        const hoursOld = (Date.now() - progress.timestamp) / (1000 * 60 * 60);
        if (hoursOld < 24 && progress.status !== 'completed') {
          this.log(`📂 Progress trovato: pagina ${progress.currentPage}`, 'INFO', 'progress_found');
          return progress;
        } else {
          this.log(`Progress vecchio o completato, ignoro`, 'DEBUG');
          await fsp.unlink(this.progressPath);
        }
      }
    } catch (e) {
      this.log(`Errore caricamento progress: ${e.message}`, 'WARN');
    }
    return null;
  }

  async clearProgress() {
    try {
      if (fs.existsSync(this.progressPath)) {
        await fsp.unlink(this.progressPath);
        this.log('✓ Progress eliminato (completato)', 'DEBUG');
      }
    } catch (e) {
      this.log(`Errore eliminazione progress: ${e.message}`, 'WARN');
    }
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
    return [prefix + id + '_3.JPG', prefix + id + '_2.JPG', prefix + id + '_1.JPG', prefix + id + '.JPG'];
  }

  async downloadImage(url, filename) {
    return new Promise((resolve) => {
      if (!url) return resolve(false);
      const filepath = path.join(this.imagesDir, filename);
      if (fs.existsSync(filepath)) return resolve(true);
      const full = url.startsWith('http') ? url : `${this.baseUrl}/${url.replace(/^\/+/, '')}`;
      const file = fs.createWriteStream(filepath);
      https.get(full, (res) => {
        if (res.statusCode === 200) {
          res.pipe(file);
          file.on('finish', () => {
            file.close();
            try {
              const size = fs.statSync(filepath).size;
              if (size < 2000) {
                fs.unlinkSync(filepath);
                return resolve(false);
              }
              resolve(true);
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
        file.close();
        fs.unlink(filepath, () => {});
        resolve(false);
      });
    });
  }

  async downloadImageCandidates(imageUrl, filename) {
    for (const c of this.buildImageCandidates(imageUrl)) {
      if (await this.downloadImage(c, filename)) {
        this.stats.imagesDownloaded++;
        return true;
      }
    }
    return false;
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

  async scrapePage(page, url) {
    this.log(`🔍 Scraping: ${url}`, 'INFO', 'page_start');
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
      await page.waitForTimeout(2000);
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(1500);

      const items = await page.evaluate(() => {
        const nodes = document.querySelectorAll('div[class*="prod"]');
        const out = [];
        const debug = { total: nodes.length, skipped: 0, reasons: [] };
        
        nodes.forEach((el, i) => {
          const txt = el.textContent || '';
          
          // DEBUG: Log primi 3 elementi per capire struttura
          if (i < 3) {
            console.log(`[DEBUG] Prodotto ${i}:`, txt.substring(0, 200));
          }
          
          const skuMatch = txt.match(/(?:Cod\.?\s*Art\.?|Codice|Cod|Art\.?|Articolo|Rif\.?)[:\s]*\n?\s*([A-Z0-9\-\.]+)/i);
          const nameMatch = txt.match(/^(.+?)(?:Cod\.?\s*Art\.?|Codice|€)/i);
          
          // Cerca TUTTI i prezzi (originale + scontato)
          const allPrices = txt.match(/€\s*(\d+[.,]\d+)|(\d+[.,]\d+)\s*€/g);
          let regular_price = '';
          let original_price = null;
          
          if (allPrices && allPrices.length > 0) {
            // Estrai numeri dai match
            const prices = allPrices.map(p => {
              const m = p.match(/(\d+[.,]\d+)/);
              return m ? parseFloat(m[1].replace(',', '.')) : 0;
            }).filter(p => p > 0);
            
            if (prices.length === 1) {
              // Un solo prezzo
              regular_price = prices[0].toFixed(2);
            } else if (prices.length >= 2) {
              // Più prezzi: il minore è lo scontato, il maggiore è l'originale
              const sorted = [...prices].sort((a, b) => a - b);
              regular_price = sorted[0].toFixed(2); // Prezzo più basso
              original_price = sorted[sorted.length - 1].toFixed(2); // Prezzo più alto
            }
          }
          
          const stockMatch = txt.match(/(\d+)\s*(?:pz|PZ|pezzi|disponibili|disp\.)/i);
          const brandMatch = txt.match(/(?:Marca|Brand)[:\s]*\n?\s*([^\n]+)/i);
          const qualityMatch = txt.match(/(?:Qualità|Quality)[:\s]*\n?\s*([^\n]+)/i);
          const packMatch = txt.match(/\b(?:Confezione|Imballo)\b[:\s]*\n?\s*([^\n]+)/i);
          const colorMatch = txt.match(/(?:Colore|Color)[:\s]*\n?\s*([^\n]+)/i);
          const compatMatch = txt.match(/(?:Compatibile|Compatibilità)[:\s]*\n?\s*([^\n]+)/i);

          const imgEl = el.querySelector('img[src*=".JPG"], img[src*=".jpg"], img[src*=".jpeg"]');
          const imgUrl = imgEl ? imgEl.getAttribute('src') : null;

          // DEBUG: Perché viene skippato?
          if (!skuMatch) {
            debug.skipped++;
            if (debug.reasons.length < 5) {
              debug.reasons.push(`#${i}: No SKU in "${txt.substring(0, 100)}"`);
            }
          }

          if (skuMatch) {
            out.push({
              index: i,
              sku: skuMatch[1].trim(),
              name: nameMatch ? nameMatch[1].trim() : 'Prodotto',
              regular_price: regular_price,
              stock_quantity: stockMatch ? parseInt(stockMatch[1]) : 10,
              brand: brandMatch ? brandMatch[1].trim() : '',
              quality: qualityMatch ? qualityMatch[1].trim() : '',
              packaging: packMatch ? packMatch[1].trim() : '',
              color: colorMatch ? colorMatch[1].trim() : '',
              compatibility: compatMatch ? compatMatch[1].trim() : '',
              original_price: original_price,
              image_url: imgUrl
            });
          }
        });
        
        // Ritorna anche debug info
        return { products: out, debug };
      });

      // Estrai prodotti e debug info
      const result = items;
      const products = result.products || [];
      const debugInfo = result.debug || {};
      
      this.log(`✓ Trovati ${products.length} prodotti in pagina`, 'INFO', 'products_found');
      
      if (debugInfo.skipped > 0) {
        this.log(`⚠️ Skipped ${debugInfo.skipped}/${debugInfo.total} elementi (no SKU)`, 'WARN', 'products_skipped');
        if (debugInfo.reasons && debugInfo.reasons.length > 0) {
          this.log(`Debug reasons: ${debugInfo.reasons.join('; ')}`, 'DEBUG');
        }
      }
      
      this.stats.productsFound += products.length;

      for (const p of products) {
        if (this.seen.has(p.sku)) continue;
        this.seen.add(p.sku);

        const filename = this.getImageFilename(p.sku);
        let imagesField = '';
        if (p.image_url) {
          const ok = await this.downloadImageCandidates(p.image_url, filename);
          if (ok) {
            imagesField = this.imagesHostBaseUrl
              ? (this.imagesHostBaseUrl.replace(/\/+$/, '') + '/' + filename)
              : `images/${filename}`;
          }
        }

        let tags = '';
        if (p.compatibility) {
          tags = `compatible-${p.compatibility.toLowerCase().replace(/\s+/g, '-')}`;
        }
        if (p.brand) {
          tags = tags ? `${tags},${p.brand.toLowerCase()}` : p.brand.toLowerCase();
        }

        let shortDesc = p.name;
        if (p.brand) shortDesc += ` - ${p.brand}`;
        if (p.compatibility) shortDesc += ` - Compatibile con ${p.compatibility}`;
        if (p.original_price && p.regular_price !== p.original_price) {
          const discount = Math.round((1 - parseFloat(p.regular_price) / parseFloat(p.original_price)) * 100);
          if (discount > 0) shortDesc += ` - Sconto ${discount}%`;
        }

        this.products.push({
          sku: this.cleanText(p.sku),
          name: this.cleanText(p.name),
          regular_price: p.regular_price,
          stock_quantity: p.stock_quantity,
          stock_status: p.stock_quantity > 0 ? 'instock' : 'outofstock',
          images: imagesField,
          categories: 'Componenti',
          tags: tags.substring(0, 100),
          short_description: shortDesc.substring(0, 150),
          product_type: 'simple',
          brand: this.cleanText(p.brand),
          quality: this.cleanText(p.quality),
          packaging: this.cleanText(p.packaging),
          'attribute:pa_colore': this.cleanText(p.color),
          'attribute:pa_modello': '',
          'attribute:pa_compatibilita': this.cleanText(p.compatibility)
        });
      }

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

      return nextUrl;
    } catch (e) {
      this.stats.errors++;
      this.log(`❌ Errore scrape: ${e.message}`, 'ERROR', 'scrape_error');
      return null;
    }
  }

  async scrapeAll(startUrl, maxPages = 20) {
    const progress = await this.loadProgress();
    let startPage = 1;
    
    if (progress) {
      startPage = progress.currentPage + 1;
      this.log(`🔄 Resume da pagina ${startPage}`, 'INFO', 'resume');
    }

    this.log(`🚀 AVVIO SCRAPING - Session: ${this.sessionId}`, 'SUCCESS', 'scraping_start');
    this.log(`📊 Target: ${maxPages} pagine`, 'INFO');

    const browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--single-process'
      ]
    });
    
    try {
      const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      });
      const page = await context.newPage();

      const version = await browser.version();
      this.log(`✓ Chromium ${version} avviato`, 'INFO', 'browser_started');
      
      let url = startUrl;
      let n = 0;
      
      if (progress && startPage > 1) {
        url = startUrl.includes('&pg=') 
          ? startUrl.replace(/pg=\d+/, `pg=${startPage}`)
          : `${startUrl}&pg=${startPage}`;
        n = startPage - 1;
        this.log(`→ Navigazione a pagina ${startPage}`, 'INFO');
      }
      
      while (url && n < maxPages) {
        if (this.isShuttingDown) {
          this.log('⚠️ Shutdown richiesto', 'WARN', 'shutdown');
          break;
        }

        n++;
        this.stats.currentPage = n;
        this.stats.pagesProcessed = n;
        this.stats.lastUpdate = Date.now();
        this.lastUrl = url;
        
        this.log(`\n${'='.repeat(50)}`, 'INFO');
        this.log(`📄 PAGINA ${n}/${maxPages}`, 'SUCCESS', 'page_progress');
        this.log(`${'='.repeat(50)}`, 'INFO');
        
        const next = await this.scrapePage(page, url);
        
        // Salva progress più frequentemente per dashboard
        if (n % this.saveProgressEvery === 0 || n === maxPages) {
          await this.saveCSV();
          await this.saveProgress(n, 'running');
          const duration = Math.round((Date.now() - this.startTime) / 60000);
          this.log(`💾 Progress: ${this.products.length} prodotti, ${this.stats.imagesDownloaded} immagini, ${duration}min`, 'SUCCESS', 'checkpoint');
        }
        
        if (next && next !== url) {
          url = next;
          const delay = 5000 + Math.random() * 5000; // 5-10s (ottimizzato!)
          this.log(`⏳ Pausa ${Math.round(delay/1000)}s prima prossima pagina...`, 'DEBUG');
          await page.waitForTimeout(delay);
        } else {
          this.log('✓ Fine paginazione', 'INFO', 'pagination_end');
          break;
        }
      }

      const duration = Math.round((Date.now() - this.startTime) / 60000);
      this.log(`\n${'='.repeat(50)}`, 'SUCCESS');
      this.log(`✅ COMPLETATO: ${n} pagine, ${this.products.length} prodotti, ${duration}min`, 'SUCCESS', 'scraping_complete');
      this.log(`${'='.repeat(50)}`, 'SUCCESS');
      
    } finally {
      await browser.close();
      this.log('✓ Browser chiuso', 'DEBUG');
    }
  }

  async saveCSV() {
    if (this.products.length === 0) {
      this.log('⚠️ Nessun prodotto da salvare', 'WARN');
      return;
    }
    
    await this.csvWriter.writeRecords(this.products);
    
    try {
      await fsp.rename(this.csvTmpPath, this.csvFinalPath);
    } catch (err) {
      await fsp.copyFile(this.csvTmpPath, this.csvFinalPath).catch(() => {});
      await fsp.unlink(this.csvTmpPath).catch(() => {});
    }
    
    this.log(`💾 CSV salvato: ${this.csvFinalPath} (${this.products.length} righe)`, 'SUCCESS', 'csv_saved');
    
    const withNames = this.products.filter(p => p.name && p.name !== 'Prodotto').length;
    const withPrices = this.products.filter(p => p.regular_price).length;
    const withImages = this.products.filter(p => p.images).length;
    const withBrands = this.products.filter(p => p.brand).length;
    
    this.log(`📊 Stats: ${withNames} nomi, ${withPrices} prezzi, ${withImages} img, ${withBrands} brand`, 'INFO', 'csv_stats');
  }

  async run(maxPages = 20) {
    this.log(`\n${'█'.repeat(60)}`, 'INFO');
    this.log(`${'█'.repeat(60)}`, 'INFO');
    this.log(`   SCRAPER COMPONENTI DIGITALI v3.0 NO LOCK`, 'SUCCESS');
    this.log(`   Session ID: ${this.sessionId}`, 'INFO');
    this.log(`   Target Pages: ${maxPages}`, 'INFO');
    this.log(`   Start Time: ${new Date().toLocaleString('it-IT')}`, 'INFO');
    this.log(`${'█'.repeat(60)}`, 'INFO');
    this.log(`${'█'.repeat(60)}\n`, 'INFO');
    
    try {
      const gracefulShutdown = async (signal) => {
        if (this.isShuttingDown) return;
        this.isShuttingDown = true;
        
        this.log(`\n⚠️ ${signal} ricevuto`, 'WARN', 'signal_received');
        
        try {
          if (this.products.length > 0) {
            await this.saveCSV();
            this.log('✅ CSV salvato', 'SUCCESS');
          }
          
          await this.saveProgress(this.stats.currentPage, 'interrupted');
          this.log('✅ Progress salvato per resume', 'SUCCESS');
          this.log('✅ Graceful shutdown completato', 'SUCCESS', 'shutdown_complete');
          
          process.exit(0);
        } catch (err) {
          this.log(`❌ Errore shutdown: ${err.message}`, 'ERROR');
          process.exit(1);
        }
      };
      
      process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
      process.on('SIGINT', () => gracefulShutdown('SIGINT'));
      
      const startUrl = `${this.baseUrl}/default.asp?cmdString=iphone&cmd=searchProd&bFormSearch=1&orderBy=descA`;
      
      await this.scrapeAll(startUrl, maxPages);
      await this.saveCSV();
      await this.saveProgress(this.stats.currentPage, 'completed');
      await this.clearProgress();
      
      const duration = Math.round((Date.now() - this.startTime) / 60000);
      this.log(`\n✅ SCRAPING COMPLETATO CON SUCCESSO`, 'SUCCESS', 'final_success');
      this.log(`📊 Prodotti: ${this.products.length}`, 'SUCCESS');
      this.log(`🖼️ Immagini: ${this.stats.imagesDownloaded}`, 'SUCCESS');
      this.log(`⏱️ Durata: ${duration} minuti`, 'SUCCESS');
      this.log(`❌ Errori: ${this.stats.errors}`, this.stats.errors > 0 ? 'WARN' : 'SUCCESS');
      
    } catch (err) {
      this.stats.errors++;
      this.log(`❌ ERRORE FATALE: ${err.message}`, 'ERROR', 'fatal_error');
      this.log(`Stack: ${err.stack}`, 'ERROR');
      
      if (this.products.length > 0) {
        this.log('⚠️ Tentativo salvataggio parziale', 'WARN');
        try {
          await this.saveCSV();
          await this.saveProgress(this.stats.currentPage, 'error');
          this.log('✅ CSV parziale salvato', 'SUCCESS');
        } catch (saveErr) {
          this.log(`❌ Errore salvataggio parziale: ${saveErr.message}`, 'ERROR');
        }
      }
      
      throw err;
    }
  }
}

const maxPages = process.argv[2] ? parseInt(process.argv[2]) : 20;
new ScraperWPAINoLock().run(maxPages).catch(err => {
  console.error('[FATAL]:', err);
  process.exit(1);
});
