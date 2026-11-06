const fs = require('fs');
const path = require('path');
const { loadPuppeteer, findChrome } = require('./_env');

const puppeteer = loadPuppeteer();
const CHROME = findChrome();
const SCRIPT = fs.readFileSync(path.join(__dirname, '..', 'pterclub-claim-helper.user.js'), 'utf8');
const BASE = process.env.MOCK_BASE || 'http://127.0.0.1:18865';
const MB = 1024 * 1024;

const results = [];
function check(name, cond, extra) {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra !== undefined ? '  -> ' + extra : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function open(browser, url) {
  const page = await browser.newPage();
  page.on('dialog', async (d) => { await d.accept(); });
  page.on('pageerror', (e) => console.log('PAGE ERROR:', e.message));
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.addScriptTag({ content: SCRIPT });
  await sleep(300);
  return page;
}

const reqs = async (page) => page.evaluate(async () => (await fetch('/__requests')).json());

async function waitDone(page, timeout = 90000) {
  await page.waitForFunction(
    () => /成功 \d+ · 跳过 \d+/.test(document.querySelector('#ptc-log').textContent),
    { timeout }
  );
  await sleep(300);
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    defaultViewport: { width: 1280, height: 900, deviceScaleFactor: 2 },
  });

  /* ================= 场景 1：第一页基础解析 ================= */
  await fetch(`${BASE}/__reset`);
  let page = await open(browser, `${BASE}/getusertorrentlist.php?userid=27313&type=seeding`);

  check('面板已注入', !!(await page.$('#ptc-panel')));

  await page.waitForFunction(
    () => /扫描完成：/.test(document.querySelector('#ptc-log').textContent),
    { timeout: 30000 }
  );
  await sleep(300);

  const stat = await page.$eval('#ptc-stat', (e) => e.textContent.replace(/\s+/g, ' ').trim());
  check('全站 130 个 · 2 页', /全站\s*130\s*个\s*·\s*2\s*页/.test(stat), stat);
  check('已认领 12', /已认领\s*12/.test(stat), stat);
  check('体积未知 0（不再误读上传量）', !/体积未知/.test(stat), stat);

  const parsed = await page.evaluate(() =>
    document.querySelectorAll('tr a.claim-confirm, tr a.remove-confirm').length);
  check('当前页认领按钮 100 个', parsed === 100, parsed);

  const exp = await (await fetch(`${BASE}/__expected`)).json();
  const expectAdd = exp.filter((r) => !r.claimed && r.size > 100 * MB).map((r) => String(r.id)).sort();
  const expectDel = exp.filter((r) => r.claimed).map((r) => String(r.id)).sort();
  console.log(`   期望认领 ${expectAdd.length} 个，期望取消 ${expectDel.length} 个`);

  /* ================= 场景 2：一键认领（跨页） ================= */
  await page.click('#ptc-claim');
  await waitDone(page);
  let r = await reqs(page);
  let addIds = r.filter((x) => x.action === 'add').map((x) => String(x.id)).sort();
  check('认领请求 = 期望集合（跨两页）', JSON.stringify(addIds) === JSON.stringify(expectAdd),
    `${addIds.length} vs ${expectAdd.length}`);
  check('已认领的没被重复请求', !addIds.some((id) => expectDel.includes(id)));
  const log1 = await page.$eval('#ptc-log', (e) => e.innerText);
  check('日志统计成功数正确', new RegExp(`成功 ${expectAdd.length}`).test(log1), log1.split('\n').pop());

  const flip = await page.evaluate(() => {
    const tr = [...document.querySelectorAll('tr')].find((t) => t.querySelector('a[href*="details.php?id=10001"]'));
    if (!tr) return 'no-row';
    return tr.querySelector('a.remove-confirm') ? 'del' : (tr.querySelector('a.claim-confirm') ? 'add' : '?');
  });
  check('认领后行内按钮翻成「取消认领」', flip === 'del', flip);
  await page.close();

  /* ================= 场景 3：一键取消（跨页） ================= */
  await fetch(`${BASE}/__reset`);
  page = await open(browser, `${BASE}/getusertorrentlist.php?userid=27313&type=seeding`);
  await page.waitForFunction(
    () => /扫描完成：/.test(document.querySelector('#ptc-log').textContent),
    { timeout: 30000 }
  );
  await page.click('#ptc-unclaim');
  await waitDone(page);
  r = await reqs(page);
  const delIds = r.filter((x) => x.action === 'del').map((x) => String(x.id)).sort();
  check('取消认领请求 = 全部 12 个已认领', JSON.stringify(delIds) === JSON.stringify(expectDel),
    `${delIds.length} vs ${expectDel.length}`);
  await page.close();

  /* ================= 场景 4：第二页 ================= */
  await fetch(`${BASE}/__reset`);
  page = await open(browser, `${BASE}/getusertorrentlist.php?userid=27313&type=seeding&page=1`);
  await page.waitForFunction(
    () => /扫描完成：/.test(document.querySelector('#ptc-log').textContent),
    { timeout: 30000 }
  );
  await sleep(300);
  const stat2 = await page.$eval('#ptc-stat', (e) => e.textContent.replace(/\s+/g, ' ').trim());
  check('第二页也识别全站 130 个 · 2 页', /全站\s*130\s*个\s*·\s*2\s*页/.test(stat2), stat2);
  const btnCount = await page.evaluate(() =>
    document.querySelectorAll('tr a.claim-confirm, tr a.remove-confirm').length);
  check('第二页 30 个种子', btnCount === 30, btnCount);
  await page.close();

  /* ================= 场景 4b：fetch 被 WAF 拦截 → iframe 兜底 ================= */
  await fetch(`${BASE}/__reset`);
  await fetch(`${BASE}/__blockfetch?on=1`);
  page = await open(browser, `${BASE}/getusertorrentlist.php?userid=27313&type=seeding`);
  await page.waitForFunction(
    () => /扫描完成：/.test(document.querySelector('#ptc-log').textContent),
    { timeout: 40000 }
  );
  await sleep(500);
  const stat3 = await page.$eval('#ptc-stat', (e) => e.textContent.replace(/\s+/g, ' ').trim());
  const log3 = await page.$eval('#ptc-log', (e) => e.innerText);
  check('WAF 拦截时 iframe 兜底仍读到 130 个', /全站\s*130\s*个/.test(stat3) && !/已读/.test(stat3), stat3);
  check('日志里出现 iframe 重试提示', /改用 iframe 重试/.test(log3), log3.split('\n').filter((l) => /iframe/.test(l))[0] || '(无)');
  await page.close();
  await fetch(`${BASE}/__blockfetch?on=0`);

  /* ================= 场景 5：多选（只本页） ================= */
  await fetch(`${BASE}/__reset`);
  page = await open(browser, `${BASE}/getusertorrentlist.php?userid=27313&type=seeding`);
  await page.click('#ptc-multi');
  await sleep(300);
  const cbCount = await page.$$eval('.ptc-pick input', (els) => els.length);
  check('多选：本页 100 个勾选框', cbCount === 100, cbCount);
  const headCells = await page.$$eval('table tr:first-child td', (els) => els.length);
  check('多选：表头同步插入列', headCells === 10, headCells);

  await page.evaluate(() => {
    const cbs = [...document.querySelectorAll('.ptc-pick input')];
    [1, 2, 3].forEach((i) => cbs[i].click());
  });
  const picked = await page.$$eval('tr.ptc-picked', (e) => e.length);
  check('多选：勾选 3 行高亮', picked === 3, picked);

  await page.click('#ptc-pick-claim');
  await waitDone(page);
  r = await reqs(page);
  const pickIds = r.filter((x) => x.action === 'add').map((x) => String(x.id)).sort();
  check('多选认领：只处理勾选的 3 个', pickIds.length === 3, pickIds.join(','));

  await page.click('#ptc-multi');
  await sleep(300);
  const cbAfter = await page.$$eval('.ptc-pick input', (els) => els.length);
  const headAfter = await page.$$eval('table tr:first-child td', (els) => els.length);
  check('退出多选：勾选框已清理', cbAfter === 0, cbAfter);
  check('退出多选：表头列已还原', headAfter === 9, headAfter);
  await page.close();

  await browser.close();
  const failed = results.filter((x) => !x.ok);
  console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
