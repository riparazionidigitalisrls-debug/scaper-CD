// scraper_componenti_enterprise.js
// Versione Enterprise per 4000+ prodotti con checkpoint e batch processing
// Compatibile con struttura esistente, ottimizzato per Render Standard

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
    this.csvMinPath = path.join(this.outputDir, 'prodotti_wpimport_min.csv'); // Retrocompatibilità
    this.logPath = path.join(this.outputDir, `scraper_${timestamp}.log`);
    
    // URL base per immagini
    this.imagesHostBaseUrl = process.env.IMAGES_BASE_URL || 'https://scraper-componenti.onrender.com/images';
    
    // Settings per alti volumi
    this.batchSize = 10; // Pagine per batch
    this.pauseBetweenBatches = 30000; // 30 secondi tra batch
    this.pauseBetweenPages = 2000; // 2 secondi tra pagine
    this.maxRetries = 3;
    this.pageTimeout = 45000; // 45 secondi timeout
    
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
    
    this.ensureDirs();
    this.initCsvWriter();
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

  async scrapePage(page, url, retries = 0) {
    try {
      this.log(`Scraping pagina: ${url} (tentativo ${retries + 1})`);
      
      await page.goto(url, { 
        waitUntil: 'networkidle', 
        timeout: this.pageTimeout 
      });
      
      // Wait e scroll per caricare contenuti lazy
      await page.waitForTimeout(1000 + Math.random() * 1000);
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(800);

      const items = await page.evaluate(() => {
        const nodes = document.querySelectorAll('div[class*="prod"]');
        const out = [];
        
        nodes.forEach((el, i) => {
          const txt = el.textContent || '';
          
          // ESTRAZIONE NOME
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
            const heading = el.querySelector('h2, h3, h4, .product-title, .prod-title');
            if (heading) {
              name = heading.textContent.trim();
            }
          }
          
          // ESTRAZIONE SKU
          let sku = '';
          const skuMatch = txt.match(/(?:cod\.?\s*art\.?|sku|codice)[:.]?\s*([A-Z0-9\-_]+)/i) ||
                          txt.match(/\b(\d{5,6})\b/);
          if (skuMatch) {
            sku = skuMatch[1].trim();
          }
          if (!sku) {
            sku = `AUTO_${Date.now()}_${i}`;
          }
          
          // ESTRAZIONE PREZZO - Prende l'ULTIMO (finale con IVA)
          let price = '';
          const priceRegex = /€\s*(\d+(?:[,.]\d{1,2})?)/g;
          const pricesFound = [];
          let match;
          while ((match = priceRegex.exec(txt)) !== null) {
            if (match[1]) {
              pricesFound.push(match[1].replace(',', '.'));
            }
          }
          
          if (pricesFound.length > 0) {
            // L'ultimo prezzo è quello finale IVA inclusa
            price = pricesFound[pricesFound.length - 1];
          } else {
            // Fallback
            const altMatch = txt.match(/EUR\s*(\d+(?:[,.]\d{1,2})?)/i) ||
                            txt.match(/prezzo[:.]?\s*(\d+(?:[,.]\d{1,2})?)/i);
            if (altMatch) {
              price = altMatch[1].replace(',', '.');
            }
          }
          
          // ESTRAZIONE STOCK REALE
          let stockQty = 1;
          const qtyMatch = txt.match(/[Dd]isponibile\s*\(?\s*(\d+)\s*PZ?\s*\)?/i);
          if (qtyMatch) {
            stockQty = parseInt(qtyMatch[1]);
          } else if (/non\s+disponibile|esaurito|sold\s*out/i.test(txt)) {
            stockQty = 0;
          } else if (/disponibile|available|in\s*stock/i.test(txt)) {
            stockQty = 10; // Valore prudente invece di 999
          }
          
          // IMMAGINE
          const img = el.querySelector('img[src*="Foto"], img[src*="foto"], img[src*=".jpg"], img[src*=".JPG"]');
          const imageUrl = img ? (img.src || img.getAttribute('src')) : '';
          
          // BRAND
          let brand = '';
          const knownBrands = ['Apple', 'Samsung', 'Huawei', 'Xiaomi', 'LG', 'Sony', 
                              'Nokia', 'Motorola', 'JCID', 'Mechanic', 'Sunshine', 'Qianli'];
          for (const b of knownBrands) {
            if (new RegExp(`\\b${b}\\b`, 'i').test(txt)) {
              brand = b;
              break;
            }
          }
          
          // QUALITY
          let quality = '';
          if (/originale/i.test(txt)) quality = 'Originale';
          else if (/premium|alta\s+qualit/i.test(txt)) quality = 'Premium';
          else if (/compatibile/i.test(txt)) quality = 'Compatibile';
          
          // COMPATIBILITÀ
          let compatibility = '';
          const compatMatch = txt.match(/(?:per|compatibile|for)\s+(iPhone\s+[^\s,€\n]+)/i);
          if (compatMatch) {
            compatibility = compatMatch[1].trim();
          }
          
          // COLORE
          let color = '';
          const colorMatch = txt.match(/(?:colore|color)[:.]?\s*([A-Za-z]+|nero|bianco|rosso|blu)/i);
          if (colorMatch) {
            color = colorMatch[1].trim();
          }
          
          // PULIZIA NOME
          if (name.includes(sku)) {
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
            stock_quantity: stockQty,
            image_url: imageUrl,
            brand: brand.substring(0, 50),
            quality: quality.substring(0, 30),
            compatibility: compatibility.substring(0, 100),
            color: color.substring(0, 30)
          });
        });
        
        return out;
      });

      this.stats.productsFound += items.length;
      this.log(`Trovati ${items.length} prodotti in questa pagina`);

      // Processa prodotti trovati
      for (const p of items) {
        if (this.seen.has(p.sku)) continue;
        this.seen.add(p.sku);

        // Download immagine
        let imagesField = '';
        if (p.image_url) {
          const filename = this.getImageFilename(p.sku);
          if (await this.downloadImageCandidates(p.image_url, filename)) {
            imagesField = `${this.imagesHostBaseUrl}/${filename}`;
          }
        }

        // Tags intelligenti
        let tags = '';
        if (p.compatibility) {
          tags = `compatible-${p.compatibility.toLowerCase().replace(/\s+/g, '-')}`;
        }
        if (p.brand) {
          tags = tags ? `${tags},${p.brand.toLowerCase()}` : p.brand.toLowerCase();
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
          categories: 'Componenti iPhone',
          tags: tags.substring(0, 100),
          short_description: shortDesc.substring(0, 150),
          product_type: 'simple',
          brand: this.cleanText(p.brand),
          quality: this.cleanText(p.quality),
          packaging: 'Standard',
          'attribute:pa_colore': this.cleanText(p.color),
          'attribute:pa_modello': '',
          'attribute:pa_compatibilita': this.cleanText(p.compatibility)
        });
      }

      // Trova URL pagina successiva
      const nextUrl = await page.evaluate(() => {
        const href = window.location.href;
        const m = href.match(/pg=(\d+)/);
        const curr = m ? parseInt(m[1]) : 1;
        const next = curr + 1;
        
        // Cerca link alla pagina successiva
        const link = Array.from(document.querySelectorAll('a[href*="pg="]')).find(a => {
          const mm = a.href.match(/pg=(\d+)/);
          return mm && parseInt(mm[1]) === next;
        });
        
        if (link) return link.href;
        
        // Se non trova link ma non siamo al limite, costruisci URL
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

  async scrapeAll(startUrl, maxPages = 200) {
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
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        viewport: { width: 1920, height: 1080 }
      });
      
      const page = await context.newPage();
      
      const version = await browser.version();
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
      while (url && currentPage <= maxPages) {
        this.log(`\n=== PAGINA ${currentPage}/${maxPages} ===`);
        
        const nextUrl = await this.scrapePage(page, url);
        
        // Salva checkpoint ogni 5 pagine
        if (currentPage % 5 === 0) {
          await this.saveCheckpoint(currentPage, maxPages);
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
          // Pausa random tra pagine
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
      await browser.close();
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
      
      // Crea anche copia con nome legacy per retrocompatibilità
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
    
    // Report prodotti per attributo
    const withPrices = this.products.filter(p => p.regular_price).length;
    const withBrands = this.products.filter(p => p.brand).length;
    const withCompat = this.products.filter(p => p['attribute:pa_compatibilita']).length;
    const inStock = this.products.filter(p => p.stock_quantity > 0).length;
    
    this.log(`Prodotti con prezzo: ${withPrices}`);
    this.log(`Prodotti con brand: ${withBrands}`);
    this.log(`Prodotti con compatibilità: ${withCompat}`);
    this.log(`Prodotti disponibili: ${inStock}`);
    
    // Alert se risultati anomali
    if (this.products.length < 3000 && this.stats.pagesScraped > 150) {
      this.log(`ATTENZIONE: Solo ${this.products.length} prodotti su ${this.stats.pagesScraped} pagine!`, 'ERROR');
    }
    
    if (this.errors.length > 0) {
      this.log(`Pagine con errori: ${JSON.stringify(this.errors)}`, 'WARN');
    }
  }

  async cleanup() {
    // Elimina checkpoint dopo successo
    await this.deleteCheckpoint();

    // Mantieni solo ultimi 7 CSV
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
      this.log('║   SCRAPER ENTERPRISE - AVVIO          ║');
      this.log('╚════════════════════════════════════════╝');
      this.log(`Target: ${maxPages} pagine massime`);
      this.log(`Batch size: ${this.batchSize} pagine`);
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
        await this.saveCSV();
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