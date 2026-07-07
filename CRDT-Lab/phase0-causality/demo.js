'use strict';

// A hand-built scenario that makes causal buffering visible, without any RNG.
//
// The classic setup:
//   1. A broadcasts m1 ("hello").
//   2. B delivers m1, then broadcasts m2 ("re: hello") — m2 causally DEPENDS on
//      m1, because B had seen m1 when it sent m2.
//   3. C receives m2 FIRST (the network reordered them). C must NOT deliver m2
//      yet — that would show a reply before the message it answers. C buffers
//      m2 until m1 arrives, then delivers both in causal order.
//
// Run: node demo.js

const { Replica } = require('./replica');

function show(label, replica) {
  const log = replica.log.map((p) => p.text).join(', ') || '(empty)';
  const buffered = replica.buffer.map((m) => m.payload.text).join(', ') || '(none)';
  console.log(`  ${label}: delivered=[${log}]  buffered=[${buffered}]  clock=${replica.clock}`);
}

function main() {
  const A = new Replica('A');
  const B = new Replica('B');
  const C = new Replica('C');

  console.log('Step 1 — A broadcasts m1 "hello"');
  const m1 = A.broadcast({ text: 'hello' });
  console.log('Step 2 — B receives m1 and delivers it');
  B.receive(m1);
  console.log('Step 3 — B broadcasts m2 "re: hello" (causally depends on m1)');
  const m2 = B.broadcast({ text: 're: hello' });
  console.log(`         m1 stamp=${m1.stamp}   m2 stamp=${m2.stamp}   (m2 dominates m1 → m1 happens-before m2)`);

  console.log('\nStep 4 — the network REORDERS: C receives m2 BEFORE m1');
  C.receive(m2);
  show('C after receiving m2 first', C);
  console.log('         → C correctly refuses to deliver the reply before the original; m2 is parked.');

  console.log('\nStep 5 — m1 finally arrives at C');
  C.receive(m1);
  show('C after m1 arrives', C);
  console.log('         → m1 unblocks m2; both delivered, and in causal order.');

  const order = C.log.map((p) => p.text);
  const correct = order.join(' | ') === 'hello | re: hello';
  console.log(`\nC's delivery order: ${order.join(' -> ')}  ${correct ? '✓ causal' : '✗ WRONG'}`);
  if (!correct) process.exit(1);
}

main();
