// 本地预览服务器（零依赖）。
// 用法：node preview-server.js  然后浏览器打开 http://127.0.0.1:4174
// 必须通过 http 打开：file:// 会拦截摄像头与 wasm 模型加载。
//
// 手机要用摄像头**必须走 https**（浏览器只在 secure context 下给 getUserMedia）：
//   $env:HOST='0.0.0.0'; $env:HTTPS='1'; node preview-server.js
// 证书怎么来见 tools/make-cert.ps1 与 README 的「手机浏览器使用」。
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';   // 打印局域网地址用（HOST=0.0.0.0 时给手机照抄）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT || 4174);
const ROOT = path.dirname(fileURLToPath(import.meta.url));

/**
 * HTTPS 开关：`HTTPS=1` / `HTTPS=true` / `--https` 都算。
 * 证书默认找 `tools/certs/dev.pfx`（`tools/make-cert.ps1` 生成的那个），
 * 也可以用 PEM 覆盖：`CERT_FILE=... KEY_FILE=...`（自签隧道 / 别的工具生成的证书）。
 */
const HTTPS_ON = /^(1|true|yes|on)$/i.test(String(process.env.HTTPS || '')) || process.argv.includes('--https');
const CERT_DIR = path.join(ROOT, 'tools', 'certs');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.pem': 'application/x-pem-file',
  '.cer': 'application/pkix-cert',
};

/** 读证书：优先 PFX（make-cert.ps1 产出的那个），也可以用 CERT_FILE + KEY_FILE 两个 PEM 覆盖 */
function loadTls() {
  const passphrase = process.env.CERT_PASS || 'motion-fitness';
  // ① 显式指定的 PEM（自己已有证书 / 隧道工具生成的证书）
  if (process.env.CERT_FILE && process.env.KEY_FILE) {
    const cert = process.env.CERT_FILE;
    const key = process.env.KEY_FILE;
    if (fs.existsSync(cert) && fs.existsSync(key)) {
      return { cert: fs.readFileSync(cert), key: fs.readFileSync(key), source: `${cert} + ${key}` };
    }
    return null;
  }
  // ② 默认 / 显式指定的 PFX（tools/make-cert.ps1 的产物）
  const pfxPath = process.env.PFX_FILE || path.join(CERT_DIR, 'dev.pfx');
  if (fs.existsSync(pfxPath)) return { pfx: fs.readFileSync(pfxPath), passphrase, source: pfxPath };
  return null;
}

/** 证书缺失时把「怎么生成、生成在哪」直接说清楚，而不是静默失败 */
function explainMissingCert() {
  console.error('');
  console.error('✗ 打不开 HTTPS：没有找到证书。');
  console.error(`  默认找：${path.join(CERT_DIR, 'dev.pfx')}（tools/make-cert.ps1 生成的那个）`);
  console.error('  生成（在项目根目录跑一次即可，Windows 自带 PowerShell 就够，不需要 openssl）：');
  console.error('      powershell -ExecutionPolicy Bypass -File tools\\make-cert.ps1');
  console.error('  想用自己已有的证书（PEM 两份）：');
  console.error('      $env:CERT_FILE="D:\\certs\\fullchain.pem"; $env:KEY_FILE="D:\\certs\\privkey.pem"; $env:HTTPS="1"; node preview-server.js');
  console.error('');
  console.error('✗ Cannot start HTTPS: no certificate found.');
  console.error('  Generate one:  powershell -ExecutionPolicy Bypass -File tools\\make-cert.ps1');
  console.error('  Or point CERT_FILE / KEY_FILE at your own PEM pair.');
  console.error('');
  process.exit(1);
}

const handler = (req, res) => {
  // 调试数据记录（页面「运动设定」里的「记录调试数据」开关）：
  // 页面把每一批采样（JSONL 文本）POST 到这里，服务端**追加**写进 logs/ 下的文件 ——
  // 这样真机测试完之后，日志就落在项目目录里，可以直接拿来分析「为什么没计上」。
  // 文件名做了白名单校验（只允许 [A-Za-z0-9._-] + .jsonl）。
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
};

/**
 * 监听地址：默认**只监听本机回环**（安全），需要让同一 Wi-Fi 下的手机访问时，
 * 用环境变量打开：`$env:HOST='0.0.0.0'; node preview-server.js`
 *
 * ⚠️ 手机用 http 打开时**摄像头用不了** —— 浏览器只在 `https://` 或 `localhost` 下允许
 * `getUserMedia`（secure context 规则，不是本项目的限制）。手机要练动作必须走 HTTPS：
 * `HTTPS=1` + `tools/make-cert.ps1` 的自签证书，或者 README 里的 ssh 隧道方案。
 */
const HOST = process.env.HOST || '127.0.0.1';
const PROTO = HTTPS_ON ? 'https' : 'http';

/** 本机的局域网 IPv4（列出所有网卡，手机要挑同一 Wi-Fi 的那个） */
function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push({ name, address: ni.address });
    }
  }
  return out;
}

let server;
if (HTTPS_ON) {
  const tls = loadTls();
  if (!tls) explainMissingCert();
  try {
    server = https.createServer(tls, handler);
  } catch (err) {
    console.error('');
    console.error('✗ HTTPS 证书读不了：' + (err && err.message));
    console.error(`  证书来源：${tls.source}`);
    console.error('  重新生成一次： powershell -ExecutionPolicy Bypass -File tools\\make-cert.ps1');
    console.error('  （PFX 口令默认 motion-fitness；换过口令就用 CERT_PASS 指定）');
    console.error('');
    process.exit(1);
  }
} else {
  server = http.createServer(handler);
}

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`✗ 端口 ${PORT} 已被占用：可能已经有一个 preview-server 在跑。`);
    console.error(`  换一个端口：$env:PORT='4175'; node preview-server.js`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, HOST, () => {
  console.log(`体感健身游戏预览地址： ${PROTO}://127.0.0.1:${PORT}`);
  console.log(`Motion Fitness is running at: ${PROTO}://127.0.0.1:${PORT}`);
  if (HOST === '0.0.0.0') {
    // 打印局域网地址，手机直接照这个开（同一 Wi-Fi 下；防火墙要放行 Node 入站）
    for (const { name, address } of lanAddresses()) {
      console.log(`局域网（手机同 Wi-Fi 打开）： ${PROTO}://${address}:${PORT}   [${name}]`);
      console.log(`LAN (open on your phone):      ${PROTO}://${address}:${PORT}   [${name}]`);
    }
    if (HTTPS_ON) {
      console.log('✓ 手机用上面这个 https 地址打开就能开摄像头（证书要先装进手机并信任）');
      console.log('✓ Open the https address above on your phone to use the camera.');
      console.log('  证书装法 / 不想装证书的隧道方案，见 README 的「手机浏览器使用」');
      console.log('  See "Using it on a phone" in README for certificate setup or the tunnel option.');
    } else {
      console.log('⚠️ 手机上只能用来看界面 / 动作库 / 成绩：摄像头需要 https，http 会被浏览器拦下');
      console.log('⚠️ On a phone this is browse-only: the camera needs https.');
      console.log(`   加 HTTPS=1 再启动一次即可：$env:HTTPS='1'; $env:HOST='0.0.0.0'; node preview-server.js`);
    }
  } else if (HTTPS_ON) {
    console.log('✓ HTTPS 已开启（只有本机可达；手机要访问请用 HOST=0.0.0.0）');
    console.log('✓ HTTPS is on (loopback only; use HOST=0.0.0.0 to reach it from a phone)');
  }
  console.log('（用 Chrome / Edge 打开，首次点“开启摄像头”并允许权限）');
  console.log('(Open it in Chrome / Edge, click "Start camera" and allow the permission)');
});
