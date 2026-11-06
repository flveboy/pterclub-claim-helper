/**
 * 测试环境依赖解析：puppeteer-core 与 Chrome 可执行文件。
 *
 * 三种来源，按优先级尝试：
 *   1. 环境变量 PUPPETEER_PATH / CHROME_PATH
 *   2. 项目内 node_modules（npm i）
 *   3. 常见系统安装位置 + Playwright 缓存目录
 *
 * 都找不到时抛错并给出提示，不静默失败。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

function loadPuppeteer() {
  const candidates = [
    process.env.PUPPETEER_PATH,
    'puppeteer-core',
    'puppeteer',
    // 本机 WorkBuddy 自带的 node_modules
    path.join(os.homedir(), '.workbuddy-ai/binaries/node/workspace/node_modules/puppeteer-core'),
  ].filter(Boolean);

  const errors = [];
  for (const c of candidates) {
    try {
      return require(c);
    } catch (e) {
      errors.push(`${c}: ${e.code || e.message}`);
    }
  }
  throw new Error(
    '找不到 puppeteer-core。请先执行 `npm install`，' +
      '或设置环境变量 PUPPETEER_PATH 指向 puppeteer-core 目录。\n尝试过：\n  ' +
      errors.join('\n  ')
  );
}

function globPlaywrightChrome() {
  const base = path.join(os.homedir(), 'Library/Caches/ms-playwright');
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(base);
  } catch (e) {
    return out;
  }
  for (const name of entries) {
    if (!/^chromium/.test(name)) continue;
    const dir = path.join(base, name);
    // chrome-headless-shell-<rev>/chrome-headless-shell-mac-arm64/chrome-headless-shell
    for (const sub of safeReaddir(dir)) {
      const p = path.join(dir, sub);
      for (const bin of ['chrome-headless-shell', 'Chromium', 'Google Chrome for Testing']) {
        const f = path.join(p, bin);
        if (fs.existsSync(f)) out.push(f);
      }
    }
  }
  return out;
}

function safeReaddir(d) {
  try {
    return fs.readdirSync(d);
  } catch (e) {
    return [];
  }
}

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    ...globPlaywrightChrome(),
  ].filter(Boolean);

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error(
    '找不到 Chrome/Chromium。请安装 Chrome，或设置环境变量 CHROME_PATH 指向可执行文件。'
  );
}

module.exports = { loadPuppeteer, findChrome };
