'use strict';

// End-to-end Phase 3: real hub server + two websocket clients, exercising the
// full protocol including a DISCONNECT / offline-edit / RECONNECT cycle. Proves
// a client can go offline, make 500 edits, reconnect, and resync through the hub
// in a single delta exchange — over real sockets.

process.env.PORT = process.env.PORT || '4021';
const { server } = require('./server');
const { SyncDoc } = require('./sync-doc');

const PORT = process.env.PORT;
const ROOM = 'e2e3';
const assert = (c, m) => {
  if (!c) throw new Error(m);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// A client mirroring the browser protocol: hello→sync→push, live updates, and
// a counter of how many 'update' messages it sends (to prove reconnection is
// one message, not 500).
function makeClient(id) {
  const doc = new SyncDoc(id);
  let ws = null;
  let updatesSent = 0;
  const connect = () =>
    new Promise((res) => {
      ws = new WebSocket(`ws://localhost:${PORT}/?room=${ROOM}`);
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'hello', vv: doc.stateVector() }));
        res();
      };
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'sync') {
          doc.integrate(msg.ops);
          const push = doc.delta(msg.vv); // everything the server lacks (incl. offline edits)
          if (push.length) {
            ws.send(JSON.stringify({ type: 'update', ops: push }));
            updatesSent++;
          }
        } else if (msg.type === 'update') {
          doc.integrate(msg.ops);
        }
      };
    });
  const send = (ops) => {
    if (ws && ws.readyState === WebSocket.OPEN && ops.length) {
      ws.send(JSON.stringify({ type: 'update', ops }));
      updatesSent++;
    }
  };
  return {
    id,
    doc,
    connect,
    disconnect: () => ws && ws.close(),
    type: (index, str) => {
      const ops = [];
      for (let i = 0; i < str.length; i++) ops.push(doc.insertAt(index + i, str[i]));
      send(ops);
    },
    typeOffline: (index, str) => {
      // Edits while disconnected: applied locally, NOT sent (no socket).
      for (let i = 0; i < str.length; i++) doc.insertAt(index + i, str[i]);
    },
    get updatesSent() {
      return updatesSent;
    },
  };
}

async function main() {
  const A = makeClient('A');
  const B = makeClient('B');
  await A.connect();
  await B.connect();
  await wait(30);

  A.type(0, 'shared');
  await wait(50);
  assert(B.doc.text() === 'shared', `B should see 'shared', got ${JSON.stringify(B.doc.text())}`);

  // A disconnects and makes 500 offline edits; B keeps working online.
  A.disconnect();
  await wait(20);
  const updatesBeforeReconnect = A.updatesSent;
  for (let i = 0; i < 500; i++) A.typeOffline(A.doc.length(), 'y');
  B.type(B.doc.length(), '!');
  await wait(30);

  // A reconnects: hello → server sync (delivers B's '!') → A pushes its 500 ops
  // in ONE update message.
  await A.connect();
  await wait(120);

  assert(A.doc.text() === B.doc.text(), `post-reconnect divergence:\n A=${A.doc.text().length} B=${B.doc.text().length}`);
  assert(A.doc.length() === 507, `expected 507 chars (6 + 500 + 1), got ${A.doc.length()}`);
  const reconnectPushes = A.updatesSent - updatesBeforeReconnect;
  assert(reconnectPushes === 1, `expected exactly 1 update message on reconnect, got ${reconnectPushes}`);

  console.log('✓ Phase 3 e2e: offline→reconnect resynced through the real hub');
  console.log(`  • A made 500 edits offline, pushed them in ${reconnectPushes} delta message on reconnect`);
  console.log(`  • both clients converged to ${A.doc.length()} characters`);

  A.disconnect();
  B.disconnect();
  await wait(20);
  server.close();
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error('✗', e.message);
    server.close();
    process.exit(1);
  }
);
