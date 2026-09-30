#!/usr/bin/env node
// A stand-in push service for local tests. POST /p/<name> -> 201 and the
// request (headers + base64 body) appended as a JSON line to <log>;
// POST /gone/<name> -> 410 (subscription expired).
//   node scripts/fake_push_server.mjs <port> <log>
import http from 'node:http';
import fs from 'node:fs';
const [port, log] = process.argv.slice(2);
http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c)).on('end', () => {
    const body = Buffer.concat(chunks);
    fs.appendFileSync(log, JSON.stringify({ path: req.url, method: req.method, headers: req.headers, body: body.toString('base64') }) + '\n');
    res.writeHead(req.url.startsWith('/gone/') ? 410 : 201).end();
  });
}).listen(Number(port), '127.0.0.1');
