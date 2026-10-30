const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const N = 15; // board size
const PUBLIC = path.join(__dirname, 'public');
const INDEX = path.join(PUBLIC, 'index.html');

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/health') { res.writeHead(200); return res.end('ok'); }
  fs.readFile(INDEX, (err, data) => {
    res.writeHead(err ? 500 : 200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(data || 'Server error');
  });
});

/**
 * room = {
 *   id, status: 'waiting'|'playing'|'finished',
 *   board: number[N*N] (0 empty, 1 black, 2 white), turn: 1|2, lastMove,
 *   winnerId, reason: 'five'|'concede'|'draw', winLine: number[],
 *   round, blackId, lastActive, players: Map<clientId, { id, name, ws, wins }>
 * }
 */
const rooms = new Map();
const ALPH = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function newRoomId() {
  let id;
  do { id = Array.from(crypto.randomBytes(6), b => ALPH[b % ALPH.length]).join(''); } while (rooms.has(id));
  return id;
}
const cleanName = (n) => String(n || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 20) || 'Player';
const online = (p) => !!(p && p.ws && p.ws.readyState === 1);
const colorOf = (room, id) => (room.blackId === id ? 1 : 2);
const other = (room, id) => [...room.players.values()].find(p => p.id !== id);

function startRound(room) {
  const ids = [...room.players.keys()];
  // Round 1: the host plays black (moves first). After that, colors swap each round.
  if (room.round === 0) room.blackId = ids[0];
  else room.blackId = ids.find(id => id !== room.blackId);
  room.board = new Array(N * N).fill(0);
  room.turn = 1;
  room.lastMove = -1;
  room.status = 'playing';
  room.winnerId = null;
  room.reason = null;
  room.winLine = [];
  room.round += 1;
}

function findFive(board, idx) {
  const color = board[idx];
  const r0 = Math.floor(idx / N), c0 = idx % N;
  for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
    const line = [idx];
    for (const s of [1, -1]) {
      let r = r0 + dr * s, c = c0 + dc * s;
      while (r >= 0 && r < N && c >= 0 && c < N && board[r * N + c] === color) {
        line.push(r * N + c);
        r += dr * s; c += dc * s;
      }
    }
    if (line.length >= 5) return line;
  }
  return null;
}

function send(ws, msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }

function broadcast(room) {
  room.lastActive = Date.now();
  for (const me of room.players.values()) {
    const opp = other(room, me.id);
    const myColor = room.status === 'waiting' ? 1 : colorOf(room, me.id);
    send(me.ws, {
      type: 'state',
      room: room.id,
      size: N,
      status: room.status,
      round: room.round,
      board: room.board || null,
      turn: room.turn,
      lastMove: room.lastMove,
      myColor,
      yourTurn: room.status === 'playing' && room.turn === myColor,
      me: { name: me.name, wins: me.wins },
      opponent: opp ? { name: opp.name, wins: opp.wins, online: online(opp) } : null,
      winner: room.winnerId ? room.players.get(room.winnerId)?.name : null,
      youWon: room.winnerId ? room.winnerId === me.id : null,
      reason: room.reason,
      winLine: room.winLine || [],
    });
  }
}

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  let room = null, me = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const clientId = String(msg.clientId || '').slice(0, 64);

    switch (msg.type) {
      case 'create': {
        if (!clientId) return;
        room = { id: newRoomId(), status: 'waiting', round: 0, players: new Map(), lastActive: Date.now() };
        rooms.set(room.id, room);
        me = { id: clientId, name: cleanName(msg.name), ws, wins: 0 };
        room.players.set(clientId, me);
        return broadcast(room);
      }
      case 'join': {
        const r = rooms.get(String(msg.room || '').toUpperCase());
        if (!r) return send(ws, { type: 'error', code: 'not_found', message: 'That game does not exist. It may have expired.' });
        if (!clientId) return;
        const existing = r.players.get(clientId);
        if (existing) {
          if (existing.ws && existing.ws !== ws) send(existing.ws, { type: 'error', code: 'replaced', message: 'You opened this game in another tab.' });
          existing.ws = ws;
          if (msg.name) existing.name = cleanName(msg.name);
          me = existing;
        } else {
          if (r.players.size >= 2) return send(ws, { type: 'error', code: 'full', message: 'This game already has two players.' });
          me = { id: clientId, name: cleanName(msg.name), ws, wins: 0 };
          r.players.set(clientId, me);
          if (r.status === 'waiting') startRound(r);
        }
        room = r;
        return broadcast(room);
      }
      case 'rename': {
        if (!room || !me) return;
        me.name = cleanName(msg.name);
        return broadcast(room);
      }
      case 'move': {
        if (!room || !me || room.status !== 'playing') return;
        const color = colorOf(room, me.id);
        const i = msg.index | 0;
        if (room.turn !== color || i < 0 || i >= N * N || room.board[i]) return;
        room.board[i] = color;
        room.lastMove = i;
        const line = findFive(room.board, i);
        if (line) {
          room.status = 'finished'; room.winnerId = me.id; room.reason = 'five'; room.winLine = line; me.wins += 1;
        } else if (room.board.every(Boolean)) {
          room.status = 'finished'; room.reason = 'draw';
        } else {
          room.turn = color === 1 ? 2 : 1;
        }
        return broadcast(room);
      }
      case 'concede': {
        if (!room || !me || room.status !== 'playing') return;
        const opp = other(room, me.id);
        if (!opp) return;
        room.status = 'finished'; room.winnerId = opp.id; room.reason = 'concede'; opp.wins += 1;
        return broadcast(room);
      }
      case 'restart': {
        if (!room || !me || room.status !== 'finished' || room.players.size < 2) return;
        startRound(room);
        return broadcast(room);
      }
    }
  });

  ws.on('close', () => {
    if (room && me && me.ws === ws) { me.ws = null; broadcast(room); }
  });
});

// Drop rooms idle for 6 hours with nobody connected
setInterval(() => {
  const cutoff = Date.now() - 6 * 3600e3;
  for (const [id, r] of rooms) {
    if (r.lastActive < cutoff && ![...r.players.values()].some(online)) rooms.delete(id);
  }
}, 10 * 60e3).unref();

// Keep connections alive behind proxies
setInterval(() => { for (const c of wss.clients) if (c.readyState === 1) c.ping(); }, 25e3).unref();

server.listen(PORT, () => console.log(`Gomoku listening on :${PORT}`));
