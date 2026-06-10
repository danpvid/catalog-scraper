/**
 * Script de diagnóstico - inspeciona a estrutura da página Colnect
 * e salva o HTML para análise.
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const HEADLESS = process.argv.includes('--headless') ? process.argv[process.argv.indexOf('--headless') + 1] !== 'false' : false;

async function main() {
  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
    locale: 'pt-BR',
  });
  const page = await context.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  const TARGET = 'https://colnect.com/pt/phonecards/companies/country/30-Brasil';
  console.log('Navegando para:', TARGET);
  await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Aguarda Anubis
  let waited = 0;
  while (waited < 60000) {
    const body = await page.textContent('body').catch(() => '');
    if (body.includes('Making sure') || body.includes('Calculating') || body.includes('not a bot')) {
      console.log('Aguardando Anubis... (' + waited + 'ms)');
      await page.waitForTimeout(3000);
      waited += 3000;
    } else {
      break;
    }
  }

  // Aguarda rede estabilizar
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2000);

  console.log('\n=== TÍTULO DA PÁGINA ===');
  console.log(await page.title());

  console.log('\n=== TODOS OS LINKS COM "phonecard" na URL ===');
  const allLinks = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('a[href]'))
      .map(a => ({ text: a.textContent.trim().substring(0, 60), href: a.href }))
      .filter(l => l.href.includes('phonecard'))
      .slice(0, 30);
  });
  allLinks.forEach(l => console.log(`  [${l.text}] => ${l.href}`));

  console.log('\n=== TODOS OS LINKS NA PÁGINA (primeiros 50) ===');
  const allLinksGeneral = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('a[href]'))
      .map(a => ({ text: a.textContent.trim().substring(0, 60), href: a.href }))
      .filter(l => l.href && !l.href.includes('javascript') && !l.href.includes('#'))
      .slice(0, 50);
  });
  allLinksGeneral.forEach(l => console.log(`  [${l.text}] => ${l.href}`));

  // Salvar HTML para inspeção
  const html = await page.content();
  const htmlPath = path.join(__dirname, '_diagnostico.html');
  fs.writeFileSync(htmlPath, html, 'utf8');
  console.log(`\nHTML salvo em: ${htmlPath} (${html.length} bytes)`);

  await browser.close();
}

main().catch(err => { console.error('ERRO:', err); process.exit(1); });
