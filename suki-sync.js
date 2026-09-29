#!/usr/bin/env node
/* ============================================================
   好き相関図 — 同じWi-Fi内で内容を同期するための小さなサーバー
   使い方:   node suki-sync.js
   依存:     なし（Node.js の標準機能のみ / Node 18 以上推奨）
   同じフォルダに suki-correlation-map.html を置いてください。
   ============================================================ */
'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const PORT    = parseInt(process.env.PORT || '8787', 10);
const APP     = path.join(__dirname, 'suki-correlation-map.html');
const MAXBODY = 8 * 1024 * 1024;

/* ---- 部屋の状態（サーバー起動中だけ保持。各端末が再送するので消えても復旧します）---- */
const room = { nodes: {}, links: {}, tombs: {} };
const clients = new Map();                 // clientId -> SSE レスポンス
const CODE = String(Math.floor(100000 + Math.random() * 900000));

/* ---- 共通ヘルパ ---- */
function json(res, obj, status) {
  const body = JSON.stringify(obj);
  res.writeHead(status || 200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

/* ut（更新時刻）が新しいほうを採用。削除は墓標(tomb)で表現。 */
function mergeState(base, inc) {
  if (!inc) return base;
  ['nodes', 'links'].forEach(function (kind) {
    const src = inc[kind] || {};
    Object.keys(src).forEach(function (id) {
      const r = src[id];
      if (!r || typeof r !== 'object' || !r.id) return;
      if ((r.ut || 0) <= (base.tombs[id] || 0)) return;          // 消された後の古い更新
      const cur = base[kind][id];
      if (!cur || (r.ut || 0) > (cur.ut || 0)) base[kind][id] = r;
    });
  });
  const tt = inc.tombs || {};
  Object.keys(tt).forEach(function (id) {
    const t = tt[id] || 0;
    if (t > (base.tombs[id] || 0)) base.tombs[id] = t;
    ['nodes', 'links'].forEach(function (kind) {
      const cur = base[kind][id];
      if (cur && (cur.ut || 0) <= base.tombs[id]) delete base[kind][id];
    });
  });
  /* 端点が消えた線は残さない */
  Object.keys(base.links).forEach(function (id) {
    const l = base.links[id];
    if (!l || !base.nodes[l.a] || !base.nodes[l.b]) delete base.links[id];
  });
  return base;
}

function applyOps(ops) {
  const put = { nodes: {}, links: {} };
  const del = {};
  let changed = false;
  (ops || []).forEach(function (o) {
    if (!o) return;
    if (o.op === 'put' && o.rec && o.rec.id) {
      put[o.kind === 'links' ? 'links' : 'nodes'][o.rec.id] = o.rec;
      changed = true;
    } else if (o.op === 'del' && o.id) {
      del[o.id] = Math.max(del[o.id] || 0, o.ut || Date.now());
      changed = true;
    }
  });
  if (!changed) return false;
  mergeState(room, put);
  mergeState(room, { tombs: del });
  return true;
}

function broadcast(msg, except) {
  const line = 'data: ' + JSON.stringify(msg) + '\n\n';
  clients.forEach(function (res, id) {
    if (id === except) return;
    try { res.write(line); } catch (e) { /* 切断済みは無視 */ }
  });
}
function peers() { broadcast({ type: 'peers', n: clients.size }); }

function lanUrls() {
  const out = [];
  const ifs = os.networkInterfaces();
  Object.keys(ifs).forEach(function (name) {
    (ifs[name] || []).forEach(function (a) {
      if (a.family === 'IPv4' && !a.internal) out.push('http://' + a.address + ':' + PORT);
    });
  });
  return out;
}

function readBody(req) {
  return new Promise(function (resolve, reject) {
    let n = 0; const chunks = [];
    req.on('data', function (c) {
      n += c.length;
      if (n > MAXBODY) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', function () { resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', reject);
  });
}

/* ---- ルーティング ---- */
const server = http.createServer(async function (req, res) {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;
  const ra = req.socket.remoteAddress || '';
  const loopback = ra.indexOf('127.') === 0 || ra === '::1' || ra === '::ffff:127.0.0.1';

  try {
    if (req.method === 'OPTIONS') return json(res, { ok: true });

    /* アプリ本体 */
    if (p === '/' || p === '/index.html' || p === '/suki-correlation-map.html') {
      if (!fs.existsSync(APP)) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('suki-correlation-map.html が見つかりません。同じフォルダに置いてください。');
      }
      const html = fs.readFileSync(APP);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': html.length,
        'Cache-Control': 'no-store'
      });
      return res.end(html);
    }

    /* 部屋の情報。コードはこのPC（localhost）からだけ返します */
    if (p === '/api/info') {
      return json(res, {
        ok: true, code: loopback ? CODE : null,
        clients: clients.size, lan: lanUrls(), port: PORT
      });
    }

    /* 参加：自分の内容を送って、統合済みの内容を受け取る */
    if (p === '/api/join' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)) || '{}');
      if (String(b.code) !== CODE) return json(res, { ok: false, error: 'code' }, 404);
      const before = Object.keys(room.nodes).length + Object.keys(room.links).length;
      mergeState(room, b.state);
      return json(res, {
        ok: true, code: CODE, now: Date.now(), state: room,
        clients: Math.max(1, clients.size), empty: before === 0
      });
    }

    /* 変更の配信 */
    if (p === '/api/op' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)) || '{}');
      if (String(b.code) !== CODE) return json(res, { ok: false, error: 'code' }, 404);
      applyOps(b.ops);
      broadcast({ type: 'ops', ops: b.ops, from: b.clientId }, b.clientId);
      return json(res, { ok: true, now: Date.now() });
    }

    /* 受信ストリーム（SSE） */
    if (p === '/api/events') {
      if (String(u.searchParams.get('code')) !== CODE) return json(res, { ok: false, error: 'code' }, 404);
      const cid = u.searchParams.get('clientId') || ('c' + Math.random().toString(36).slice(2));
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'X-Accel-Buffering': 'no'
      });
      res.write('retry: 2000\n\n');
      res.write('data: ' + JSON.stringify({ type: 'hello', now: Date.now(), clients: clients.size }) + '\n\n');
      const old = clients.get(cid);
      if (old && old !== res) { try { old.end(); } catch (e) {} }
      clients.set(cid, res);
      peers();
      const hb = setInterval(function () { try { res.write(':ping\n\n'); } catch (e) {} }, 20000);
      req.on('close', function () {
        clearInterval(hb);
        if (clients.get(cid) === res) { clients.delete(cid); peers(); }
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  } catch (e) {
    json(res, { ok: false, error: String((e && e.message) || e) }, 400);
  }
});

server.on('error', function (e) {
  if (e && e.code === 'EADDRINUSE') {
    console.error('\n  ポート ' + PORT + ' は使用中です。別のポートで起動してください：');
    console.error('    PORT=8788 node suki-sync.js\n');
  } else {
    console.error('\n  起動に失敗しました: ' + (e && e.message) + '\n');
  }
  process.exit(1);
});

server.listen(PORT, function () {
  const urls = lanUrls();
  const line = '─'.repeat(52);
  console.log('\n' + line);
  console.log('  好き相関図  同期サーバー 起動');
  console.log(line);
  console.log('');
  console.log('   部屋コード ：  ' + CODE + '   ← 他の端末でこの6桁を入力');
  console.log('');
  console.log('   この端末        http://localhost:' + PORT);
  urls.forEach(function (url, i) {
    console.log('   同じWi-Fiの端末 ' + (i ? '        ' : '') + url);
  });
  if (!urls.length) console.log('   （Wi-FiのIPが見つかりませんでした。ネットワーク接続を確認してください）');
  console.log('');
  console.log('  スマホ等で上のURLを開き、6桁のコードを入力すると同期します。');
  console.log('  終了するには Ctrl + C。');
  console.log(line + '\n');
});
