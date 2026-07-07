'use strict';

// Phase 3 sync hub. Unlike the Phase 2 relay (which blindly forwards every op),
// this server maintains the authoritative oplog per room in a server-side
// SyncDoc, so it can:
//   - bring a (re)connecting client up to date with ONE delta computed from the
//     client's version vector — no full-history replay;
//   - accept a client's own missing ops (its delta against the server) and relay
//     live updates to the others;
//   - forward awareness/presence WITHOUT storing it (ephemeral).
//
// This is the y-websocket shape in miniature.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { SyncDoc } = require('./sync-doc');

const PORT = process.env.PORT || 3001;
const PUBLIC = path.join(__dirname, 'public');
const FILES = {
  '/rga.js': path.join(__dirname, '..', 'phase2-sequence', 'rga.js'),
  '/sync-doc.js': path.join(__dirname, 'sync-doc.js'),
  '/awareness.js': path.join(__dirname, 'awareness.js'),
};
const TYPES = { '.html': 'text/html', '.js': 'text/javascript' };

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://x').pathname;
  let file;
  if (pathname === '/' || pathname === '/index.html') file = path.join(PUBLIC, 'index.html');
  else if (pathname === '/client.js') file = path.join(PUBLIC, 'client.js');
  else if (FILES[pathname]) file = FILES[pathname];
  else file = path.join(PUBLIC, path.basename(pathname));
  fs.readFile(file, (err, data) => {
    if (err) return res.writeHead(404).end('not found');
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'text/plain' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });

// room -> { doc: SyncDoc, clients: Set<socket> }
const rooms = new Map();
function room(name) {
  if (!rooms.has(name)) rooms.set(name, { doc: new SyncDoc('server'), clients: new Set() });
  return rooms.get(name);
}

wss.on('connection', (socket, req) => {
  const name = new URL(req.url, 'http://x').searchParams.get('room') || 'default';
  const r = room(name);
  r.clients.add(socket);

  const sendJSON = (obj) => socket.readyState === socket.OPEN && socket.send(JSON.stringify(obj));

  socket.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === 'hello') {
      // Client announced what it has; reply with the delta it's missing plus our
      // vector so it can push what WE'RE missing. One round trip.
      sendJSON({ type: 'sync', ops: r.doc.delta(msg.vv || {}), vv: r.doc.stateVector() });
      return;
    }

    if (msg.type === 'update') {
      // Store the client's ops and relay only the genuinely-new ones onward.
      const fresh = [];
      for (const w of msg.ops) {
        const before = r.doc.oplog[w.origin] ? r.doc.oplog[w.origin].length : 0;
        r.doc.integrate([w]);
        const after = r.doc.oplog[w.origin] ? r.doc.oplog[w.origin].length : 0;
        if (after > before) fresh.push(w);
      }
      if (fresh.length) {
        for (const peer of r.clients) {
          if (peer !== socket && peer.readyState === peer.OPEN) {
            peer.send(JSON.stringify({ type: 'update', ops: fresh }));
          }
        }
      }
      return;
    }

    if (msg.type === 'awareness') {
      // Ephemeral: relay, never store.
      for (const peer of r.clients) {
        if (peer !== socket && peer.readyState === peer.OPEN) peer.send(raw.toString());
      }
    }
  });

  socket.on('close', () => {
    r.clients.delete(socket);
    if (r.clients.size === 0) rooms.delete(name);
  });
});

server.listen(PORT, () => console.log(`Phase 3 sync hub on http://localhost:${PORT}`));

module.exports = { server, rooms };
