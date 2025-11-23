// src/App.jsx
// TalkNow — automatic Real matchmaking with fallback fake preview
// Requirements: `npm install socket.io-client` in client folder
// SIGNAL_URL should point to your signalling server (default: http://localhost:4000)

import React, { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';

const SIGNAL_URL = import.meta.env.VITE_SIGNAL_URL || 'http://localhost:4000';

export default function App() {
  // --- app state
  const [state, setState] = useState('idle'); // idle | searching | matched | connected
  const [matchName, setMatchName] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');

  // DOM & realtime refs
  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);

  const socketRef = useRef(null);
  const pcRef = useRef(null);
  const dcRef = useRef(null);
  const localStreamRef = useRef(null);
  const remoteStreamRef = useRef(null);
  const peerIdRef = useRef(null);
  const selfIdRef = useRef(null);

  // fallback / fake-preview helpers when real matchmaking takes too long
  const fallbackTimerRef = useRef(null);
  const fakePreviewRef = useRef({}); // { local: {interval,stream}, remote: {interval,stream} }
  const fakeFallbackActive = useRef(false);
  const fakeSessionTimerRef = useRef(null);

  // inject styles once
  useEffect(() => {
const css = `
:root { font-family: Inter, Arial, sans-serif; }
html, body, #root { height: 100%; margin: 0; }
body { background:#f3f4f6; color:#111827; }


.app-root { min-height:100vh; box-sizing:border-box; padding:20px; width:100%; display:flex; flex-direction:column; gap:18px; }


.header { display:flex; justify-content:space-between; align-items:center; gap:12px; }
.header h1 { margin:0; font-size:20px; }
.sub { font-size:13px; color:#666; white-space:nowrap; }

.layout {
display:grid;
grid-template-columns: 1fr 360px;
gap:16px;
align-items:start;
width:200%;
flex:1;
transform: translateX(-200px); /* shifted more left */
}
@media (max-width:980px) { .layout { grid-template-columns: 1fr; } .sidebar { width:100%; } }


.main-card { background:#fff; border-radius:12px; padding:14px; box-shadow:0 6px 18px rgba(20,20,50,0.06); display:flex; flex-direction:column; gap:12px; height:100%; }


.controls { display:flex; gap:10px; align-items:center; }
.btn { padding:8px 12px; border-radius:10px; background:#0b84ff; color:#fff; border:none; cursor:pointer; }
.btn-ghost { margin-left:8px; background:#eee; color:#333; }
.status { margin-left:auto; display:flex; gap:8px; align-items:center; }


.media-and-chat { display:flex; gap:12px; flex:1; min-height:0; }


.media-panel { flex:1; border-radius:10px; overflow:hidden; background:#111827; padding:12px; display:flex; flex-direction:column; gap:12px; min-height:0; }


.videos { display:flex; gap:12px; flex: 1 1 auto; min-height:0; }


.local, .remote { flex:1; display:flex; flex-direction:column; gap:8px; min-height:0; }


.caption { font-size:12px; color:#ddd; margin-bottom:4px; }


.video { width:100%; height:100%; border-radius:10px; background:#000; object-fit:cover; display:block; min-height:180px; }


.chat-section { width:360px; max-width:360px; display:flex; flex-direction:column; gap:8px; }
@media (max-width:980px) { .chat-section { width:100%; max-width:100%; } }


.chat-header { display:flex; justify-content:space-between; align-items:center; }
.chat-title { color:#bbb; }
.btn-report { font-size:12px; padding:6px 10px; border-radius:8px; background:#ffecec; border:1px solid #f5c2c2; }


.chat-window { margin-top:8px; height:220px; overflow:auto; padding:10px; background:rgba(255,255,255,0.02); border-radius:8px; }
.empty { color:#9aa; font-size:13px; }


.msg { margin-bottom:8px; }
.msg .from { font-size:12px; color:#8f8f8f; }
.msg .bubble { display:inline-block; padding:8px 10px; border-radius:8px; margin-top:4px; max-width:85%; word-wrap:break-word; }
.msg-out .bubble { background:#d1ffe0; }
.msg-in .bubble {
background:#ffffffcc; /* light background */
.msg-system .bubble { background:#fff3c4; }


.chat-input { display:flex; gap:8px; margin-top:8px; }
.chat-input input { flex:1; padding:10px 12px; border-radius:8px; border:1px solid #ddd; background:#fff; }


.sidebar { width:320px; display:flex; flex-direction:column; gap:12px; }
.card { padding:12px; border-radius:10px; background:#fff; box-shadow:0 6px 18px rgba(20,20,50,0.06); }
.peer-name { font-size:13px; font-weight:700; }
.peer-status { font-size:12px; color:#666; margin-top:6px; }
.tips { margin-top:10px; font-size:12px; color:#444; }
`;
const style = document.createElement('style');
style.dataset.owner = 'talknow-singlefile';
style.appendChild(document.createTextNode(css));
document.head.appendChild(style);
return () => document.head.removeChild(style);
}, []);

  // ----------------- FAKE preview helpers -----------------
  const NAMES = ['Aisha', 'Carlos', 'Priya', 'Omar', 'Lina', 'John', 'Sana', 'Ravi'];

  function createCanvasStream(el, label) {
    const c = document.createElement('canvas'); c.width = 320; c.height = 240;
    const ctx = c.getContext('2d'); let t = 0;
    const id = setInterval(() => {
      t += 0.04;
      const d = Math.floor(50 + 20 * Math.sin(t * 2));
      ctx.fillStyle = `rgb(${120 + d}, ${90 + d}, ${200 - d})`;
      ctx.fillRect(0, 0, c.width, c.height);
      for (let i = 0; i < 6; i++) {
        ctx.beginPath();
        ctx.globalAlpha = 0.12 + 0.15 * Math.sin(t + i);
        ctx.arc((c.width / 6) * i + 40 * Math.sin(t * (0.5 + i * 0.05)), 40 + 40 * Math.cos(t * (0.3 + i * 0.03)), 22 + 6 * Math.sin(t * (0.9 + i * 0.02)), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = 'rgba(255,255,255,0.95)';
      ctx.font = '18px Inter, Arial';
      ctx.fillText(label, 14, 28);
      ctx.font = '12px Inter, Arial';
      ctx.fillText(new Date().toLocaleTimeString(), 14, 48);
      ctx.strokeStyle = 'rgba(255,255,255,0.08)';
      ctx.strokeRect(0, 0, c.width, c.height);
    }, 80);
    const stream = c.captureStream(15);
    el.srcObject = stream; el.play().catch(() => {});
    return { interval: id, stream };
  }

  // ----------------- REAL mode (socket + WebRTC) -----------------
  useEffect(() => {
    // prepare socket (not auto connecting)
    socketRef.current = io(SIGNAL_URL, { autoConnect: false });
    const socket = socketRef.current;

    socket.on('connect', () => {
      selfIdRef.current = socket.id;
      console.log('[socket] connected', socket.id);
    });

    socket.on('matched', ({ matchId, peer }) => {
      console.log('[socket] matched', peer);
      // if fake preview active, cleanup before real connect
      if (fakeFallbackActive.current) cleanupFakePreview();
      peerIdRef.current = peer;
      setMatchName(peer);
      setState('matched');
      const isInitiator = (selfIdRef.current && peer && selfIdRef.current < peer);
      startWebRTC(isInitiator).catch(e => console.warn('startWebRTC error', e));
    });

    socket.on('sig', async ({ from, type, data }) => {
      if (!pcRef.current) {
        await startWebRTC(false).catch(e => console.warn('startWebRTC during sig failed', e));
      }
      const pc = pcRef.current;
      if (!pc) return;
      try {
        if (type === 'offer') {
          await pc.setRemoteDescription(data);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          socket.emit('sig', { to: from, type: 'answer', data: pc.localDescription });
        } else if (type === 'answer') {
          await pc.setRemoteDescription(data);
        } else if (type === 'ice') {
          await pc.addIceCandidate(data);
        }
      } catch (err) {
        console.warn('[sig] handling error', err);
      }
    });

    socket.on('peer-disconnected', () => {
      appendSystem('Peer disconnected');
      cleanupConnection();
      setState('idle');
      // restart searching automatically if desired (here we leave idle)
    });

    return () => {
      if (socketRef.current) socketRef.current.disconnect();
      if (fallbackTimerRef.current) clearTimeout(fallbackTimerRef.current);
      if (fakeSessionTimerRef.current) clearTimeout(fakeSessionTimerRef.current);
    };
    // run once
  }, []);

  async function startSignalling() {
    if (!socketRef.current) return;
    if (!socketRef.current.connected) socketRef.current.connect();
    socketRef.current.emit('find');
    setState('searching');

    // clear previous fallback
    fakeFallbackActive.current = false;
    if (fallbackTimerRef.current) { clearTimeout(fallbackTimerRef.current); fallbackTimerRef.current = null; }

    // start fallback timer — 5s
    fallbackTimerRef.current = setTimeout(() => {
      // only trigger if still searching and no peer matched
      if (state === 'searching' && !peerIdRef.current) {
        startFakePreviewDuringReal();
      }
    }, 5000);
  }

  // start a short fake preview while real matchmaking continues in background
  function startFakePreviewDuringReal() {
    fakeFallbackActive.current = true;
    const name = NAMES[Math.floor(Math.random() * NAMES.length)];
    setMatchName(name);
    setState('matched');

    // create canvas streams for local & remote preview (stored so we can cleanup later)
    try {
      const localEl = localVideoRef.current;
      const remoteEl = remoteVideoRef.current;
      if (localEl) {
        const r = createCanvasStream(localEl, 'You');
        fakePreviewRef.current.local = r;
      }
      if (remoteEl) {
        const r2 = createCanvasStream(remoteEl, 'Peer');
        fakePreviewRef.current.remote = r2;
      }
    } catch (e) { console.warn('fake preview failed', e); }

    // auto-transition to connected UI state quickly
    setTimeout(() => {
      if (fakeFallbackActive.current) setState('connected');
    }, 700);

    // schedule end of this short fake session (8s) then try real matching again
    if (fakeSessionTimerRef.current) clearTimeout(fakeSessionTimerRef.current);
    fakeSessionTimerRef.current = setTimeout(() => {
      if (!peerIdRef.current) {
        cleanupFakePreview();
        // restart searching again (re-arms the 5s fallback)
        startSignalling();
      }
    }, 8000);
  }

  // cleanup fake preview streams (called when real match arrives or user stops)
  function cleanupFakePreview() {
    fakeFallbackActive.current = false;
    const f = fakePreviewRef.current || {};
    try {
      if (f.local) { clearInterval(f.local.interval); f.local.stream.getTracks().forEach(t => t.stop()); }
      if (f.remote) { clearInterval(f.remote.interval); f.remote.stream.getTracks().forEach(t => t.stop()); }
    } catch (e) { /* ignore */ }
    fakePreviewRef.current = {};
    if (fakeSessionTimerRef.current) { clearTimeout(fakeSessionTimerRef.current); fakeSessionTimerRef.current = null; }
  }

  async function startWebRTC(isInitiator) {
  // create PC
  pcRef.current = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    // add TURN servers here for real-world NAT traversal
  });
  const pc = pcRef.current;

  // setup remote stream
  remoteStreamRef.current = new MediaStream();
  if (remoteVideoRef.current) {
    remoteVideoRef.current.srcObject = remoteStreamRef.current;
    // try to play (mobile may block until user gesture)
    remoteVideoRef.current.play().catch(() => {});
  }

  pc.ontrack = (e) => {
    // prefer attached streams (some browsers provide e.streams[0])
    if (e.streams && e.streams[0]) {
      e.streams[0].getTracks().forEach(t => remoteStreamRef.current.addTrack(t));
    } else {
      // fallback: individual track(s)
      remoteStreamRef.current.addTrack(e.track);
    }
  };

  pc.onicecandidate = (e) => {
    if (e.candidate && peerIdRef.current && socketRef.current && socketRef.current.connected) {
      socketRef.current.emit('sig', { to: peerIdRef.current, type: 'ice', data: e.candidate });
    }
  };

  // data channel logic
  if (isInitiator) {
    const dc = pc.createDataChannel('chat');
    setupDataChannel(dc);
  } else {
    pc.ondatachannel = (e) => setupDataChannel(e.channel);
  }

  // Optional: connection state logging (helps debug mobile)
  pc.onconnectionstatechange = () => {
    console.log('[pc] connectionState=', pc.connectionState);
    if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
      appendSystem('Connection lost.'); // user-facing
    }
  };

  // ✅ Check available devices FIRST
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const hasVideo = devices.some(d => d.kind === 'videoinput');
    const hasAudio = devices.some(d => d.kind === 'audioinput');

    console.log('🎥 Camera available:', hasVideo);
    console.log('🎤 Microphone available:', hasAudio);

    // Build constraints based on what's available
    const constraints = {};
    if (hasAudio) constraints.audio = true;
    if (hasVideo) {
      // prefer front camera on phones
      constraints.video = { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } };
    }

    // If neither available, show message but continue with text chat
    if (!hasAudio && !hasVideo) {
      appendSystem('⚠️ No camera/mic found. Text chat only.');
      console.warn('No media devices available');

      // create offer for datachannel-only (if initiator)
      if (isInitiator) {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        if (socketRef.current && peerIdRef.current) {
          socketRef.current.emit('sig', { to: peerIdRef.current, type: 'offer', data: pc.localDescription });
        }
      }
      setState('connected');
      return;
    }

    // Try to get media with available devices
    localStreamRef.current = await navigator.mediaDevices.getUserMedia(constraints);
    localStreamRef.current.getTracks().forEach(track => pc.addTrack(track, localStreamRef.current));

    if (localVideoRef.current) {
      localVideoRef.current.srcObject = localStreamRef.current;
      localVideoRef.current.play().catch(() => { /* autoplay may be blocked; okay */ });
    }

    // Show what mode we're in
    if (hasAudio && !hasVideo) {
      appendSystem('🎤 Audio-only mode (no camera detected)');
    } else if (hasVideo && !hasAudio) {
      appendSystem('🎥 Video-only mode (no microphone detected)');
    } else {
      appendSystem('✅ Video & audio connected');
    }

  } catch (e) {
    console.warn('getUserMedia failed', e);

    // Better error messages
    if (e && e.name === 'NotFoundError') {
      appendSystem('❌ Camera/mic not found. Continuing with text chat only.');
    } else if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) {
      appendSystem('🔒 Permission denied. Click camera icon in address bar to allow access.');
    } else if (e && e.name === 'NotReadableError') {
      appendSystem('⚠️ Device in use by another app. Close other apps and try again.');
    } else {
      appendSystem('⚠️ Media error. Text chat still works.');
    }
    // proceed — create offer for datachannel only if initiator
    if (isInitiator) {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        if (socketRef.current && peerIdRef.current) {
          socketRef.current.emit('sig', { to: peerIdRef.current, type: 'offer', data: pc.localDescription });
        }
      } catch (err) {
        console.warn('Failed to create/send offer after media error', err);
      }
    }
    setState('connected');
    return;
  }

  // create offer if initiator
  try {
    if (isInitiator) {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      if (socketRef.current && peerIdRef.current) {
        socketRef.current.emit('sig', { to: peerIdRef.current, type: 'offer', data: pc.localDescription });
      }
    }
  } catch (err) {
    console.warn('Error creating/sending offer', err);
  }

  setState('connected');
}


  function setupDataChannel(dc) {
    dcRef.current = dc;
    dc.onopen = () => appendSystem('You Can Text Now. Connected To Stranger');
    dc.onmessage = (e) => appendMessage({ id: Date.now(), from: 'Stranger', text: e.data });
    dc.onclose = () => appendSystem('Stranger disconnect, Click Start');
    dc.onerror = (err) => console.warn('DC error', err);
  }

  // --- message helpers
  function appendMessage(msg) { setMessages(m => [...m, msg]); }
  function appendSystem(text) { setMessages(m => [...m, { id: Date.now(), from: 'System', text }]); }

  // --- send message (real via datachannel, fake via delayed reply)
  function send() {
    if (!input.trim()) return;
    const outgoing = { id: Date.now(), from: 'You', text: input.trim() };
    appendMessage(outgoing);

    if (dcRef.current && dcRef.current.readyState === 'open' && peerIdRef.current) {
      try { dcRef.current.send(outgoing.text); } catch (e) { console.warn('dc send failed', e); }
    } else if (fakeFallbackActive.current) {
      setTimeout(() => {
        const reply = { id: Date.now() + 1, from: matchName || 'Peer', text: generatePeerReply(outgoing.text) };
        appendMessage(reply);
      }, 700 + Math.random() * 900);
    }

    setInput('');
  }

  // --- stop/cleanup
  async function stop() {
    if (socketRef.current && socketRef.current.connected) {
      socketRef.current.emit('cancel');
    }
    cleanupConnection();
    cleanupFakePreview();
    if (fallbackTimerRef.current) { clearTimeout(fallbackTimerRef.current); fallbackTimerRef.current = null; }
    setState('idle');
    setMatchName(null);
    setMessages([]);
    setInput('');
  }

  function cleanupConnection() {
    try { if (dcRef.current) dcRef.current.close(); } catch (e) {}
    try { if (pcRef.current) pcRef.current.close(); } catch (e) {}
    if (localStreamRef.current) { localStreamRef.current.getTracks().forEach(t => t.stop()); localStreamRef.current = null; }
    if (remoteStreamRef.current) { remoteStreamRef.current.getTracks().forEach(t => t.stop()); remoteStreamRef.current = null; }
    pcRef.current = null; dcRef.current = null; peerIdRef.current = null;
    if (localVideoRef.current) localVideoRef.current.srcObject = null;
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
  }

  // --- UI handlers
  function onStart() {
    setMessages([]);
    startSignalling(); // always attempt real first
  }

  // --- Handle Report (fixed name and safe)
  function handleReport() {
    appendSystem('Report submitted — thank you.');
    // TODO: send to /api/report in real app
    stop();
  }

  // --- UI
  return (
    <div className="app-root">
      <header className="header">
        <h1>TalkNow — Chat With Stranger</h1>
        <div className="sub">Happy And Safe Chatting </div>
      </header>

      <div className="layout">
        <main className="main-card">
          <div className="controls">
            <div>
              <button onClick={onStart} disabled={state === 'searching' || state === 'connected'} className="btn">Start</button>
              <button onClick={stop} disabled={state === 'idle'} className="btn btn-ghost">Stop</button>
            </div>
            <div className="status">
              <div className="label">Status:</div>
              <div className="value">{state}</div>
            </div>
          </div>

          <div className="media-and-chat">
            <div className="media-panel">
              <div className="videos">
                <div className="local">
                  <div className="caption">Local</div>
                  <video ref={localVideoRef} muted playsInline className="video" />
                </div>
                <div className="remote">
                  <div className="caption">Remote</div>
                  <video ref={remoteVideoRef} playsInline className="video" />
                </div>
              </div>

              <div className="chat-section">
                <div className="chat-header">
                  <div className="chat-title">Chat</div>
                  <button onClick={handleReport} className="btn btn-report">Report</button>
                </div>

                <div className="chat-window">
                  {messages.length === 0 && <div className="empty">No messages yet — be friendly and safe.</div>}
                  {messages.map(m => (
                    <div key={m.id} className={`msg ${m.from === 'You' ? 'msg-out' : m.from === 'System' ? 'msg-system' : 'msg-in'}`}>
                      <div className="from">{m.from}</div>
                      <div className="bubble">{m.text}</div>
                    </div>
                  ))}
                </div>

                <div className="chat-input">
                  <input
                    value={input}
                    onChange={e => setInput(e.target.value)}
                    placeholder={state === 'connected' ? 'Say hi...' : 'Start a conversation when connected.'}
                    onKeyDown={e => { if (e.key === 'Enter') send(); }}
                    disabled={state !== 'connected'}
                  />
                  <button onClick={send} disabled={state !== 'connected' || !input.trim()} className="btn">Send</button>
                </div>
              </div>
            </div>

            <aside className="sidebar">
              <div className="card">
                <div className="peer-name">{matchName ?? 'No peer'}</div>
                <div className="peer-status">{state === 'connected' ? 'Connected' : '—'}</div>
                <div className="tips">
                  <ul>
                    <li>Be polite and brief.</li>
                    <li>Do not share personal details.</li>
                    <li>Report inappropriate users.</li>
                  </ul>
                </div>
              </div>
            </aside>
          </div>
        </main>
      </div>
    </div>
  );
}

// --- helper: fake peer reply
const generatePeerReply = (text) => {
  const short = text.split(' ').slice(0, 6).join(' ');
  const replies = [
    `Nice — you said: "${short}"`,
    "That's interesting! Tell me more.",
    'Cool — where are you from?',
    "I like that. What's your favorite hobby?",
    "Haha, same. What's next?",
  ];
  return replies[Math.floor(Math.random() * replies.length)];
};
