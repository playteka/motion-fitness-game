// 本地预览服务器（零依赖）。
// 用法：node preview-server.js  然后浏览器打开 http://127.0.0.1:4174
// 必须通过 http 打开：file:// 会拦截摄像头与 wasm 模型加载。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT || 4174);
const ROOT = path.dirname(fileURLToPath(import.meta.url));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  // 调试数据记录（页面「运动设定」里的「记录调试数据」开关）：
  // 页面把每一批采样（JSONL 文本）POST 到这里，服务端**追加**写进 logs/ 下的文件 ——
  // 这样真机测试完之后，日志就落在项目目录里，可以直接拿来分析「为什么没计上」。
  // 只监听 127.0.0.1，文件名也做了白名单校验（只允许 [A-Za-z0-9._-] + .jsonl）。
  if (req.method === 'POST' && req.url.startsWith('/__debug/log')) {
    let body = '';
    let tooBig = false;
    req.on('data', (c) => {
      body += c;
      if (body.length > 12 * 1024 * 1024) { tooBig = true; req.destroy(); }
    });
    req.on('end', () => {
      const send = (code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(obj));
      };
      if (tooBig) return send(413, { ok: false, error: 'too big' });
      let name = '';
      try {
        name = new URL(req.url, 'http://127.0.0.1').searchParams.get('file') || '';
      } catch { /* ignore */ }
      if (!/^[A-Za-z0-9._-]+\.jsonl$/.test(name)) return send(400, { ok: false, error: 'bad file name' });
      try {
        const dir = path.join(ROOT, 'logs');
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, name);
        if (!file.startsWith(dir)) return send(403, { ok: false, error: 'forbidden' });
        fs.appendFileSync(file, body);
        return send(200, { ok: true, file: `logs/${name}`, bytes: Buffer.byteLength(body) });
      } catch (err) {
        return send(500, { ok: false, error: String(err && err.message) });
      }
    });
    return;
  }

  // 已经记下来的日志文件列表（排查时方便看一眼「记了多少」）
  if (req.method === 'GET' && req.url.startsWith('/__debug/logs')) {
    try {
      const dir = path.join(ROOT, 'logs');
      const files = fs.existsSync(dir)
        ? fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => {
          const st = fs.statSync(path.join(dir, f));
          return { file: f, bytes: st.size, at: st.mtimeMs };
        })
        : [];
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, files }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: String(err && err.message) }));
    }
    return;
  }

  // 自检探针：页面用 ?probe=1 打开时会把运行时诊断 POST 到这里，
  // 便于在无头浏览器 / 无人值守场景下检查页面是否正常启动。
  if (req.method === 'POST' && req.url === '/__probe') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 200000) req.destroy(); });
    req.on('end', () => {
      try {
        const dir = path.join(ROOT, '_probe');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'last.json'), body);
      } catch { /* 忽略写入失败 */ }
      res.writeHead(204);
      res.end();
    });
    return;
  }

  let urlPath;
  try {
    urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  } catch {
    res.writeHead(400);
    res.end('Bad Request');
    return;
  }
  if (urlPath === '/' || urlPath === '') urlPath = '/index.html';

  const file = path.normalize(path.join(ROOT, urlPath));
  if (!file.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found: ' + urlPath);
      return;
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.wasm' || ext === '.task' ? 'public, max-age=86400' : 'no-store',
      'Cross-Origin-Opener-Policy': 'same-origin',
    });
    res.end(data);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`体感健身游戏预览地址： http://127.0.0.1:${PORT}`);
  console.log(`Motion Fitness is running at: http://127.0.0.1:${PORT}`);
  console.log('（用 Chrome / Edge 打开，首次点“开启摄像头”并允许权限）');
  console.log('(Open it in Chrome / Edge, click "Start camera" and allow the permission)');
});
