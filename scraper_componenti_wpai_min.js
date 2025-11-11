// scraper_componenti_wpai_min.js v2.4
// Versione finale ottimizzata con sistema di LOCK

const { chromium } = require('playwright');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const https = require('https');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;

class ScraperWPAIFinal {
  constructor() {
    this.baseUrl = 'https://www.componentidigitali.com';

    const baseDir = process.env.DATA_DIR || (process.env.RENDER ? '/data' : '.');
    this.outputDir = path.join(baseDir, 'output');
    this.imagesDir = path.join(this.outputDir, 'images');

    this.csvFinalPath = path.join(this.outputDir, 'prodotti_latest.csv');
    this.csvTmpPath   = path.join(this.outputDir, 'prodotti_latest.tmp.csv');
    this.logPath      = path.join(this.outputDir, 'scraper.log');
    this.checkpointPath = path.join(this.outputDir, 'scraper_checkpoint.json');
    this.lockPath = path.join(this.outputDir, 'scraper.lock'); // 🆕 LOCK

    this.imagesHostBaseUrl = process.env.IMAGES_BASE_URL || '';
    
    this.saveProgressEvery = 20;
    this.isShuttingDown = false;

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
  }

  ensureDirs() {
    if (!fs.existsSync(this.outputDir)) fs.mkdirSync(this.outputDir, { recursive: true });
    if (!fs.existsSync(this.imagesDir)) fs.mkdirSync(this.imagesDir, { recursive: true });
  }

  log(m) {
    const line = `[${new Date().toISOString()}] ${m}`;
    console.log(line);
    try { fs.appendFileSync(this.logPath, line + '\n'); } catch (_) {}
  }

  // 🆕 SISTEMA DI LOCK
  async acquireLock() {
    try {
      if (fs.existsSync(this.lockPath)) {
        const lockData = JSON.parse(fs.readFileSync(this.lockPath, 'utf8'));
        const lockAge = Date.now() - lockData.timestamp;
        
        // Lock stale dopo 4 ore
        if (lockAge > 14400000) {
          this.log('⚠️ Lock file stale (>4h), lo rimuovo');
          fs.unlinkSync(this.lockPath);
        } else {
          this.log('❌ Altro scraper in corso, uscita');
          this.log(`Lock da PID ${lockData.pid} alle ${new Date(lockData.timestamp).toLocaleString()}`);
          return false;
        }
      }
      
      const lockData = {
        pid: process.pid,
        timestamp: Date.now(),
        startedAt: new Date().toISOString()
      };
      
      fs.writeFileSync(this.lockPath, JSON.stringify(lockData, null, 2));
      this.log(`✅ Lock acquisito (PID ${process.pid})`);
      return true;
    } catch (e) {
      this.log(`Errore lock: ${e.message}`);
      return false;
    }
  }

  async releaseLock() {
    try {
      if (fs.existsSync(this.lockPath)) {
        fs.unlinkSync(this.lockPath);
        this.log('✅ Lock rilasciato');
      }
    } catch (e) {
      this.log(`Errore rilascio lock: ${e.message}`);
    }
  }

  async saveCheckpoint(currentPage) {
    try {
      const checkpoint = {
        currentPage,
        productsCount: this.products.length,
        seenCount: this.seen.size,
        timestamp: Date.now(),
        lastUrl: this.lastUrl || null
      };
      await fsp.writeFile(this.checkpointPath, JSON.stringify(checkpoint, null, 2));
      this.log(`✓ Checkpoint salvato: pagina ${currentPage}, ${this.products.length} prodotti`);
    } catch (e) {
      this.log(`Errore checkpoint: ${e.message}`);
    }
  }

  async loadCheckpoint() {
    try {
      if (fs.existsSync(this.checkpointPath)) {
        const data = await fsp.readFile(this.checkpointPath, 'utf8');
        const checkpoint = JSON.parse(data);
        
        const hoursOld = (Date.now() - checkpoint.timestamp) / (1000 * 60 * 60);
        if (hoursOld < 24) {
          this.log(`📂 Resume da pagina ${checkpoint.currentPage}`);
          return checkpoint;
        } else {
          this.log(`Checkpoint vecchio (${hoursOld.toFixed(1)}h), ignoro`);
          await fsp.unlink(this.checkpointPath);
        }
      }
    } catch (e) {
      this.log(`Errore caricamento checkpoint: ${e.message}`);
    }
    return null;
  }

  async clearCheckpoint() {
    try {
      if (fs.existsSync(this.checkpointPath)) {
        await fsp.unlink(this.checkpointPath);
        this.log('✓ Checkpoint eliminato');
      }
    } catch (e) {
      this.log(`Errore eliminazione checkpoint: ${e.message}`);
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
      if (await this.downloadImage(c, filename)) return true;
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
    this.log(`Scraping: ${url}`);
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
      await page.waitForTimeout(2000);
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(1500);

      const items = await page.evaluate(() => {
        const nodes = document.querySelectorAll('div[class*="prod"]');
        const out = [];
        
        nodes.forEach((el, i) => {
          const txt = el.textContent || '';
          
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
            if (heading) {
              const headingText = heading.textContent.trim();
              if (headingText && headingText.length > 3) {
                name = headingText;
              }
            }
          }
          
          if (name === 'Prodotto') {
            const titleEl = el.querySelector('[class*="title"], [class*="nome"], [class*="name"], .descrizione');
            if (titleEl) {
              const titleText = titleEl.textContent.trim();
              if (titleText && titleText.length > 3 && !titleText.match(/^(cod|sku|art)/i)) {
                name = titleText;
              }
            }
          }
          
          if (name === 'Prodotto') {
            const descMatch = txt.match(/(?:descrizione|prodotto|articolo)[:.]?\s*([^€\n]{10,100})/i);
            if (descMatch) {
              name = descMatch[1].trim();
            }
          }
          
          if (name === 'Prodotto') {
            const img = el.querySelector('img[alt]');
            if (img && img.alt && img.alt.length > 3) {
              name = img.alt.trim();
            }
          }

          let sku = '';
          const skuMatch = txt.match(/(?:cod\.?\s*art\.?|sku|codice)[:.]?\s*([A-Z0-9\-_]+)/i);
          if (skuMatch) {
            sku = skuMatch[1].trim();
          } else {
            const skuEl = el.querySelector('[data-sku], [data-code], .sku, .codice');
            if (skuEl) {
              sku = skuEl.getAttribute('data-sku') ||
                    skuEl.getAttribute('data-code') ||
                    skuEl.textContent.trim();
            }
          }
          if (!sku) {
            sku = `AUTO_${Date.now()}_${i}`;
          }

          let price = '';
          let originalPrice = '';
          
          const discountPattern = txt.match(/€\s*(\d+(?:[,.]\d{1,2})?)\s*[Ss]conto\s*\d+\s*%\s*€\s*(\d+(?:[,.]\d{1,2})?)/);
          
          if (discountPattern) {
            originalPrice = discountPattern[1].replace(',', '.');
            price = discountPattern[2].replace(',', '.');
          } else {
            const priceRegex = /€\s*(\d+(?:[,.]\d{1,2})?)/g;
            const pricesFound = [];
            let match;
            while ((match = priceRegex.exec(txt)) !== null) {
              if (match[1]) pricesFound.push(match[1].replace(',', '.'));
            }
            
            if (pricesFound.length > 0) {
              price = pricesFound[pricesFound.length - 1];
              
              if (pricesFound.length >= 2) {
                const firstPrice = parseFloat(pricesFound[0]);
                const lastPrice = parseFloat(price);
                if (firstPrice > lastPrice) {
                  originalPrice = pricesFound[0];
                }
              }
            } else {
              const altMatch = txt.match(/EUR\s*(\d+(?:[,.]\d{1,2})?)/i) ||
                              txt.match(/prezzo[:.]?\s*(\d+(?:[,.]\d{1,2})?)/i);
              if (altMatch) {
                price = altMatch[1].replace(',', '.');
              }
            }
          }

          let stockQty = 1;
          
          const qtyParens = txt.match(/[Dd]isponibile\s*\(\s*(\d+)\s*PZ\s*\)/i);
          if (qtyParens) {
            stockQty = parseInt(qtyParens[1]);
          } else if (/non\s+disponibile|esaurito|sold\s*out/i.test(txt)) {
            stockQty = 0;
          } else if (/disponibile|available|in\s*stock/i.test(txt)) {
            stockQty = 1;
          } else {
            const qtyMatch = txt.match(/(?:pezzi|pz|qty|quantità)[:.]?\s*(\d+)/i);
            if (qtyMatch) {
              stockQty = parseInt(qtyMatch[1]);
            }
          }

          const img = el.querySelector('img[src*="Foto"], img[src*="foto"], img[src*=".jpg"], img[src*=".JPG"], img[src*=".png"]');
          const imageUrl = img ? (img.src || img.getAttribute('src')) : '';

          let brand = '';
          const brandMatch = txt.match(/(?:marca|brand|marchio|produttore)[:.]?\s*([A-Z][A-Za-z0-9\s&\-]+)/i);
          if (brandMatch) {
            brand = brandMatch[1].trim().split(/[\n\r€]/)[0].trim();
          }
          
          if (!brand) {
            const knownBrands = ['Apple', 'Samsung', 'Huawei', 'Xiaomi', 'LG', 'Sony', 'Nokia', 
                                'Motorola', 'Oppo', 'OnePlus', 'Google', 'Asus', 'Honor'];
            for (const b of knownBrands) {
              const brandRegex = new RegExp(`\\b${b}\\b`, 'i');
              if (brandRegex.test(txt)) {
                brand = b;
                break;
              }
            }
          }

          let quality = '';
          const qualityMatch = txt.match(/(?:qualità|quality)[:.]?\s*(\w+)/i);
          if (qualityMatch) quality = qualityMatch[1].trim();

          let packaging = '';
          const packMatch = txt.match(/(?:confezione|packaging|package|conf\.)[:.]?\s*([^\n\r€]{3,50})/i);
          if (packMatch) {
            packaging = packMatch[1].trim();
          }

          let compatibility = '';
          const compatMatch = txt.match(/(?:compatibil[eità]+|[Pp]er|[Ff]or)[:.]?\s*(iPhone\s+[^\s,€\n]+|Samsung\s+[^\s,€\n]+|Huawei\s+[^\s,€\n]+|Xiaomi\s+[^\s,€\n]+)/i);
          if (compatMatch) {
            compatibility = compatMatch[1].trim();
          } else {
            const modelMatch = txt.match(/\b(iPhone\s+\d+[^\s,]*|Galaxy\s+[A-Z]\d+|Mi\s+\d+|P\d+\s+Pro)\b/i);
            if (modelMatch) {
              compatibility = modelMatch[1].trim();
            }
          }

          let color = '';
          const colorMatch = txt.match(/(?:colore|color|colour)[:.]?\s*([A-Za-z]+|nero|bianco|rosso|blu|verde|giallo|grigio|oro|argento)/i);
          if (colorMatch) {
            color = colorMatch[1].trim();
          }

          if (name.includes(sku) && name.length > sku.length + 5) {
            name = name.replace(sku, '').trim();
          }
          name = name.replace(/€\s*\d+[,.]?\d*/, '').trim();
          name = name.replace(/[^\w\s\-\(\)\/&.,àèéìòù]/gi, ' ').replace(/\s+/g, ' ').trim();
          
          if (name === 'Prodotto' || name.length < 5) {
            const typeMatch = txt.match(/(?:display|lcd|batteria|battery|cover|cable|cavo|vetro|glass|flex)/i);
            name = typeMatch ? `${typeMatch[0]} ${sku}` : `Componente ${sku}`;
          }

          out.push({
            sku: sku.substring(0, 50),
            name: name.substring(0, 200),
            regular_price: price,
            original_price: originalPrice,
            stock_quantity: stockQty,
            image_url: imageUrl,
            brand: brand.substring(0, 50),
            quality: quality.substring(0, 30),
            packaging: packaging.substring(0, 100),
            compatibility: compatibility.substring(0, 100),
            color: color.substring(0, 30)
          });
        });
        
        return out;
      });

      if (items.length > 0) {
        this.log(`Trovati ${items.length} prodotti. Esempio: SKU=${items[0].sku}, Name="${items[0].name}", Price=${items[0].regular_price}`);
      }

      for (const p of items) {
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
      this.log(`Errore scrape: ${e.message}`);
      return null;
    }
  }

  async scrapeAll(startUrl, maxPages = 20) {
    const checkpoint = await this.loadCheckpoint();
    let startPage = 1;
    
    if (checkpoint) {
      startPage = checkpoint.currentPage + 1;
      this.log(`🔄 Resume da pagina ${startPage}`);
    }

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
      this.log(`Chromium ${version} avviato`);
      
      let url = startUrl;
      let n = 0;
      
      if (checkpoint && startPage > 1) {
        url = startUrl.includes('&pg=') 
          ? startUrl.replace(/pg=\d+/, `pg=${startPage}`)
          : `${startUrl}&pg=${startPage}`;
        n = startPage - 1;
        this.log(`Navigazione a pagina ${startPage}`);
      }
      
      while (url && n < maxPages) {
        if (this.isShuttingDown) {
          this.log('⚠️ Shutdown richiesto');
          break;
        }

        n++;
        this.lastUrl = url;
        this.log(`=== PAGINA ${n}/${maxPages} ===`);
        const next = await this.scrapePage(page, url);
        
        if (n % this.saveProgressEvery === 0) {
          await this.saveCSV();
          await this.saveCheckpoint(n);
          this.log(`💾 Progress: ${this.products.length} prodotti, pagina ${n}`);
        }
        
        if (next && next !== url) {
          url = next;
          await page.waitForTimeout(30000 + Math.random() * 30000);
        } else {
          this.log('Fine paginazione');
          break;
        }
      }

      this.log(`COMPLETATO: ${n} pagine, ${this.products.length} prodotti`);
    } finally {
      await browser.close();
    }
  }

  async saveCSV() {
    if (this.products.length === 0) {
      this.log('Nessun prodotto da salvare');
      return;
    }
    await this.csvWriter.writeRecords(this.products);
    
    try {
      await fsp.rename(this.csvTmpPath, this.csvFinalPath);
    } catch (err) {
      await fsp.copyFile(this.csvTmpPath, this.csvFinalPath).catch(() => {});
      await fsp.unlink(this.csvTmpPath).catch(() => {});
    }
    
    this.log(`CSV salvato: ${this.csvFinalPath} (${this.products.length} righe)`);
    
    const withNames = this.products.filter(p => p.name && p.name !== 'Prodotto').length;
    const withPrices = this.products.filter(p => p.regular_price).length;
    const withBrands = this.products.filter(p => p.brand).length;
    const withCompat = this.products.filter(p => p['attribute:pa_compatibilita']).length;
    const withColor = this.products.filter(p => p['attribute:pa_colore']).length;
    const withRealStock = this.products.filter(p => p.stock_quantity > 0 && p.stock_quantity !== 10).length;
    
    this.log(`Stats: ${withNames} nomi, ${withPrices} prezzi, ${withBrands} brand`);
    this.log(`Attributi: ${withCompat} compatibilità, ${withColor} colore, ${withRealStock} stock preciso`);
  }

  async run(maxPages = 20) {
    // 🆕 Acquisisci lock
    if (!await this.acquireLock()) {
      this.log('❌ Scraper già in corso, uscita');
      return;
    }
    
    try {
      const gracefulShutdown = async (signal) => {
        if (this.isShuttingDown) return;
        this.isShuttingDown = true;
        
        this.log(`\n⚠️ ${signal} ricevuto`);
        
        try {
          if (this.products.length > 0) {
            await this.saveCSV();
            this.log('✅ CSV salvato');
          }
          
          this.log('✅ Checkpoint mantenuto');
          await this.releaseLock(); // 🆕 Rilascia lock
          this.log('✅ Graceful shutdown');
          
          process.exit(0);
        } catch (err) {
          this.log(`❌ Errore shutdown: ${err.message}`);
          await this.releaseLock(); // 🆕 Rilascia lock anche su errore
          process.exit(1);
        }
      };
      
      process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
      process.on('SIGINT', () => gracefulShutdown('SIGINT'));
      
      const startUrl = `${this.baseUrl}/default.asp?cmdString=iphone&cmd=searchProd&bFormSearch=1`;
      
      await this.scrapeAll(startUrl, maxPages);
      await this.saveCSV();
      await this.clearCheckpoint();
      this.log('✅ Completato');
      
    } catch (err) {
      this.log(`❌ ERRORE: ${err.message}`);
      this.log(`Stack: ${err.stack}`);
      
      if (this.products.length > 0) {
        this.log('⚠️ Salvataggio parziale');
        await this.saveCSV();
        this.log('✅ CSV parziale salvato');
      }
      
      throw err;
    } finally {
      // 🆕 Rilascia sempre lock
      await this.releaseLock();
    }
  }
}

const maxPages = process.argv[2] ? parseInt(process.argv[2]) : 20;
new ScraperWPAIFinal().run(maxPages).catch(err => {
  console.error('[FATAL]:', err);
  process.exit(1);
});
