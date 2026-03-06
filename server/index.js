const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 4000;

let queue = [];
const pairs = new Map();

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

  socket.on('disconnect', () => {
    removeFromQueue(socket.id);
    unpairSocket(socket.id, true);
  });
});

app.get('/', (req, res) => res.send('TalkNow signalling server'));

server.listen(PORT, () => console.log(`Signalling server listening on ${PORT}`));
