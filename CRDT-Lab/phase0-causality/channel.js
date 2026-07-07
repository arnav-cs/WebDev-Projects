'use strict';

// The unreliable substrate the replicas talk over.
//
// What failure am I handling? (Phase 0's first of the three questions.)
//   - REORDER:     messages are drained in random order, not send order.
//   - DELAY:       a message can sit in flight arbitrarily long.
//   - DUPLICATION: a message may be delivered more than once.
//   - LOSS:        modeled as loss-plus-retransmission — a dropped message is
//                  re-queued rather than destroyed. True loss without
//                  retransmit would break liveness (some causal successor could
//                  never become deliverable), so the honest model of a real
//                  reliable-but-unordered transport is: eventually delivered at
//                  least once, in arbitrary order. Loss therefore surfaces to
//                  the causal layer as extra delay + duplication, which is
//                  exactly what it must tolerate.
//
// The channel does NOT preserve any order. Rebuilding order is the replica's
// job. That separation is the whole lesson.

class Channel {
  constructor(rng, { dupProbability = 0.15, dropProbability = 0.1 } = {}) {
    this.rng = rng;
    this.dupProbability = dupProbability;
    this.dropProbability = dropProbability;
    // in-flight: array of { to, message }
    this.inFlight = [];
  }

  // Enqueue a message for every recipient (broadcast). Sender excluded — it
  // delivered to itself already.
  broadcast(message, recipients) {
    for (const to of recipients) {
      if (to === message.from) continue;
      this.inFlight.push({ to, message });
    }
  }

  hasPending() {
    return this.inFlight.length > 0;
  }

  size() {
    return this.inFlight.length;
  }

  // Pull one random in-flight envelope and decide its fate. Returns the
  // envelope to hand to the recipient, or null if this step produced no
  // delivery (a drop-and-requeue). Callers loop until hasPending() is false.
  step() {
    if (!this.hasPending()) return null;
    const envelope = this.rng.takeRandom(this.inFlight);

    // Loss: put it back to be retried later (retransmission). Because it's
    // re-inserted and drained randomly, this manifests as additional delay.
    if (this.rng.chance(this.dropProbability)) {
      this.inFlight.push(envelope);
      return null;
    }

    // Duplication: schedule a second copy for later.
    if (this.rng.chance(this.dupProbability)) {
      this.inFlight.push({ to: envelope.to, message: envelope.message });
    }

    return envelope;
  }
}

module.exports = { Channel };
