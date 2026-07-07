'use strict';

const { VectorClock } = require('./vector-clock');

// A replica implementing CAUSAL-ORDER broadcast delivery.
//
// The substrate (channel.js) may reorder, delay, and duplicate messages. This
// class rebuilds causal order on top of that unreliable substrate: a message is
// handed to the application ("delivered") only once every message that
// causally precedes it has already been delivered here. Anything that arrives
// early is parked in a buffer and retried after each successful delivery.
//
// Vector-clock semantics for causal broadcast (message-counting):
//   V[k] = number of messages ORIGINATED by replica k that this replica has
//          delivered.  V[self] additionally counts messages self has broadcast.
//
// A message m broadcast by j, stamped with the sender's clock S at send time,
// is deliverable at this replica (clock V) exactly when:
//   (1) S[j] === V[j] + 1                 -- m is the very next message from j
//   (2) S[k] <= V[k]  for all k !== j     -- we've already seen everything m saw
//
// (1) enforces per-sender FIFO; (2) enforces cross-sender causality. Together
// they are the classic Birman–Schiper–Stephenson causal multicast rule.

class Replica {
  constructor(id) {
    this.id = id;
    this.clock = new VectorClock();
    this.buffer = []; // messages received but not yet causally deliverable
    this.log = []; // payloads in the order they were delivered (the causal log)

    // Instrumentation for the correctness proofs in the harness:
    this.deliveredOrder = []; // message ids in the order delivered here
    this.deliveredIds = new Set(); // message ids delivered here (dedup + coverage)
    this.everBufferedOutOfOrder = false; // did we ever have to park a message?
  }

  // Application asks to broadcast a payload. Returns the wire message the
  // caller should hand to the channel for the *other* replicas. The sender
  // delivers its own message immediately (locally causally-ready by
  // construction).
  broadcast(payload) {
    this.clock.increment(this.id);
    const message = {
      id: `${this.id}#${this.clock.get(this.id)}`, // globally unique: origin + per-origin seq
      from: this.id,
      stamp: this.clock.copy(), // snapshot AFTER incrementing for this send
      payload,
    };
    // Deliver-to-self: record locally without going through the buffer.
    this.log.push(payload);
    this.deliveredOrder.push(message.id);
    this.deliveredIds.add(message.id);
    return message;
  }

  // The substrate hands us a message (possibly out of order, possibly a dup).
  receive(message) {
    if (this.deliveredIds.has(message.id)) return; // idempotent: drop duplicates
    if (this.buffer.some((m) => m.id === message.id)) return; // already parked
    this.buffer.push(message);
    this._drainBuffer();
  }

  _canDeliver(message) {
    const S = message.stamp;
    const j = message.from;
    if (S.get(j) !== this.clock.get(j) + 1) return false; // condition (1)
    for (const k of Object.keys(S.entries)) {
      if (k === j) continue;
      if (S.get(k) > this.clock.get(k)) return false; // condition (2)
    }
    return true;
  }

  _deliver(message) {
    this.log.push(message.payload);
    this.deliveredOrder.push(message.id);
    this.deliveredIds.add(message.id);
    // Advance our knowledge of the sender by exactly one message.
    this.clock.increment(message.from);
  }

  // Repeatedly sweep the buffer: delivering one message may unblock others, so
  // we loop until a full pass delivers nothing.
  _drainBuffer() {
    let progress = true;
    while (progress) {
      progress = false;
      for (let i = 0; i < this.buffer.length; i++) {
        const message = this.buffer[i];
        if (this._canDeliver(message)) {
          this.buffer.splice(i, 1);
          this._deliver(message);
          progress = true;
          break; // restart the sweep from the top
        } else {
          // We're about to deliver something whose predecessors aren't here yet
          // — the buffering that makes causal delivery real.
          this.everBufferedOutOfOrder = true;
        }
      }
    }
  }
}

module.exports = { Replica };
