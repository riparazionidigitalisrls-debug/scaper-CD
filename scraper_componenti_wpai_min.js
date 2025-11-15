// scraper_componenti_wpai_min.js - VERSIONE FINALE V4 - PERFETTA
// Fix: stock quantity reale, path immagini corretto, virgole rimosse, tags con spazi

const { chromium } = require('playwright');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const https = require('https');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;

class ScraperWPAIMin {
  constructor() {
    this.baseUrl = 'https://www.componentidigitali.com';

    // DISK PERSISTENTE: sempre /data su Render
    const dataDir = process.env.DATA_DIR || (process.env.RENDER ? '/data' : './data');
    this.outputDir = path.join(dataDir, 'output');
    this.imagesDir = path.join(this.outputDir, 'images');
    this.logsDir = path.join(dataDir, 'logs');

    // CSV paths
    this.csvFinalPath = path.join(this.outputDir, 'prodotti_latest.csv');
    this.csvTmpPath = path.join(this.outputDir, 'prodotti_latest.tmp.csv');
    this.logPath = path.join(this.logsDir, 'scraper.log');
    this.eventsPath = path.join(this.logsDir, 'scraper_events.json');

    // Base URL per immagini - CORRETTO SENZA PATH DOPPIO
    this.imagesHostBaseUrl = process.env.IMAGES_BASE_URL || 'https://scaper-cd.onrender.com';

    this.ensureDirs();
    
    // CSV Writer con NOMI COLONNE IDENTICI
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
        { id: 'attribute_color', title: 'Attribute:Color' },
        { id: 'attribute_model', title: 'Attribute:Model' },
        { id: 'attribute_compatibility', title: 'Attribute:Compatibility' }
      ]
    });

    this.products = [];
    this.seen = new Set();
    this.stats = {
      startTime: Date.now(),
      currentPage: 0,
      maxPages: 0,
      productsCount: 0,
      imagesDownloaded: 0,
      errors: 0,
      stockParsed: 0,
      stock999: 0
    };
  }

  ensureDirs() {
    [this.outputDir, this.imagesDir, this.logsDir].forEach(dir => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    });
  }

  log(message, level = 'INFO', page = null) {
    const timestamp = new Date().toISOString();
    const pageInfo = page !== null ? ` (Page: ${page})` : '';
    const line = `[${timestamp}] [${level}] ${message}${pageInfo}`;
    
    console.log(line);
    
    try {
      fs.appendFileSync(this.logPath, line + '\n');
      
      // Eventi per dashboard
      const event = {
        timestamp,
        level,
        message,
        page,
        stats: this.stats
      };
      
      let events = [];
      if (fs.existsSync(this.eventsPath)) {
        try {
          events = JSON.parse(fs.readFileSync(this.eventsPath, 'utf8') || '[]');
        } catch (e) {
          events = [];
        }
      }
      
      events.unshift(event);
      events = events.slice(0, 100); // Mantieni ultimi 100
      fs.writeFileSync(this.eventsPath, JSON.stringify(events, null, 2));
    } catch (e) {
      console.error('Log error:', e.message);
    }
  }

  // CRITICAL: cleanText RIMUOVE VIRGOLE
  cleanText(text) {
    if (!text) return '';
    return text
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/['"]/g, '')
      .replace(/,/g, ' ')  // ← VIRGOLE → SPAZI
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

  async scrapePage(page, url) {
    this.log(`🔍 Scraping: ${url}`, 'INFO', this.stats.currentPage);
    
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
      await page.waitForTimeout(800);
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(600);

      const items = await page.evaluate(() => {
        const nodes = document.querySelectorAll('div[class*="prod"]');
        const out = [];
        
        nodes.forEach((el, i) => {
          const txt = el.textContent || '';
          
          // Name extraction
          let name = 'Prodotto';
          const productLink = el.querySelector('a[href*=".asp"]');
          if (productLink) {
            const linkText = productLink.textContent.trim();
            if (linkText && linkText.length > 3 && !/^\d+$/.test(linkText)) {
              name = linkText;
            }
            if (name === 'Prodotto' && productLink.title) {
              name = productLink.title.trim();
            }
          }
          
          if (name === 'Prodotto') {
            const heading = el.querySelector('h2, h3, h4, .product-title, .prod-title, .nome-prodotto');
            if (heading) name = heading.textContent.trim();
          }
          
          // SKU
          let sku = '';
          const skuMatch = txt.match(/(?:cod\.?\s*art\.?|sku|codice)[:.]?\s*([A-Z0-9\-_]+)/i);
          if (skuMatch) {
            sku = skuMatch[1].trim();
          } else {
            sku = `AUTO_${Date.now()}_${i}`;
          }

          // Price
          let price = '';
          const priceMatches = [
            txt.match(/€\s*(\d+(?:[,.]\d{1,2})?)/),
            txt.match(/(\d+(?:[,.]\d{1,2})?)\s*€/),
            txt.match(/EUR\s*(\d+(?:[,.]\d{1,2})?)/i)
          ];
          for (const match of priceMatches) {
            if (match) {
              price = match[1].replace(',', '.');
              break;
            }
          }

          // Stock - VERSIONE CORRETTA CON PRIORITÀ AI NUMERI REALI
          let stockQty = 0;
          let foundExplicitQty = false;

          // PRIMA: Cerca quantità numeriche esplicite
          const qtyPatterns = [
              /(?:disponibilit[àa]|stock|giacenza|magazzino)[:.\s]*(\d+)/i,
              /(\d+)\s*(?:pezzi|pz|disponibili?|unit[àa])/i,
              /(?:qty|quantit[àa])[:.\s]*(\d+)/i,
              />\s*(\d+)\s*(?:pezzi|disponibili?)/i,
              /pezzi[:.\s]*(\d+)/i
          ];

          for (const pattern of qtyPatterns) {
              const match = txt.match(pattern);
              if (match && parseInt(match[1]) >= 0) {
                  stockQty = parseInt(match[1]);
                  foundExplicitQty = true;
                  break;
              }
          }

          // SOLO SE non ha trovato numero esplicito, usa logica generica
          if (!foundExplicitQty) {
              if (/non\s+disponibile|esaurito|sold\s*out|terminato|out\s*of\s*stock/i.test(txt)) {
                  stockQty = 0;
              } else if (/disponibile|available|in\s*stock/i.test(txt)) {
                  stockQty = 999;  // Fallback generico SOLO come ultima risorsa
              }
          }

          // Image
          const img = el.querySelector('img[src*="Foto"], img[src*="foto"], img[src*=".jpg"], img[src*=".JPG"]');
          const imageUrl = img ? (img.src || img.getAttribute('src')) : '';

          // Brand
          let brand = '';
          const brandMatch = txt.match(/(?:marca|brand|marchio)[:.]?\s*([A-Z][A-Za-z0-9\s&\-]+)/i);
          if (brandMatch) brand = brandMatch[1].trim().split(/[\n\r]/)[0];

          // Quality
          let quality = '';
          const qualityMatch = txt.match(/(?:qualità|quality)[:.]?\s*(\w+)/i);
          if (qualityMatch) quality = qualityMatch[1].trim();

          // Packaging
          let packaging = '';
          const packMatch = txt.match(/(?:confezione|packaging|package)[:.]?\s*([^\n\r€]{3,50})/i);
          if (packMatch) packaging = packMatch[1].trim();

          // Compatibility
          let compatibility = '';
          const compatMatch = txt.match(/(?:compatibile|compatibility)[:.]?\s*([^\n\r€]{3,100})/i);
          if (compatMatch) compatibility = compatMatch[1].trim();

          out.push({
            sku: sku.substring(0, 50),
            name: name.substring(0, 200),
            regular_price: price,
            stock_quantity: stockQty,
            stock_found_explicit: foundExplicitQty,
            image_url: imageUrl,
            brand: brand.substring(0, 50),
            quality: quality.substring(0, 30),
            packaging: packaging.substring(0, 100),
            compatibility: compatibility.substring(0, 100)
          });
        });
        
        return out;
      });

      if (items.length > 0) {
        this.log(`✓ Trovati ${items.length} prodotti`, 'INFO', this.stats.currentPage);
      } else {
        this.log(`⚠️ Nessun prodotto trovato`, 'WARN', this.stats.currentPage);
      }

      for (const p of items) {
        if (this.seen.has(p.sku)) continue;
        this.seen.add(p.sku);

        // Stats per debugging
        if (p.stock_found_explicit) {
          this.stats.stockParsed++;
        }
        if (p.stock_quantity === 999) {
          this.stats.stock999++;
        }

        const filename = this.getImageFilename(p.sku);
        let imagesField = '';
        
        if (p.image_url) {
          const ok = await this.downloadImageCandidates(p.image_url, filename);
          if (ok) {
            // PATH CORRETTO: /images/ SINGOLO (non doppio!)
            imagesField = `${this.imagesHostBaseUrl}/images/${filename}`;
          }
        }

        // TAGS: SPAZI invece di VIRGOLE!
        let tags = '';
        if (p.compatibility) {
          const compatClean = p.compatibility.toLowerCase()
            .replace(/\s+/g, '-')
            .replace(/,/g, '-');  // virgole → trattini
          tags = `compatible-${compatClean}`;
        }
        if (p.brand) {
          const brandClean = p.brand.toLowerCase().replace(/,/g, '-');
          tags = tags ? `${tags} ${brandClean}` : brandClean;  // ← SPAZIO!
        }

        // Short description
        let shortDesc = p.name;
        if (p.brand) shortDesc += ` - ${p.brand}`;
        if (p.compatibility) shortDesc += ` - Compatibile con ${p.compatibility}`;

        this.products.push({
          sku: this.cleanText(p.sku),
          name: this.cleanText(p.name),
          regular_price: p.regular_price,
          stock_quantity: p.stock_quantity,
          stock_status: p.stock_quantity > 0 ? 'instock' : 'outofstock',
          images: imagesField,
          categories: 'Componenti',
          tags: this.cleanText(tags),
          short_description: this.cleanText(shortDesc),
          product_type: 'simple',
          brand: this.cleanText(p.brand),
          quality: this.cleanText(p.quality),
          packaging: this.cleanText(p.packaging),
          attribute_color: '',
          attribute_model: '',
          attribute_compatibility: this.cleanText(p.compatibility)
        });
        
        this.stats.productsCount = this.products.length;
      }

      // Save progress
      this.saveProgress();

      // Next page
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
      this.log(`❌ Errore scrape: ${e.message}`, 'ERROR', this.stats.currentPage);
      return null;
    }
  }

  saveProgress() {
    const progressPath = path.join(this.outputDir, 'scraper_progress.json');
    const progress = {
      currentPage: this.stats.currentPage,
      productsCount: this.stats.productsCount,
      stats: this.stats,
      timestamp: new Date().toISOString()
    };
    
    try {
      fs.writeFileSync(progressPath, JSON.stringify(progress, null, 2));
    } catch (e) {
      this.log(`⚠️ Errore salvataggio progress: ${e.message}`, 'WARN');
    }
  }

  async scrapeAll(startUrl, maxPages = 20) {
    this.stats.maxPages = maxPages;
    
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
      const version = await browser.version();
      this.log(`🚀 Chromium ${version} avviato`, 'SUCCESS');
      
      const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      });
      const page = await context.newPage();

      let url = startUrl;
      let n = 0;

      while (url && n < maxPages) {
        n++;
        this.stats.currentPage = n;
        this.log(`📄 PAGINA ${n}/${maxPages}`, 'SUCCESS', n);
        
        const next = await this.scrapePage(page, url);
        
        if (next && next !== url) {
          url = next;
          await page.waitForTimeout(1000 + Math.random() * 1000);
        } else {
          this.log('🏁 Fine paginazione o limite raggiunto', 'SUCCESS', n);
          break;
        }
        
        // Log progress ogni 10 pagine
        if (n % 10 === 0) {
          const duration = Math.round((Date.now() - this.stats.startTime) / 60000);
          this.log(`💾 Progress: ${this.products.length} prodotti, ${this.stats.imagesDownloaded} immagini, ${duration}min`, 'SUCCESS', n);
          this.log(`📊 Stock: ${this.stats.stockParsed} parsed, ${this.stats.stock999} fallback`, 'INFO', n);
        }
      }

      const duration = Math.round((Date.now() - this.stats.startTime) / 60000);
      this.log(`✅ COMPLETATO: ${n} pagine, ${this.products.length} prodotti, ${duration}min`, 'SUCCESS', n);
      this.log(`📊 Stock Stats: ${this.stats.stockParsed} con qty esplicita, ${this.stats.stock999} fallback 999`, 'INFO');
      
    } finally {
      await browser.close();
    }
  }

  async saveCSV() {
    if (this.products.length === 0) {
      this.log('⚠️ Nessun prodotto da salvare', 'WARN');
      return;
    }

    try {
      // Scrivi CSV temporaneo
      await this.csvWriter.writeRecords(this.products);
      
      // Backup vecchio CSV
      if (fs.existsSync(this.csvFinalPath)) {
        const backupPath = path.join(this.outputDir, `prodotti_latest_backup_${Date.now()}.csv`);
        await fsp.copyFile(this.csvFinalPath, backupPath);
        this.log(`📦 Backup creato: ${backupPath}`, 'INFO');
      }
      
      // Rename atomico
      try {
        await fsp.rename(this.csvTmpPath, this.csvFinalPath);
      } catch (err) {
        await fsp.copyFile(this.csvTmpPath, this.csvFinalPath);
        await fsp.unlink(this.csvTmpPath).catch(() => {});
      }
      
      this.log(`💾 CSV salvato: ${this.csvFinalPath} (${this.products.length} righe)`, 'SUCCESS');
      
      // Stats
      const withNames = this.products.filter(p => p.name && p.name !== 'Prodotto').length;
      const withPrices = this.products.filter(p => p.regular_price).length;
      const withBrand = this.products.filter(p => p.brand).length;
      const withImages = this.products.filter(p => p.images).length;
      const explicitStock = this.stats.stockParsed;
      const fallbackStock = this.stats.stock999;
      
      this.log(`📊 Stats: ${withNames} nomi, ${withPrices} prezzi, ${withImages} img, ${withBrand} brand`, 'INFO');
      this.log(`📊 Stock: ${explicitStock} qty esplicite, ${fallbackStock} fallback 999`, 'INFO');
      
    } catch (e) {
      this.log(`❌ Errore salvataggio CSV: ${e.message}`, 'ERROR');
      throw e;
    }
  }

  async run(maxPages = 20) {
    const startUrl = `${this.baseUrl}/default.asp?cmdString=iphone&cmd=searchProd&bFormSearch=1`;
    await this.scrapeAll(startUrl, maxPages);
    await this.saveCSV();
  }
}

// Main
const maxPages = process.argv[2] ? parseInt(process.argv[2]) : 20;
new ScraperWPAIMin().run(maxPages).catch(err => {
  console.error('[FATAL]:', err);
  process.exit(1);
});
