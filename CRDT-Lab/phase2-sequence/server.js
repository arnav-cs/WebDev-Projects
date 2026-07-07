'use strict';

// Phase 2 checkpoint relay: a websocket server that broadcasts every op it
// receives to all OTHER clients in the same room, plus a tiny static file server
// for the demo page. This is deliberately dumb — it does NOT understand the
// CRDT. It just forwards opaque op messages. All convergence logic lives in the
// RGA on each client; the server is pure transport. (Phase 3 replaces this naive
// "broadcast every op" with version-vector delta sync.)

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const RGA_FILE = path.join(__dirname, 'rga.js');

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://x').pathname; // strip the query string
  let file;
  if (pathname === '/' || pathname === '/index.html') file = path.join(PUBLIC, 'index.html');
  else if (pathname === '/client.js') file = path.join(PUBLIC, 'client.js');
  else if (pathname === '/rga.js') file = RGA_FILE; // serve the shared CRDT source
  else file = path.join(PUBLIC, path.basename(pathname));

  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'text/plain' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });

// room -> Set<socket>
const rooms = new Map();

wss.on('connection', (socket, req) => {
  const room = new URL(req.url, 'http://x').searchParams.get('room') || 'default';
  if (!rooms.has(room)) rooms.set(room, new Set());
  rooms.get(room).add(socket);

  socket.on('message', (data) => {
    // Relay verbatim to everyone else in the room. The payload is an op (or a
    // batch) the receiving RGA knows how to apply; the server stays oblivious.
    for (const peer of rooms.get(room)) {
      if (peer !== socket && peer.readyState === peer.OPEN) peer.send(data.toString());
    }
  });

  socket.on('close', () => {
    const set = rooms.get(room);
    if (set) {
      set.delete(socket);
      if (set.size === 0) rooms.delete(room);
    }
  });
});

server.listen(PORT, () => {
  console.log(`RGA collab relay on http://localhost:${PORT}  (open two tabs to collaborate)`);
});

module.exports = { server };
