'use strict';

// Browser client for the Phase 2 checkpoint. Binds a <textarea> to an RGA:
// local edits are diffed into insert/delete ops, applied locally, and broadcast;
// remote ops are applied and the textarea re-rendered. The RGA guarantees every
// tab converges to the same text regardless of order.

(function () {
  const params = new URLSearchParams(location.search);
  const room = params.get('room') || 'default';
  // A per-tab replica id. Must be unique per participant, hence random-ish.
  const replicaId = params.get('id') || 'r' + Math.floor(Math.random() * 1e6).toString(36);

  document.getElementById('replica').textContent = replicaId;
  document.getElementById('room').textContent = room;
  const statusEl = document.getElementById('status');
  const editor = document.getElementById('editor');

  const doc = new RGA(replicaId);
  let lastText = '';

  // ---- transport -----------------------------------------------------------
  const wsUrl = `ws://${location.host}/?room=${encodeURIComponent(room)}`;
  let socket;
  function connect() {
    socket = new WebSocket(wsUrl);
    socket.onopen = () => (statusEl.textContent = 'connected');
    socket.onclose = () => {
      statusEl.textContent = 'disconnected — retrying…';
      setTimeout(connect, 1000);
    };
    socket.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'ops') applyRemote(msg.ops);
    };
  }
  function send(ops) {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'ops', ops }));
    }
  }

  // ---- local edits → ops ---------------------------------------------------
  // Diff old vs new text by common prefix/suffix; delete the changed middle of
  // the old text, insert the changed middle of the new text. Character-granular,
  // which is all a plaintext demo needs.
  function diffToOps(oldStr, newStr) {
    let p = 0;
    const maxP = Math.min(oldStr.length, newStr.length);
    while (p < maxP && oldStr[p] === newStr[p]) p++;
    let s = 0;
    while (s < maxP - p && oldStr[oldStr.length - 1 - s] === newStr[newStr.length - 1 - s]) s++;

    const ops = [];
    // Delete old middle: chars [p, oldStr.length - s), removed from the front so
    // the index p stays valid as we go.
    const delCount = oldStr.length - s - p;
    for (let i = 0; i < delCount; i++) {
      const op = doc.deleteAt(p);
      if (op) ops.push(op);
    }
    // Insert new middle: chars [p, newStr.length - s).
    const insert = newStr.slice(p, newStr.length - s);
    for (let i = 0; i < insert.length; i++) {
      ops.push(doc.insertAt(p + i, insert[i]));
    }
    return ops;
  }

  editor.addEventListener('input', () => {
    const newText = editor.value;
    const ops = diffToOps(lastText, newText);
    lastText = doc.text();
    // Keep the textarea authoritative for the local user's own edit.
    if (editor.value !== lastText) editor.value = lastText;
    if (ops.length) send(ops);
  });

  // ---- remote ops → textarea ----------------------------------------------
  function applyRemote(ops) {
    const before = editor.selectionStart;
    const beforeText = doc.text();
    for (const op of ops) doc.apply(op);
    const after = doc.text();
    lastText = after;

    // Preserve the caret: shift it by the net change that occurred at or before
    // the caret. Cheap heuristic (exact cursor transformation is Phase 3).
    let caret = before;
    const delta = after.length - beforeText.length;
    if (delta !== 0) caret = Math.max(0, Math.min(after.length, before + delta));
    editor.value = after;
    editor.setSelectionRange(caret, caret);
  }

  connect();
})();
