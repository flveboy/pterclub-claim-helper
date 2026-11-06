const fs = require('fs');
const path = require('path');
const { loadPuppeteer, findChrome } = require('./_env');

const puppeteer = loadPuppeteer();
const CHROME = findChrome();
const SCRIPT = fs.readFileSync(path.join(__dirname, '..', 'pterclub-claim-helper.user.js'), 'utf8');
const BASE = process.env.MOCK_BASE || 'http://127.0.0.1:18865';
const OUT = path.join(__dirname, 'shots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: true,
    args: ['--no-sandbox'],
    defaultViewport: { width: 1280, height: 820, deviceScaleFactor: 2 },
  });

  const page = await browser.newPage();
  page.on('dialog', async (d) => { await d.accept(); });
  await fetch(`${BASE}/__reset`);
  await page.goto(`${BASE}/getusertorrentlist.php?userid=27313&type=seeding`, { waitUntil: 'domcontentloaded' });
  await page.addScriptTag({ content: SCRIPT });
  await page.waitForFunction(
    () => /扫描完成：/.test(document.querySelector('#ptc-log').textContent),
    { timeout: 30000 }
  );
  await sleep(500);
  await page.screenshot({ path: path.join(OUT, '1-idle.png') });

  await page.click('#ptc-multi');
  await sleep(300);
  await page.evaluate(() => {
    const cbs = [...document.querySelectorAll('.ptc-pick input')];
    [1, 2, 4].forEach((i) => cbs[i].click());
  });
  await sleep(200);
  await page.screenshot({ path: path.join(OUT, '2-multi.png') });

  await page.click('#ptc-multi');
  await sleep(300);
  await page.click('#ptc-claim');
  await sleep(3000);
  await page.screenshot({ path: path.join(OUT, '3-running.png') });

  await page.waitForFunction(
    () => /成功 \d+ · 跳过 \d+/.test(document.querySelector('#ptc-log').textContent),
    { timeout: 120000 }
  );
  await sleep(500);
  await page.screenshot({ path: path.join(OUT, '4-done.png') });

  await browser.close();
  console.log('shots done');
})().catch((e) => { console.error(e); process.exit(1); });
