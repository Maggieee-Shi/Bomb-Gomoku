const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { generate } = require('./sudoku');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/health') { res.writeHead(200); return res.end('ok'); }
  let file = url.pathname === '/' ? '/index.html' : url.pathname;
  file = path.normalize(file).replace(/^(\.\.[/\\])+/, '');
  const full = path.join(PUBLIC, file);
  if (!full.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(full, (err, data) => {
    if (err) {
      // SPA fallback
      return fs.readFile(path.join(PUBLIC, 'index.html'), (e2, d2) => {
        res.writeHead(e2 ? 404 : 200, { 'Content-Type': TYPES['.html'] });
        res.end(d2 || 'Not found');
      });
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(full)] || 'application/octet-stream' });
    res.end(data);
  });
});

/**
 * room = {
 *   id, ownerId, status: 'waiting'|'playing'|'finished', difficulty,
 *   puzzle, solution, winnerId, reason, round, lastActive,
 *   players: Map<clientId, { id, name, board, ws, wins }>
 * }
 */
const rooms = new Map();

function newRoomId() {
  let id;
  do { id = crypto.randomBytes(4).toString('base64url').replace(/[-_]/g, '').slice(0, 6).toUpperCase(); }
  while (id.length < 6 || rooms.has(id));
  return id;
}

function cleanName(n) {
  return String(n || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 20) || 'Player';
}

function startRound(room) {
  const { puzzle, solution } = generate(room.difficulty);
  room.puzzle = puzzle;
  room.solution = solution;
  room.status = 'playing';
  room.winnerId = null;
  room.reason = null;
  room.round += 1;
  room.startedAt = Date.now();
  for (const p of room.players.values()) p.board = puzzle.slice();
}

function filledCount(room, p) {
  if (!room.puzzle) return 0;
  let n = 0;
  for (let i = 0; i < 81; i++) if (!room.puzzle[i] && p.board[i]) n++;
  return n;
}

function emptyCount(room) {
  return room.puzzle ? room.puzzle.filter(v => !v).length : 0;
}

function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function broadcast(room) {
  room.lastActive = Date.now();
  for (const me of room.players.values()) {
    const opp = [...room.players.values()].find(p => p.id !== me.id);
    send(me.ws, {
      type: 'state',
      room: room.id,
      isOwner: room.ownerId === me.id,
      status: room.status,
      difficulty: room.difficulty,
      round: room.round,
      puzzle: room.puzzle,
      board: me.board,
      empties: emptyCount(room),
      me: { name: me.name, wins: me.wins, filled: filledCount(room, me) },
      opponent: opp ? { name: opp.name, wins: opp.wins, filled: filledCount(room, opp), online: !!(opp.ws && opp.ws.readyState === 1) } : null,
      winner: room.winnerId ? room.players.get(room.winnerId)?.name : null,
      youWon: room.winnerId ? room.winnerId === me.id : null,
      reason: room.reason,
      // reveal solution only after the round ends
      solution: room.status === 'finished' ? room.solution : null,
    });
  }
}

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  let room = null;
  let me = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const clientId = String(msg.clientId || '').slice(0, 64);

    switch (msg.type) {
      case 'create': {
        if (!clientId) return;
        const id = newRoomId();
        room = { id, ownerId: clientId, status: 'waiting', difficulty: ['easy', 'medium', 'hard'].includes(msg.difficulty) ? msg.difficulty : 'medium', round: 0, players: new Map(), lastActive: Date.now() };
        rooms.set(id, room);
        me = { id: clientId, name: cleanName(msg.name), board: [], ws, wins: 0 };
        room.players.set(clientId, me);
        broadcast(room);
        break;
      }
      case 'join': {
        const r = rooms.get(String(msg.room || '').toUpperCase());
        if (!r) return send(ws, { type: 'error', code: 'not_found', message: 'That game does not exist (it may have expired).' });
        if (!clientId) return;
        const existing = r.players.get(clientId);
        if (existing) {
          // reconnect to own seat
          if (existing.ws && existing.ws !== ws) send(existing.ws, { type: 'error', code: 'replaced', message: 'You opened this game in another tab.' });
          existing.ws = ws;
          if (msg.name) existing.name = cleanName(msg.name);
          me = existing;
        } else {
          if (r.players.size >= 2) return send(ws, { type: 'error', code: 'full', message: 'This game already has two players.' });
          me = { id: clientId, name: cleanName(msg.name), board: [], ws, wins: 0 };
          r.players.set(clientId, me);
          if (r.status === 'waiting') startRound(r);
        }
        room = r;
        broadcast(room);
        break;
      }
      case 'rename': {
        if (!room || !me) return;
        me.name = cleanName(msg.name);
        broadcast(room);
        break;
      }
      case 'move': {
        if (!room || !me || room.status !== 'playing') return;
        const i = msg.index | 0, v = msg.value | 0;
        if (i < 0 || i > 80 || v < 0 || v > 9 || room.puzzle[i]) return;
        me.board[i] = v;
        if (me.board.every((x, k) => x === room.solution[k])) {
          room.status = 'finished';
          room.winnerId = me.id;
          room.reason = 'solved';
          me.wins += 1;
        }
        broadcast(room);
        break;
      }
      case 'concede': {
        if (!room || !me || room.status !== 'playing') return;
        const opp = [...room.players.values()].find(p => p.id !== me.id);
        if (!opp) return;
        room.status = 'finished';
        room.winnerId = opp.id;
        room.reason = 'concede';
        opp.wins += 1;
        broadcast(room);
        break;
      }
      case 'restart': {
        if (!room || !me || room.status !== 'finished' || room.players.size < 2) return;
        if (['easy', 'medium', 'hard'].includes(msg.difficulty)) room.difficulty = msg.difficulty;
        startRound(room);
        broadcast(room);
        break;
      }
    }
  });

  ws.on('close', () => {
    if (room && me && me.ws === ws) {
      me.ws = null;
      broadcast(room);
    }
  });
});

// Drop rooms idle for 6 hours
setInterval(() => {
  const cutoff = Date.now() - 6 * 3600e3;
  for (const [id, r] of rooms) {
    const anyOnline = [...r.players.values()].some(p => p.ws && p.ws.readyState === 1);
    if (!anyOnline && r.lastActive < cutoff) rooms.delete(id);
  }
}, 10 * 60e3).unref();

// Keep connections alive behind proxies
setInterval(() => {
  for (const c of wss.clients) if (c.readyState === 1) c.ping();
}, 25e3).unref();

server.listen(PORT, () => console.log(`Sudoku Duel listening on :${PORT}`));
