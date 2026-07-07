'use strict';

// End-to-end checkpoint test: stand up the REAL relay server and connect two
// clients over actual websockets, each driving its own RGA. Prove that edits
// made on both sides, relayed through the dumb server, converge to identical
// text. This is the "two browser tabs sync" milestone, verified without a
// browser (Node 22 ships a global WebSocket client).

process.env.PORT = process.env.PORT || '3999';
const { server } = require('./server');
const { RGA } = require('./rga');

const PORT = process.env.PORT;
const ROOM = 'e2e';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// A minimal client: an RGA + a socket that broadcasts local ops and applies
// remote ones — the exact contract the browser client implements.
function makeClient(id) {
  const doc = new RGA(id);
  const ws = new WebSocket(`ws://localhost:${PORT}/?room=${ROOM}`);
  const ready = new Promise((res) => (ws.onopen = () => res()));
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'ops') for (const op of msg.ops) doc.apply(op);
  };
  const typeAt = (index, str) => {
    const ops = [];
    for (let i = 0; i < str.length; i++) ops.push(doc.insertAt(index + i, str[i]));
    ws.send(JSON.stringify({ type: 'ops', ops }));
  };
  const deleteAt = (index, count) => {
    const ops = [];
    for (let i = 0; i < count; i++) {
      const op = doc.deleteAt(index);
      if (op) ops.push(op);
    }
    ws.send(JSON.stringify({ type: 'ops', ops }));
  };
  return { id, doc, ws, ready, typeAt, deleteAt };
}

async function main() {
  const A = makeClient('A');
  const B = makeClient('B');
  await Promise.all([A.ready, B.ready]);

  // A types, B types concurrently at their own ends, then a cross edit.
  A.typeAt(0, 'Hello');
  B.typeAt(0, 'World');
  await wait(50);
  A.typeAt(A.doc.length(), '!'); // append at whatever A now sees
  B.deleteAt(0, 1); // delete B's first visible char
  await wait(80);

  assert(A.doc.pending.length === 0 && B.doc.pending.length === 0, 'ops left buffered');
  assert(
    A.doc.text() === B.doc.text(),
    `divergence through relay:\n  A: ${JSON.stringify(A.doc.text())}\n  B: ${JSON.stringify(B.doc.text())}`
  );

  console.log('✓ two clients synced through the real websocket relay');
  console.log(`  • converged text: ${JSON.stringify(A.doc.text())}`);
  console.log('  • server relayed opaque ops only; convergence computed client-side by RGA');

  A.ws.close();
  B.ws.close();
  await wait(20);
  server.close();
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('✗', err.message);
    server.close();
    process.exit(1);
  }
);
