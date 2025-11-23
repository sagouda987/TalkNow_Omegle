const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 4000;

let queue = [];
const pairs = new Map();

function pairUsers() {
  while (queue.length >= 2) {
    const a = queue.shift();
    const b = queue.shift();
    const matchId = `${a.id}-${b.id}-${Date.now()}`;
    pairs.set(matchId, { a: a.id, b: b.id });
    io.to(a.id).emit('matched', { matchId, peer: b.id });
    io.to(b.id).emit('matched', { matchId, peer: a.id });
  }
}

io.on('connection', (socket) => {
  console.log('socket connected', socket.id);

  socket.on('find', () => {
    queue.push(socket);
    socket.emit('searching');
    pairUsers();
  });

  socket.on('cancel', () => {
    queue = queue.filter(q => q.id !== socket.id);
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
    queue = queue.filter(q => q.id !== socket.id);
    for (const [matchId, pair] of pairs.entries()) {
      if (pair.a === socket.id || pair.b === socket.id) {
        const peer = pair.a === socket.id ? pair.b : pair.a;
        io.to(peer).emit('peer-disconnected');
        pairs.delete(matchId);
      }
    }
  });
});

app.get('/', (req, res) => res.send('TalkNow signalling server'));

server.listen(PORT, () => console.log(`Signalling server listening on ${PORT}`));
