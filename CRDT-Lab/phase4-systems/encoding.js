'use strict';

// Phase 4 · Problem 2 — EFFICIENT BINARY ENCODING.
//
// A naive CRDT stores full metadata per character: for the string "hello" that's
// five wire ops, each a JSON object with an origin, a sequence number, a
// {counter, replica} id, an {counter, replica} anchor, and a value. Hundreds of
// bytes to represent five. This is *the* reason a naive CRDT explodes in memory
// and bandwidth, and *the* reason Yjs and Automerge are fast.
//
// The fix exploits a structural fact about how people type: consecutive
// keystrokes form a RUN. When you type "hello" left to right the ops are
//   id (c=1,r=A) after ∅ ; id (c=2,r=A) after (1,A) ; id (c=3,r=A) after (2,A) …
// i.e. the sequence numbers are contiguous, the id counters are contiguous, the
// replica is constant, and each op's anchor is the previous op's id. An entire
// run collapses to: {replica A, startSeq, startCounter, anchor, count, "hello"}.
// That is run-length encoding of operations — exactly the Yjs "Item has a
// length" idea. We combine it with a string table (replica ids are interned and
// referenced by index, not repeated) and LEB128 varints for all integers, which
// is the columnar spirit of Automerge.
//
// Everything here — the varints, the run detection, the byte layout — is built
// from scratch. The benchmark against the naive JSON baseline is the point.

// ---- LEB128 unsigned varint ------------------------------------------------
function writeVarint(bytes, n) {
  let v = n >>> 0;
  if (n > 0xffffffff) v = n; // allow larger via plain arithmetic below
  let x = n;
  while (x > 0x7f) {
    bytes.push((x & 0x7f) | 0x80);
    x = Math.floor(x / 128);
  }
  bytes.push(x & 0x7f);
}
function readVarint(buf, pos) {
  let shift = 1;
  let result = 0;
  let p = pos;
  while (true) {
    const byte = buf[p++];
    result += (byte & 0x7f) * shift;
    if ((byte & 0x80) === 0) break;
    shift *= 128;
  }
  return [result, p];
}

// ---- length-prefixed UTF-8 string ------------------------------------------
function writeStr(bytes, str) {
  const utf8 = Buffer.from(str, 'utf8');
  writeVarint(bytes, utf8.length);
  for (const b of utf8) bytes.push(b);
}
function readStr(buf, pos) {
  const [len, p] = readVarint(buf, pos);
  return [buf.slice(p, p + len).toString('utf8'), p + len];
}

const TAG = { INSERT_RUN: 1, INSERT_SINGLE: 2, DELETE_RUN: 3, DELETE_SINGLE: 4 };

// Flatten a SyncDoc oplog (or accept a flat array) into ops sorted by (origin,
// seq) so typing runs are adjacent.
function flatten(oplogOrOps) {
  let ops;
  if (Array.isArray(oplogOrOps)) ops = oplogOrOps.slice();
  else {
    ops = [];
    for (const log of Object.values(oplogOrOps)) for (const w of log) if (w) ops.push(w);
  }
  ops.sort((a, b) => (a.origin < b.origin ? -1 : a.origin > b.origin ? 1 : a.seq - b.seq));
  return ops;
}

// ---- encode ----------------------------------------------------------------
function encode(oplogOrOps) {
  const ops = flatten(oplogOrOps);

  // String table: intern every replica-id string.
  const table = [];
  const idx = new Map();
  const intern = (s) => {
    if (!idx.has(s)) {
      idx.set(s, table.length);
      table.push(s);
    }
    return idx.get(s);
  };
  for (const op of ops) {
    intern(op.origin);
    intern(op.inner.id.r);
    if (op.inner.type === 'insert' && op.inner.afterId) intern(op.inner.afterId.r);
  }

  const body = [];
  const isInsert = (op) => op.inner.type === 'insert';

  let i = 0;
  while (i < ops.length) {
    const op = ops[i];
    if (isInsert(op)) {
      // Extend a typing run.
      let j = i + 1;
      const values = [op.inner.value];
      while (j < ops.length) {
        const prev = ops[j - 1];
        const cur = ops[j];
        if (
          isInsert(cur) &&
          cur.origin === op.origin &&
          cur.seq === prev.seq + 1 &&
          cur.inner.id.r === op.inner.id.r &&
          cur.inner.id.c === prev.inner.id.c + 1 &&
          cur.inner.afterId &&
          cur.inner.afterId.c === prev.inner.id.c &&
          cur.inner.afterId.r === prev.inner.id.r &&
          typeof cur.inner.value === 'string' &&
          cur.inner.value.length === 1
        ) {
          values.push(cur.inner.value);
          j++;
        } else break;
      }
      const count = j - i;
      if (count >= 2) {
        body.push(TAG.INSERT_RUN);
        writeVarint(body, intern(op.origin));
        writeVarint(body, op.seq); // startSeq
        writeVarint(body, op.inner.id.c); // startCounter (r == origin for inserts)
        // anchor of the run's first op
        if (op.inner.afterId) {
          body.push(1);
          writeVarint(body, op.inner.afterId.c);
          writeVarint(body, intern(op.inner.afterId.r));
        } else body.push(0);
        writeVarint(body, count);
        writeStr(body, values.join(''));
        i = j;
      } else {
        body.push(TAG.INSERT_SINGLE);
        writeVarint(body, intern(op.origin));
        writeVarint(body, op.seq);
        writeVarint(body, op.inner.id.c);
        writeVarint(body, intern(op.inner.id.r));
        if (op.inner.afterId) {
          body.push(1);
          writeVarint(body, op.inner.afterId.c);
          writeVarint(body, intern(op.inner.afterId.r));
        } else body.push(0);
        writeStr(body, op.inner.value);
        i++;
      }
    } else {
      // Delete run: contiguous deleted counters by the same author, contiguous
      // deleter seq (e.g. deleting a selection).
      let j = i + 1;
      while (j < ops.length) {
        const prev = ops[j - 1];
        const cur = ops[j];
        if (
          !isInsert(cur) &&
          cur.origin === op.origin &&
          cur.seq === prev.seq + 1 &&
          cur.inner.id.r === op.inner.id.r &&
          cur.inner.id.c === prev.inner.id.c + 1
        ) {
          j++;
        } else break;
      }
      const count = j - i;
      if (count >= 2) {
        body.push(TAG.DELETE_RUN);
        writeVarint(body, intern(op.origin)); // deleter
        writeVarint(body, op.seq); // startSeq
        writeVarint(body, intern(op.inner.id.r)); // author of deleted range
        writeVarint(body, op.inner.id.c); // startCounter
        writeVarint(body, count);
        i = j;
      } else {
        body.push(TAG.DELETE_SINGLE);
        writeVarint(body, intern(op.origin));
        writeVarint(body, op.seq);
        writeVarint(body, intern(op.inner.id.r));
        writeVarint(body, op.inner.id.c);
        i++;
      }
    }
  }

  // Assemble: magic, version, string table, op count, body.
  const head = [];
  head.push(0xc7, 0x01); // magic 'CRDT v1'
  writeVarint(head, table.length);
  for (const s of table) writeStr(head, s);
  writeVarint(head, ops.length);
  return Buffer.from(head.concat(body));
}

// ---- decode ----------------------------------------------------------------
function decode(buf) {
  let pos = 0;
  if (buf[pos] !== 0xc7 || buf[pos + 1] !== 0x01) throw new Error('bad magic');
  pos += 2;
  let tableLen;
  [tableLen, pos] = readVarint(buf, pos);
  const table = [];
  for (let k = 0; k < tableLen; k++) {
    let s;
    [s, pos] = readStr(buf, pos);
    table.push(s);
  }
  let total;
  [total, pos] = readVarint(buf, pos);

  const ops = [];
  while (ops.length < total) {
    const tag = buf[pos++];
    if (tag === TAG.INSERT_RUN) {
      let originIdx, startSeq, startC, count;
      [originIdx, pos] = readVarint(buf, pos);
      [startSeq, pos] = readVarint(buf, pos);
      [startC, pos] = readVarint(buf, pos);
      const hasAnchor = buf[pos++];
      let afterId = null;
      if (hasAnchor) {
        let ac, arIdx;
        [ac, pos] = readVarint(buf, pos);
        [arIdx, pos] = readVarint(buf, pos);
        afterId = { c: ac, r: table[arIdx] };
      }
      [count, pos] = readVarint(buf, pos);
      let values;
      [values, pos] = readStr(buf, pos);
      const origin = table[originIdx];
      let prevId = afterId;
      for (let k = 0; k < count; k++) {
        const id = { c: startC + k, r: origin };
        ops.push({
          origin,
          seq: startSeq + k,
          inner: { type: 'insert', id, value: values[k], afterId: k === 0 ? afterId : prevId },
        });
        prevId = id;
      }
    } else if (tag === TAG.INSERT_SINGLE) {
      let originIdx, seq, c, rIdx;
      [originIdx, pos] = readVarint(buf, pos);
      [seq, pos] = readVarint(buf, pos);
      [c, pos] = readVarint(buf, pos);
      [rIdx, pos] = readVarint(buf, pos);
      const hasAnchor = buf[pos++];
      let afterId = null;
      if (hasAnchor) {
        let ac, arIdx;
        [ac, pos] = readVarint(buf, pos);
        [arIdx, pos] = readVarint(buf, pos);
        afterId = { c: ac, r: table[arIdx] };
      }
      let value;
      [value, pos] = readStr(buf, pos);
      ops.push({ origin: table[originIdx], seq, inner: { type: 'insert', id: { c, r: table[rIdx] }, value, afterId } });
    } else if (tag === TAG.DELETE_RUN) {
      let originIdx, startSeq, rIdx, startC, count;
      [originIdx, pos] = readVarint(buf, pos);
      [startSeq, pos] = readVarint(buf, pos);
      [rIdx, pos] = readVarint(buf, pos);
      [startC, pos] = readVarint(buf, pos);
      [count, pos] = readVarint(buf, pos);
      for (let k = 0; k < count; k++) {
        ops.push({ origin: table[originIdx], seq: startSeq + k, inner: { type: 'delete', id: { c: startC + k, r: table[rIdx] } } });
      }
    } else if (tag === TAG.DELETE_SINGLE) {
      let originIdx, seq, rIdx, c;
      [originIdx, pos] = readVarint(buf, pos);
      [seq, pos] = readVarint(buf, pos);
      [rIdx, pos] = readVarint(buf, pos);
      [c, pos] = readVarint(buf, pos);
      ops.push({ origin: table[originIdx], seq, inner: { type: 'delete', id: { c, r: table[rIdx] } } });
    } else {
      throw new Error('bad tag ' + tag);
    }
  }
  return ops;
}

// Naive baseline: what "just JSON the ops" costs, for the benchmark.
function naiveBytes(oplogOrOps) {
  return Buffer.byteLength(JSON.stringify(flatten(oplogOrOps)), 'utf8');
}

module.exports = { encode, decode, naiveBytes, writeVarint, readVarint, flatten };
