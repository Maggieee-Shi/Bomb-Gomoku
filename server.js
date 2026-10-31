const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const N = 15; // board size
const BOMBS = 12; // hidden bombs per game
const RPS_CHANCE = 6; // Spook challenges 1 in this many moves
const PICKS = ['rock', 'paper', 'scissors'];
const BEATS = { rock: 'scissors', paper: 'rock', scissors: 'paper' };
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
  // Hide bombs on random empty cells (never on the center, so the opening move is safe)
  room.bombs = new Set();
  while (room.bombs.size < BOMBS) {
    const i = crypto.randomInt(N * N);
    if (i !== Math.floor(N * N / 2)) room.bombs.add(i);
  }
  if (process.env.TEST_BOMBS) room.bombs = new Set(process.env.TEST_BOMBS.split(',').map(Number)); // for local testing
  room.event = null;
  room.shielded = new Set();
  room.challenge = null;
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
      bombsLeft: room.bombs ? room.bombs.size : 0,
      // bomb positions stay secret until the game ends
      bombs: room.status === 'finished' && room.bombs ? [...room.bombs] : [],
      shielded: room.shielded ? [...room.shielded] : [],
      challenge: room.challenge ? { id: room.challenge.id, forYou: room.challenge.by === me.id, byName: room.players.get(room.challenge.by)?.name, index: room.challenge.index, ties: room.challenge.ties } : null,
      event: room.event ? { ...room.event, byYou: room.event.by === me.id, byName: room.players.get(room.event.by)?.name } : null,
    });
  }
}

function placeStone(room, me, i, shield) {
  const color = colorOf(room, me.id);
  const next = color === 1 ? 2 : 1;
  if (shield) room.shielded.add(i);
  if (room.bombs.has(i)) {
    // Boom: everything within range is blown away, except shielded stones. Unshielded, the placed stone goes too and the turn passes.
    room.bombs.delete(i);
    // Blast area: a random 1x1, 2x2 or 3x3 square that always contains the bomb cell
    const size = 1 + crypto.randomInt(3);
    const r0 = Math.floor(i / N), c0 = i % N;
    const clamp = (v) => Math.max(0, Math.min(N - size, v));
    const top = clamp(r0 - crypto.randomInt(size)), left = clamp(c0 - crypto.randomInt(size));
    const cleared = [];
    let saved = 0;
    if (shield) { room.board[i] = color; saved++; } else cleared.push([i, color]);
    for (let r = top; r < top + size; r++) {
      for (let c = left; c < left + size; c++) {
        const j = r * N + c;
        if (j === i || !room.board[j]) continue;
        if (room.shielded.has(j)) { saved++; continue; }
        cleared.push([j, room.board[j]]); room.board[j] = 0;
      }
    }
    room.eventSeq = (room.eventSeq || 0) + 1;
    room.event = { id: room.eventSeq, type: 'bomb', at: i, area: { top, left, size }, by: me.id, cleared, saved, shieldedHit: shield };
    room.lastMove = shield ? i : -1;
    if (!shield) { room.turn = next; return; }
  } else {
    room.board[i] = color;
    room.lastMove = i;
  }
  const line = findFive(room.board, i);
  if (line) {
    room.status = 'finished'; room.winnerId = me.id; room.reason = 'five'; room.winLine = line; me.wins += 1;
  } else if (room.board.every(Boolean)) {
    room.status = 'finished'; room.reason = 'draw';
  } else {
    room.turn = next;
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
        if (!room || !me || room.status !== 'playing' || room.challenge) return;
        const color = colorOf(room, me.id);
        const i = msg.index | 0;
        if (room.turn !== color || i < 0 || i >= N * N || room.board[i]) return;
        const forced = process.env.TEST_RPS === 'always'; // for local testing
        if (process.env.TEST_RPS !== 'never' && (forced || crypto.randomInt(RPS_CHANCE) === 0)) {
          // Spook appears: win rock-paper-scissors to place this stone
          room.eventSeq = (room.eventSeq || 0) + 1;
          room.challenge = { id: room.eventSeq, by: me.id, index: i, ties: 0 };
          return broadcast(room);
        }
        placeStone(room, me, i, false);
        return broadcast(room);
      }
      case 'rps': {
        const ch = room && room.challenge;
        if (!ch || !me || ch.by !== me.id || room.status !== 'playing' || !PICKS.includes(msg.pick)) return;
        const ghost = PICKS.includes(process.env.TEST_GHOST) ? process.env.TEST_GHOST : PICKS[crypto.randomInt(3)];
        const outcome = msg.pick === ghost ? 'tie' : BEATS[msg.pick] === ghost ? 'win' : 'lose';
        room.eventSeq += 1;
        room.event = { id: room.eventSeq, type: 'rps', by: me.id, pick: msg.pick, ghost, outcome, index: ch.index };
        if (outcome === 'tie') { ch.ties += 1; return broadcast(room); }
        room.challenge = null;
        if (outcome === 'lose') {
          room.turn = colorOf(room, me.id) === 1 ? 2 : 1;
        } else {
          placeStone(room, me, ch.index, true);
          // if the stone landed on a bomb, the bomb event carries the rock-paper-scissors result along
          if (room.event.type === 'bomb') room.event.rps = { pick: msg.pick, ghost, outcome };
        }
        return broadcast(room);
      }
      case 'concede': {
        if (!room || !me || room.status !== 'playing') return;
        const opp = other(room, me.id);
        if (!opp) return;
        room.challenge = null;
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
