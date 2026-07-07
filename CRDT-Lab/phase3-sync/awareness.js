'use strict';

// Awareness / presence: live cursors, selections, names. This state is
// EPHEMERAL and deliberately does NOT go through the CRDT or the oplog.
//
// Why not? Presence is high-frequency (every cursor move) and worthless once
// stale — you never want to persist or causally replay "user X's cursor was at
// offset 12 four hours ago." Routing it through the CRDT would bloat the oplog
// permanently with garbage and couple a transient UI concern to your durable
// data. (The roadmap flags mixing them up as "a mistake worth making once to
// feel why.") So awareness is its own last-write-wins-per-field channel with a
// timeout: each client periodically announces its state; entries expire.

class Awareness {
  constructor(localId) {
    this.localId = localId;
    this.local = {}; // this client's presence fields
    this.states = new Map(); // clientId -> { state, lastSeen }
    this.timeout = 30000; // drop peers unheard-from for this long
  }

  // Update local presence and produce the message to broadcast (ephemerally).
  setLocal(fields) {
    this.local = { ...this.local, ...fields };
    return { type: 'awareness', clientId: this.localId, state: this.local };
  }

  // Apply a peer's presence update. `now` is injected for deterministic tests.
  receive(msg, now) {
    if (msg.clientId === this.localId) return;
    this.states.set(msg.clientId, { state: msg.state, lastSeen: now });
  }

  // Live peers, excluding expired ones.
  peers(now) {
    const out = {};
    for (const [id, entry] of this.states) {
      if (now - entry.lastSeen <= this.timeout) out[id] = entry.state;
    }
    return out;
  }

  // Explicit removal (e.g. on disconnect).
  remove(clientId) {
    this.states.delete(clientId);
  }
}

if (typeof module !== 'undefined' && module.exports) module.exports = { Awareness };
