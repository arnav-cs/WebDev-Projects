'use strict';

const { Replica } = require('./replica');
const { Channel } = require('./channel');
const { makeRng } = require('./rng');

// Drive N replicas through a randomized interleaving of local broadcasts and
// channel deliveries, then drain the channel completely. Returns everything the
// harness needs to prove correctness afterwards.
//
// The interleaving is the point: a replica may broadcast a new message (which
// causally depends on everything it has delivered so far) while earlier
// messages from others are still in flight and arriving out of order.
function runScenario({ seed, replicaCount = 4, opCount = 40, channelOpts } = {}) {
  const rng = makeRng(seed);
  const ids = Array.from({ length: replicaCount }, (_, i) => String.fromCharCode(65 + i)); // A, B, C, ...
  const replicas = ids.map((id) => new Replica(id));
  const byId = Object.fromEntries(replicas.map((r) => [r.id, r]));
  const channel = new Channel(rng, channelOpts);

  // A global record of every message ever sent: id -> send-stamp. The harness
  // uses this to reconstruct the happens-before partial order independently of
  // any replica's local view.
  const stamps = new Map();

  let opsIssued = 0;
  const maxSteps = opCount * 200 + 10000; // safety cap against a pathological seed
  let steps = 0;

  while ((opsIssued < opCount || channel.hasPending()) && steps < maxSteps) {
    steps++;

    // Decide whether to issue a new broadcast or deliver an in-flight message.
    // Bias toward delivery when the channel is backed up so runs terminate.
    const wantBroadcast =
      opsIssued < opCount && (!channel.hasPending() || rng.chance(0.5));

    if (wantBroadcast) {
      const sender = replicas[rng.int(replicas.length)];
      const payload = { seq: opsIssued, from: sender.id };
      const message = sender.broadcast(payload);
      stamps.set(message.id, message.stamp);
      channel.broadcast(message, ids);
      opsIssued++;
    } else {
      const envelope = channel.step();
      if (envelope) byId[envelope.to].receive(envelope.message);
    }
  }

  const drained = !channel.hasPending();
  return { replicas, stamps, drained, steps };
}

module.exports = { runScenario };
