'use strict';

// Phase 3 browser client: SyncDoc over the hub protocol (hello → sync → push +
// live updates), plus ephemeral awareness for live cursors. Includes an
// offline toggle so you can feel delta sync on reconnect.

(function () {
  const params = new URLSearchParams(location.search);
  const room = params.get('room') || 'default';
  const replicaId = params.get('id') || 'r' + Math.floor(Math.random() * 1e6).toString(36);
  const color = '#' + ((Math.floor(Math.random() * 0xffffff) | 0x404040) & 0xbfbfbf).toString(16).padStart(6, '0');

  document.getElementById('replica').textContent = replicaId;
  document.getElementById('room').textContent = room;
  const statusEl = document.getElementById('status');
  const editor = document.getElementById('editor');
  const peersEl = document.getElementById('peers');
  const toggleBtn = document.getElementById('toggle');

  const doc = new SyncDoc(replicaId);
  const aw = new Awareness(replicaId);
  let lastText = '';
  let socket = null;
  let wantOnline = true;

  // ---- transport / protocol ------------------------------------------------
  function connect() {
    if (!wantOnline) return;
    socket = new WebSocket(`ws://${location.host}/?room=${encodeURIComponent(room)}`);
    socket.onopen = () => {
      statusEl.textContent = 'online';
      socket.send(JSON.stringify({ type: 'hello', vv: doc.stateVector() }));
      broadcastCursor();
    };
    socket.onclose = () => {
      statusEl.textContent = 'offline';
      if (wantOnline) setTimeout(connect, 800);
    };
    socket.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'sync') {
        doc.integrate(msg.ops);
        const push = doc.delta(msg.vv);
        if (push.length) socket.send(JSON.stringify({ type: 'update', ops: push }));
        render();
      } else if (msg.type === 'update') {
        doc.integrate(msg.ops);
        render();
      } else if (msg.type === 'awareness') {
        aw.receive(msg, Date.now());
        renderPeers();
      }
    };
  }
  function send(obj) {
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(obj));
  }

  toggleBtn.onclick = () => {
    wantOnline = !wantOnline;
    toggleBtn.textContent = wantOnline ? 'Go offline' : 'Go online';
    if (wantOnline) connect();
    else if (socket) socket.close();
  };

  // ---- local edits → ops (prefix/suffix diff, same as Phase 2) -------------
  function diffToOps(oldStr, newStr) {
    let p = 0;
    const maxP = Math.min(oldStr.length, newStr.length);
    while (p < maxP && oldStr[p] === newStr[p]) p++;
    let s = 0;
    while (s < maxP - p && oldStr[oldStr.length - 1 - s] === newStr[newStr.length - 1 - s]) s++;
    const ops = [];
    const delCount = oldStr.length - s - p;
    for (let i = 0; i < delCount; i++) {
      const op = doc.deleteAt(p);
      if (op) ops.push(op);
    }
    const ins = newStr.slice(p, newStr.length - s);
    for (let i = 0; i < ins.length; i++) ops.push(doc.insertAt(p + i, ins[i]));
    return ops;
  }

  editor.addEventListener('input', () => {
    const ops = diffToOps(lastText, editor.value);
    lastText = doc.text();
    if (editor.value !== lastText) editor.value = lastText;
    if (ops.length) send({ type: 'update', ops }); // queued naturally: no socket ⇒ pushed on reconnect
    broadcastCursor();
  });
  editor.addEventListener('keyup', broadcastCursor);
  editor.addEventListener('click', broadcastCursor);

  // ---- presence ------------------------------------------------------------
  function broadcastCursor() {
    const msg = aw.setLocal({ cursor: editor.selectionStart, name: replicaId, color });
    send(msg);
  }
  function renderPeers() {
    const peers = aw.peers(Date.now());
    peersEl.innerHTML = '';
    for (const [id, st] of Object.entries(peers)) {
      const span = document.createElement('span');
      span.className = 'peer';
      span.style.background = st.color || '#888';
      span.textContent = `${st.name || id} @ ${st.cursor ?? '?'}`;
      peersEl.appendChild(span);
    }
  }

  function render() {
    const before = editor.selectionStart;
    const beforeLen = lastText.length;
    const after = doc.text();
    lastText = after;
    const delta = after.length - beforeLen;
    editor.value = after;
    const caret = Math.max(0, Math.min(after.length, before + (delta > 0 ? 0 : 0)));
    editor.setSelectionRange(caret, caret);
    renderPeers();
  }

  setInterval(renderPeers, 5000); // expire stale peers
  connect();
})();
