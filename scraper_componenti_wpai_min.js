// scraper_componenti_wpai_min.js
// Versione minimale per WP All Import - VERSIONE PULITA (Render-ready)
// Esporta SOLO: SKU, Name, Regular price, Stock quantity, Images, Brand, Quality, Packaging
// Fix: niente executablePath hard-coded; CSV atomico; log versione Chromium; IMAGES_BASE_URL opzionale

const { chromium } = require('playwright');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const https = require('https');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;

class ScraperWPAIMin {
  constructor() {
    this.baseUrl = 'https://www.componentidigitali.com';

    // Su Render usa /data, altrimenti ./data
    const dataDir = process.env.DATA_DIR || (process.env.RENDER ? '/data' : './data');
    this.outputDir = path.join(dataDir, 'output');
    this.imagesDir = path.join(this.outputDir, 'images');

    // CSV atomico: scriviamo su tmp e poi rename
    this.csvFinalPath = path.join(this.outputDir, 'prodotti_latest.csv');
    this.csvTmpPath   = path.join(this.outputDir, 'prodotti_latest.tmp.csv');
    this.logPath      = path.join(this.outputDir, 'scraper.log');

    // Se vuoi URL assoluti per le immagini (es. https://scraper.../images/)
    // imposta IMAGES_BASE_URL nell'ambiente; altrimenti usiamo un path relativo "images/filename.jpg"
    this.imagesHostBaseUrl = process.env.IMAGES_BASE_URL || '';

    this.ensureDirs();
    this.csvWriter = createCsvWriter({
      path: this.csvTmpPath, // scriviamo su tmp
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

  getImageFilename(sku) {
    const cleanSku = String(sku || '').replace(/[^a-zA-Z0-9]/g, '_');
    return `${cleanSku}.jpg;
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
          fs.unlink(filepath, ()=>{}); 
          resolve(false); 
        }
      }).on('error', () => { 
        file.close(); 
        fs.unlink(filepath, ()=>{}); 
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
      await page.waitForTimeout(800);
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(600);

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
          const priceMatches = [
            txt.match(/€\s*(\d+(?:[,.]\d{1,2})?)/),
            txt.match(/(\d+(?:[,.]\d{1,2})?)\s*€/),
            txt.match(/EUR\s*(\d+(?:[,.]\d{1,2})?)/i),
            txt.match(/prezzo[:.]?\s*(\d+(?:[,.]\d{1,2})?)/i)
          ];
         
          for (const match of priceMatches) {
            if (match) {
              price = match[1].replace(',', '.'); break;
            }
          }

          let stockQty = 1;
          if (/non\s+disponibile|esaurito|sold\s*out/i.test(txt)) {
            stockQty = 0;
          } else if (/disponibile|available|in\s*stock/i.test(txt)) {
            stockQty = 999;
          } else {
            const qtyMatch = txt.match(/(?:pezzi|qty|quantità)[:.]?\s*(\d+)/i);
            if (qtyMatch) stockQty = parseInt(qtyMatch[1]);
          }

          const img = el.querySelector('img[src*="Foto"], img[src*="foto"], img[src*=".jpg"], img[src*=".JPG"], img[src*=".png"]');
          const imageUrl = img ? (img.src || img.getAttribute('src')) : '';

          let brand = '';
          const brandMatch = txt.match(/(?:marca|brand|marchio)[:.]?\s*([A-Z][A-Za-z0-9\s&\-]+)/i);
          if (brandMatch) brand = brandMatch[1].trim().split(/[\n\r]/)[0];

          let quality = '';
          const qualityMatch = txt.match(/(?:qualità|quality)[:.]?\s*(\w+)/i);
          if (qualityMatch) quality = qualityMatch[1].trim();

          let packaging = '';
          const packMatch = txt.match(/(?:confezione|packaging|package)[:.]?\s*([^\n\r€]{3,50})/i);
          if (packMatch) packaging = packMatch[1].trim();

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
            stock_quantity: stockQty,
            image_url: imageUrl,
            brand: brand.substring(0, 50),
            quality: quality.substring(0, 30),
            packaging: packaging.substring(0, 100)
          });
        });
       
        return out;
      });

      if (items.length > 0) {
        this.log(`Trovati ${items.length} prodotti. Esempio: SKU=${items[0].sku}, Name="${items[0].name}"`);
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

        this.products.push({
          sku: this.cleanText(p.sku),
          name: this.cleanText(p.name),
          regular_price: p.regular_price,
          stock_quantity: p.stock_quantity,
          stock_status: p.stock_quantity > 0 ? 'instock' : 'outofstock',
          images: imagesField,
          categories: 'Componenti',
          tags: '',
          short_description: `${p.name} - ${p.brand}`.substring(0, 150),
          product_type: 'simple',
          brand: this.cleanText(p.brand),
          quality: this.cleanText(p.quality),
          packaging: this.cleanText(p.packaging),
          'attribute:pa_colore': '',
          'attribute:pa_modello': '',
          'attribute:pa_compatibilita': ''
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

  async scrapeAll(startUrl, maxPages=20) {
    // NESSUN executablePath: Playwright userà quello di sistema (o ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH)
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
   
      while (url && n < maxPages) {
        n++;
        this.log(`=== PAGINA ${n}/${maxPages} ===`);
        const next = await this.scrapePage(page, url);
        if (next && next !== url) {
          url = next;
          await page.waitForTimeout(1000 + Math.random() * 1000);
        } else {
          this.log('Fine paginazione o limite raggiunto');
          break;
        }
      }

      this.log(`COMPLETATO: ${n} pagine, ${this.products.length} prodotti unici`);
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
    // rename atomico
    try {
      await fsp.rename(this.csvTmpPath, this.csvFinalPath);
    } catch (err) {
      // fallback: copia e cancella
      await fsp.copyFile(this.csvTmpPath, this.csvFinalPath).catch(()=>{});
      await fsp.unlink(this.csvTmpPath).catch(()=>{});
    }
    this.log(`CSV salvato: ${this.csvFinalPath} (${this.products.length} righe)`);
   
    const withNames = this.products.filter(p => p.name && p.name !== 'Prodotto').length;
    const withPrices = this.products.filter(p => p.regular_price).length;
    const withBrands = this.products.filter(p => p.brand).length;
    this.log(`Statistiche: ${withNames} con nome valido, ${withPrices} con prezzo, ${withBrands} con brand`);
  }

  async run(maxPages=20) {
    const startUrl = `${this.baseUrl}/default.asp?cmdString=iphone&cmd=searchProd&bFormSearch=1`;
    await this.scrapeAll(startUrl, maxPages);
    await this.saveCSV();
  }
}

const maxPages = process.argv[2] ? parseInt(process.argv[2]) : 20;
new ScraperWPAIMin().run(maxPages).catch(err => {
  console.error('[SCRAPER FATAL]:', err);
  process.exit(1);
});
