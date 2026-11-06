# 本地测试环境

不依赖真实站点，用一个 NexusPHP 风格的 mock 页面跑完整流程。

## 跑起来

```bash
# 在仓库根目录
npm install          # 只装 puppeteer-core
npm run mock         # 起 mock 服务，默认 127.0.0.1:18865

# 另开终端
npm run test         # 20 项断言
npm run shots        # 生成 test/shots/*.png
```

环境变量：

| 变量 | 作用 | 默认 |
| --- | --- | --- |
| `MOCK_PORT` | mock 服务端口 | `18865` |
| `MOCK_BASE` | 测试脚本访问的 base URL | `http://127.0.0.1:18865` |
| `CHROME_PATH` | Chrome / Chromium 可执行文件 | 自动查找（系统安装 + Playwright 缓存） |
| `PUPPETEER_PATH` | puppeteer-core 模块路径 | `node_modules` → 系统路径 |

## 文件说明

| 文件 | 作用 |
| --- | --- |
| `mock_server.py` | 模拟做种列表页 + 认领接口。刻意还原真实页面的坑（导航干扰行、图标表头、体积边界、WAF 拦截） |
| `run_test.js` | 主测试。注入脚本 → 点击 → 断言请求序列和 DOM 变化 |
| `shot.js` | 生成文档用截图 |
| `analyze.js` | 分析真实页面结构的辅助脚本（需要先准备一份 HTML） |
| `_env.js` | 解析 puppeteer-core 与 Chrome 路径 |

## mock 的控制接口

| 路径 | 作用 |
| --- | --- |
| `GET /__requests` | 返回收到的认领请求列表（JSON） |
| `GET /__reset` | 清空请求记录与认领状态 |
| `GET /__blockfetch?on=1` | 打开 WAF 模拟：对 `Sec-Fetch-Mode: cors` 的请求返回 403，放行 iframe 导航 |

## mock 数据

- 130 个种子，每页 100 条，共 2 页
- 12 个已认领（序号 0/5/11/23/37/41/58/66/79/88/99/105）
- 体积循环取：`4.35 GB / 18.72 GB / 62.4 MB / 1.28 GB / 96.5 MB / 100.0 MB / 2.10 GB / 8.03 GB / 700 MB / 30 MB / 5.5 GB / 0.00 KB`

其中 `100.0 MB` 是边界值，按「严格大于 100MB」的规则**不应该**被认领。
