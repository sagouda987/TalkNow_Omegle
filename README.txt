TalkNow — Local Full Project (Frontend + Signalling Server)

Structure:
- client/  (Vite + React frontend)
- server/  (Node + Express + Socket.io signalling server)

Run frontend:
1. cd client
2. npm install
3. npm run dev
Open the URL shown by Vite (e.g. http://localhost:5173).

Run server:
1. cd server
2. npm install
3. npm start
Server listens on port 4000 by default.

Notes:
- The frontend provided is a UI preview and does not yet connect to the signalling server automatically.
- If you'd like, I can update the frontend to connect to the signalling server (add socket.io-client and WebRTC signalling).

