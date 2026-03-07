const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 4000;
const LIVE_ROOM = 'live:community';
const LIVE_HISTORY_LIMIT = 250;
const LIVE_BOT_MIN_DELAY_MS = 1200;
const LIVE_BOT_MAX_DELAY_MS = 2600;
const LIVE_BLOCK_WORDS = ['fuck', 'shit', 'bitch', 'asshole', 'cunt', 'porn', 'nude'];
const LIVE_LINK_PATTERN = /(https?:\/\/[^\s]+)/i;
const LIVE_BOT_NAMES = [
  'Stranger_12', 'Stranger_19', 'Stranger_27', 'Stranger_35', 'Stranger_44', 'Stranger_58',
  'Stranger_63', 'Stranger_71', 'Stranger_84', 'Stranger_93', 'Stranger_107', 'Stranger_118',
  'Stranger_126', 'Stranger_139', 'Stranger_144', 'Stranger_152', 'Stranger_166', 'Stranger_173',
  'Stranger_181', 'Stranger_194', 'Stranger_205', 'Stranger_216', 'Stranger_229', 'Stranger_237'
];
const LIVE_BOT_LINES = [
  'Hello everyone.',
  'Anyone from India online?',
  'Let us keep this chat respectful.',
  'Who is still awake right now?',
  'Nice to meet you all.',
  'How is everyone doing tonight?',
  'Any gamers here?',
  'Music recommendations?',
  'This room feels active.',
  'Good vibes only please.',
  'Who is still online right now?',
  'Where are you chatting from?',
  'Anyone wants to practice English?',
  'This room is moving fast today.',
  'Reminder: keep chat clean and friendly.',
  'Any students in the room?',
  'Anyone into movies?',
  'Any football fans here?',
  'Any cricket fans online?',
  'Random question: tea or coffee?',
  'Who else is new here?',
  'Any developers online?',
  'How is your weekend going?',
  'Is your mic working properly?',
  'Send a hello if you are active.',
  'Anyone from Europe online?',
  'Anyone from the US online?',
  'Who likes late-night chats?',
  'Drop your favorite song genre.'
];
let queue = [];
const pairs = new Map();
const liveHistory = [];
let liveBotTimerRef = null;
const liveRecentBotLines = [];
const liveRecentBotNames = [];

function emitOnlineCount() {
  io.emit('online', io.engine.clientsCount || 0);
}

function sanitizeLiveText(raw) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/\s+/g, ' ').trim().slice(0, 220);
}

function makeLiveMessage({ from, text, type = 'stranger', senderId = null }) {
  return {
    id: `live-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    from,
    text,
    type,
    senderId,
    ts: Date.now()
  };
}

function pushLiveMessage(entry) {
  if (!entry || !entry.text) return;
  const msg = makeLiveMessage(entry);
  liveHistory.push(msg);
  if (liveHistory.length > LIVE_HISTORY_LIMIT) {
    liveHistory.splice(0, liveHistory.length - LIVE_HISTORY_LIMIT);
  }
  io.to(LIVE_ROOM).emit('live:message', msg);
}

function pickNoRecent(pool, recentList, recentWindow = 8) {
  const filtered = pool.filter((item) => !recentList.includes(item));
  const source = filtered.length ? filtered : pool;
  const picked = source[Math.floor(Math.random() * source.length)];
  recentList.push(picked);
  if (recentList.length > recentWindow) recentList.shift();
  return picked;
}

function sendLiveSystemMessage(socket, text) {
  socket.emit('live:message', makeLiveMessage({ from: 'System', text, type: 'system' }));
}

function seedLiveHistory() {
  const seedLines = [
    'Welcome to live community chat.',
    'Be respectful and keep the chat clean.',
    'No links or explicit content.'
  ];
  seedLines.forEach((text, i) => {
    liveHistory.push({
      id: `live-seed-${i + 1}`,
      from: LIVE_BOT_NAMES[i % LIVE_BOT_NAMES.length],
      text,
      type: 'bot',
      senderId: null,
      ts: Date.now() - ((seedLines.length - i) * 2000)
    });
  });
}

function startLiveBots() {
  if (liveBotTimerRef) return;
  const loop = () => {
    const delay = LIVE_BOT_MIN_DELAY_MS + Math.floor(Math.random() * (LIVE_BOT_MAX_DELAY_MS - LIVE_BOT_MIN_DELAY_MS + 1));
    liveBotTimerRef = setTimeout(() => {
      const from = pickNoRecent(LIVE_BOT_NAMES, liveRecentBotNames, 6);
      const text = pickNoRecent(LIVE_BOT_LINES, liveRecentBotLines, 12);
      pushLiveMessage({ from, text, type: 'bot' });
      loop();
    }, delay);
  };
  loop();
}

function removeFromQueue(socketId) {
  queue = queue.filter((q) => q.id !== socketId);
}

function isSocketPaired(socketId) {
  for (const pair of pairs.values()) {
    if (pair.a === socketId || pair.b === socketId) return true;
  }
  return false;
}

function unpairSocket(socketId, notifyPeer = false) {
  for (const [matchId, pair] of pairs.entries()) {
    if (pair.a === socketId || pair.b === socketId) {
      const peer = pair.a === socketId ? pair.b : pair.a;
      pairs.delete(matchId);
      if (notifyPeer && peer) io.to(peer).emit('peer-disconnected');
    }
  }
}

function pairUsers() {
  while (queue.length >= 2) {
    const a = queue.shift();
    const b = queue.shift();

    if (!a?.connected || !b?.connected) continue;
    if (a.id === b.id) {
      if (a.connected) queue.push(a);
      continue;
    }
    if (isSocketPaired(a.id) || isSocketPaired(b.id)) {
      if (!isSocketPaired(a.id) && a.connected) queue.push(a);
      if (!isSocketPaired(b.id) && b.connected) queue.push(b);
      continue;
    }

    const matchId = `${a.id}-${b.id}-${Date.now()}`;
    pairs.set(matchId, { a: a.id, b: b.id });
    io.to(a.id).emit('matched', { matchId, peer: b.id });
    io.to(b.id).emit('matched', { matchId, peer: a.id });
  }
}

io.on('connection', (socket) => {
  console.log('socket connected', socket.id);
  socket.join(LIVE_ROOM);
  socket.emit('live:history', liveHistory.slice(-120));
  emitOnlineCount();

  socket.on('find', () => {
    removeFromQueue(socket.id);
    unpairSocket(socket.id, true);
    queue.push(socket);
    socket.emit('searching');
    pairUsers();
  });

  socket.on('cancel', () => {
    removeFromQueue(socket.id);
    unpairSocket(socket.id, true);
    socket.emit('cancelled');
  });

  socket.on('sig', (payload) => {
    const to = payload.to;
    if (to) io.to(to).emit('sig', { from: socket.id, type: payload.type, data: payload.data });
  });

  socket.on('text', ({ to, message }) => {
    if (to) io.to(to).emit('text', { from: socket.id, message });
  });

  socket.on('presence', () => {
    emitOnlineCount();
  });

  socket.on('live:send', ({ text }) => {
    const cleaned = sanitizeLiveText(text);
    if (!cleaned) return;

    if (LIVE_LINK_PATTERN.test(cleaned)) {
      sendLiveSystemMessage(socket, 'Live chat: links are not allowed.');
      return;
    }
    const lowered = cleaned.toLowerCase();
    if (LIVE_BLOCK_WORDS.some((w) => lowered.includes(w))) {
      sendLiveSystemMessage(socket, 'Live chat: message blocked by moderation.');
      return;
    }

    pushLiveMessage({
      from: `Stranger_${socket.id.slice(0, 4)}`,
      text: cleaned,
      type: 'user',
      senderId: socket.id
    });
  });

  socket.on('disconnect', () => {
    removeFromQueue(socket.id);
    unpairSocket(socket.id, true);
    emitOnlineCount();
  });
});

app.get('/', (req, res) => res.send('TalkNow signalling server'));

seedLiveHistory();
startLiveBots();
server.listen(PORT, () => console.log(`Signalling server listening on ${PORT}`));
