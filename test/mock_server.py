#!/usr/bin/env python3
"""模拟 pterclub 做种列表（真实 DOM 结构），用于验证油猴脚本。仅本地测试用。

真实结构要点（取自用户导出的页面源码）：
  - 认领按钮  <a href='#' data-url='viewclaims.php?in_modal=yes&do_ajax=1&add_torrent_id=ID' class='claim-confirm'>认领种子</a>
  - 取消认领  ...del_torrent_id=ID ... class='remove-confirm'
  - 表头大小列是图标 <img class="size" alt="size" title="大小">
  - 体积单元格 9.63<br />GB（textContent 拼成 9.63GB）
  - 页面标题含「共 128 个」
  - 头部导航里有 details.php?id=617936 与 userdetails.php?id=27313（干扰项）
"""
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs

PORT = int(os.environ.get("MOCK_PORT", "18865"))
USER_ID = "27313"
PER_PAGE = 100
TOTAL = 130
CLAIMED = {0, 5, 11, 23, 37, 41, 58, 66, 79, 88, 99, 105}   # 按序号（0-based）标记已认领
SIZES = ["4.35 GB", "18.72 GB", "62.4 MB", "1.28 GB", "96.5 MB",
         "100.0 MB", "2.10 GB", "8.03 GB", "700 MB", "30 MB", "5.5 GB", "0.00 KB"]

FLAGS = {"block": False}
LOCK = threading.Lock()
REQUESTS = []
CLAIM_STATE = {}          # id -> bool


def seed_ids():
    return [10000 + i for i in range(TOTAL)]


def init_state():
    CLAIM_STATE.clear()
    for i, tid in enumerate(seed_ids()):
        CLAIM_STATE[tid] = i in CLAIMED


def size_of(i):
    return SIZES[i % len(SIZES)]


def is_claimed(tid):
    return CLAIM_STATE.get(tid, False)


def row_html(i, tid):
    claimed = is_claimed(tid)
    if claimed:
        op = (f"<a href='#' data-url='viewclaims.php?in_modal=yes&amp;do_ajax=1&amp;"
              f"del_torrent_id={tid}' class='remove-confirm' ><b><font color=red>取消认领</font></b></a>")
    else:
        op = (f"<a href='#' data-url='viewclaims.php?in_modal=yes&amp;do_ajax=1&amp;"
              f"add_torrent_id={tid}' class='claim-confirm' >认领种子</a>")
    num, unit = size_of(i).split(" ")
    return f"""<tr>
<td class="rowfollow nowrap" valign="middle"><a href="torrents.php?allsec=1&amp;cat=401"><img class="c_movies" src="data:," alt="电影" /></a></td>
<td class="rowfollow" width="100%" align="left">
<a href="details.php?id={tid}" title="Torrent {tid}"><b>Torrent Title {tid} 1080p WEB-DL</b></a><br />副标题 {tid} | 类型:剧情</td><td class="rowfollow" align="center">{op}</td><td class="rowfollow" align="center">{num}<br />{unit}</td><td class="rowfollow" align="center">12</td><td class="rowfollow" align="center">0</td><td class="rowfollow" align="center">0.00<br />KB</td><td class="rowfollow" align="center">0.00<br />KB</td><td class="rowfollow" align="center">---</td></tr>"""


def page_html(page):
    start = page * PER_PAGE
    ids = seed_ids()[start:start + PER_PAGE]
    rows = "\n".join(row_html(start + k, tid) for k, tid in enumerate(ids))

    # 分页链接：当前页不出现自己（跟真实页面一致）
    pager = []
    total_pages = (TOTAL + PER_PAGE - 1) // PER_PAGE
    for p in range(total_pages):
        if p == page:
            continue
        a = p * PER_PAGE + 1
        b = min((p + 1) * PER_PAGE, TOTAL)
        pager.append(f'<a class="np-pager-link" href="?userid={USER_ID}&amp;type=seeding&amp;page={p}">{a}&nbsp;-&nbsp;{b}</a>')
    pager_html = "<p>" + " | ".join(pager) + "</p>" if pager else ""

    return f"""<!DOCTYPE html><html><head><meta charset="utf-8"><title>做种列表</title>
<style>body{{background:#12161f;color:#c8d3e4;font:13px/1.6 sans-serif;margin:20px}}
table{{border-collapse:collapse;width:100%}}td{{border:1px solid #2a3242;padding:5px 8px}}
.colhead{{background:#1d2432;color:#8fa3bd;font-weight:600}}
a{{color:#5aa9e6}}img{{width:14px;height:14px;display:inline-block;background:#333}}</style>
</head><body>
<div>欢迎回来, <a href="userdetails.php?id={USER_ID}" class='PowerUser_Name'><b>loongx</b></a>
[<a href="#">退出</a>] [<a href="viewclaims.php">已认领种子</a>] 常用种子 <a href="details.php?id=617936">快捷入口</a></div>
<h2>loongx 正在做种的种子 (共 {TOTAL} 个)</h2>
{pager_html}
<table border="1" cellspacing="0" cellpadding="5" width="100%">
<tr>
<td class="colhead" style="padding: 0px">类型</td>
<td class="colhead" align="center">标题</td><td class="colhead" align="center">种子认领</td>
<td class="colhead" align="center"><img class="size" src="data:," alt="size" title="大小" /></td>
<td class="colhead" align="center"><img class="seeders" src="data:," alt="seeders" title="种子数" /></td>
<td class="colhead" align="center"><img class="leechers" src="data:," alt="leechers" title="下载数" /></td>
<td class="colhead" align="center">上传</td><td class="colhead" align="center">下载</td>
<td class="colhead" align="center">分享率</td></tr>
{rows}
</table></body></html>"""


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, body, ctype="text/html; charset=utf-8"):
        data = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)

        if u.path == "/getusertorrentlist.php":
            # 模拟 WAF：拦 fetch（Sec-Fetch-Mode: cors），放行 iframe 导航（navigate）
            if FLAGS["block"] and self.headers.get("Sec-Fetch-Mode") == "cors":
                return self._send(403, "Forbidden: 0x2A7E1F29B9", "text/plain; charset=utf-8")
            page = int(q.get("page", ["0"])[0])
            return self._send(200, page_html(page))

        if u.path == "/details.php":
            tid = int(q.get("id", ["0"])[0])
            i = tid - 10000
            return self._send(200, f"""<html><body><table>
<tr><td class="rowhead">大小</td><td>{size_of(i)}</td></tr>
<tr><td class="rowhead">类型</td><td>电影</td></tr></table></body></html>""")

        if u.path == "/viewclaims.php":
            action = None
            tid = None
            if "add_torrent_id" in q:
                action, tid = "add", int(q["add_torrent_id"][0])
            elif "del_torrent_id" in q:
                action, tid = "del", int(q["del_torrent_id"][0])
            if not action:
                return self._send(200, json.dumps({"ret": 1, "msg": "缺少参数"}))
            with LOCK:
                REQUESTS.append({"action": action, "id": tid})
                if action == "add":
                    if CLAIM_STATE.get(tid):
                        return self._send(200, json.dumps({"ret": 1, "msg": "该种子已经被认领"}))
                    CLAIM_STATE[tid] = True
                else:
                    if not CLAIM_STATE.get(tid):
                        return self._send(200, json.dumps({"ret": 1, "msg": "该种子尚未认领"}))
                    CLAIM_STATE[tid] = False
            return self._send(200, json.dumps({"ret": 0, "msg": ""}))

        if u.path == "/__requests":
            with LOCK:
                return self._send(200, json.dumps(REQUESTS), "application/json")

        if u.path == "/__blockfetch":
            FLAGS["block"] = q.get("on", ["0"])[0] == "1"
            return self._send(200, "ok")

        if u.path == "/__reset":
            with LOCK:
                REQUESTS.clear()
                init_state()
            return self._send(200, "ok")

        if u.path == "/__expected":
            out = []
            for i, tid in enumerate(seed_ids()):
                num, unit = size_of(i).split(" ")
                mult = {"KB": 1024, "MB": 1024 ** 2, "GB": 1024 ** 3}[unit]
                out.append({"id": tid, "size": float(num) * mult, "claimed": i in CLAIMED})
            return self._send(200, json.dumps(out), "application/json")

        return self._send(404, "not found")

    def do_POST(self):
        return self._send(404, "not found")


if __name__ == "__main__":
    init_state()
    srv = HTTPServer(("127.0.0.1", PORT), Handler)
    print(f"mock server on http://127.0.0.1:{PORT}")
    srv.serve_forever()
