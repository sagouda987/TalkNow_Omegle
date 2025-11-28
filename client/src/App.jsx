// src/App.jsx
// TalkNow — React + Socket.IO + WebRTC (with simulated online badge + moderation, terms & 18+)
import React, { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';

const SIGNAL_URL = import.meta.env.VITE_SIGNAL_URL || 'http://localhost:4000';
const LOCAL_PENALTIES_KEY = 'talknow_penalties_v1';

export default function App() {
  // --- app state
  const [state, setState] = useState('idle'); // idle | searching | matched | connected
  const [matchName, setMatchName] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');

  // agreement & age
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [ageVerified, setAgeVerified] = useState(false);
  const [showTermsModal, setShowTermsModal] = useState(false);
  
   // audio/video toggle state
  const audioEnabledRef = useRef(true);
  const videoEnabledRef = useRef(true);
  const [muted, setMuted] = useState(false);
  const [videoOff, setVideoOff] = useState(false);

  // online badge (real or simulated)
  const [onlineCount, setOnlineCount] = useState(0);
  const [simulatedBadge, setSimulatedBadge] = useState(false);

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

  // fake-preview helpers
  const fallbackTimerRef = useRef(null);
  const fakePreviewRef = useRef({});
  const fakeFallbackActive = useRef(false);
  const fakeSessionTimerRef = useRef(null);
  const fakeReplyIntervalRef = useRef(null); // periodic fake replies

  // simulation refs
  const simRef = useRef(null);
  const simActiveRef = useRef(false);

  // moderation / penalties
  const penaltiesRef = useRef(loadPenalties()); // { [userId]: {count, banned, suspendedUntil, reports:[] } }

  // ---------- Analytics helper ----------
  function trackEvent(action, params = {}) {
    if (typeof window !== 'undefined' && window.gtag) {
      try { window.gtag('event', action, params); }
      catch (e) { console.warn('gtag error', e); }
    }
  }

  // ---------- Simulation params (tweak here) ----------
  const DEMO_FORCE = true;   // true => show simulated online badge if real count missing
  const minDemo = 80;
  const maxDemo = 320;
  const intervalMs = 2200;

  // ---------- Moderation settings ----------
  const TEMP_SUSPENSION_MINUTES = 10; // second offense => suspend for 10 min
  const BAD_WORDS = ['fuck','shit','bitch','asshole','cunt','porn','nude']; // simple demo list
  const URL_PATTERN = /(https?:\/\/[^\s]+)/i;
  const IMAGE_EXT_PATTERN = /\.(jpeg|jpg|png|gif|webp|bmp)(\?.*)?$/i;

  // ---------- helpers for penalties persistence ----------
  function loadPenalties() {
    try {
      const raw = localStorage.getItem(LOCAL_PENALTIES_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      console.warn('Failed to load penalties', e);
      return {};
    }
  }
  function savePenalties() {
    try {
      localStorage.setItem(LOCAL_PENALTIES_KEY, JSON.stringify(penaltiesRef.current));
    } catch (e) { console.warn('save penalties failed', e); }
  }

  function recordReport(offenderId, reportData) {
    if (!offenderId) return;
    const p = penaltiesRef.current[offenderId] || { count: 0, banned: false, suspendedUntil: null, reports: [] };
    p.reports = p.reports || [];
    p.reports.push({ ts: Date.now(), ...reportData });
    penaltiesRef.current[offenderId] = p;
    savePenalties();
  }

  // ---- moderation function (client-side demo)
  // returns { allowed: bool, action: 'warn'|'suspend'|'ban'|'block'|null, reason: string }
  function moderateText(text) {
    if (!text || !text.trim()) return { allowed: true };

    const lower = text.toLowerCase();

    // block URLs / images
    const hasUrl = URL_PATTERN.test(text);
    if (hasUrl) {
      const m = text.match(URL_PATTERN);
      if (m && IMAGE_EXT_PATTERN.test(m[0])) {
        return { allowed: false, action: 'block', reason: 'Images not allowed in chat' };
      }
      return { allowed: false, action: 'block', reason: 'Links are not allowed in chat' };
    }

    // bad words check
    for (let w of BAD_WORDS) {
      if (lower.includes(w)) {
        return { allowed: false, action: 'warn', reason: `Prohibited language detected: ${w}` };
      }
    }

    return { allowed: true };
  }

  // Called when we detect misconduct for a given offender (peerId)
  function applyPenaltyTo(offenderId, reason, reporter = 'system') {
    if (!offenderId) return;
    const now = Date.now();
    const entry = penaltiesRef.current[offenderId] || { count: 0, banned: false, suspendedUntil: null, reports: [] };

    // increment offense count
    entry.count = (entry.count || 0) + 1;
    entry.reports = entry.reports || [];
    entry.reports.push({ ts: now, reason, reporter });

    // escalate
    if (entry.count === 1) {
      appendSystem(`Warning issued to user (${offenderId}). Reason: ${reason}`);
      trackEvent('moderation_warning', { offender: offenderId, reason });
    } else if (entry.count === 2) {
      entry.suspendedUntil = now + TEMP_SUSPENSION_MINUTES * 60 * 1000;
      appendSystem(`User (${offenderId}) suspended for ${TEMP_SUSPENSION_MINUTES} minutes.`);
      trackEvent('moderation_suspension', { offender: offenderId, duration_min: TEMP_SUSPENSION_MINUTES, reason });
    } else {
      entry.banned = true;
      appendSystem(`User (${offenderId}) permanently banned (client-side demo).`);
      trackEvent('moderation_ban', { offender: offenderId, reason });
    }

    penaltiesRef.current[offenderId] = entry;
    savePenalties();
  }

  function isPeerAllowed(peerId) {
    if (!peerId) return true;
    const e = penaltiesRef.current[peerId];
    if (!e) return true;
    if (e.banned) return false;
    if (e.suspendedUntil && Date.now() < e.suspendedUntil) return false;
    return true;
  }

  // append messages helpers
  function appendMessage(msg) { setMessages(m => [...m, msg]); }
  function appendSystem(text) { setMessages(m => [...m, { id: Date.now(), from: 'System', text }]); }
  
  // audio / video controls
  function setLocalAudio(enabled) {
    audioEnabledRef.current = enabled;
    setMuted(!enabled);
    if (localStreamRef.current) {
      localStreamRef.current.getAudioTracks().forEach(t => t.enabled = enabled);
    }
  }

  function setLocalVideo(enabled) {
    videoEnabledRef.current = enabled;
    setVideoOff(!enabled);
    if (localStreamRef.current) {
      localStreamRef.current.getVideoTracks().forEach(t => t.enabled = enabled);
    }
  }

  function toggleMute() {
    setLocalAudio(!audioEnabledRef.current);
  }

  function toggleVideo() {
    setLocalVideo(!videoEnabledRef.current);
  }
 // --- periodic fake peer replies ---
  function startFakeReplies() {
    stopFakeReplies(); // clear old one first
    fakeReplyIntervalRef.current = setInterval(() => {
      if (!fakeFallbackActive.current) return;
      const reply = {
        id: Date.now(),
        from: matchName || 'Stranger',
        text: generatePeerReply('')
      };
      appendMessage(reply);
    }, 4000 + Math.floor(Math.random() * 8000)); 
  }

  function stopFakeReplies() {
    if (fakeReplyIntervalRef.current) {
      clearInterval(fakeReplyIntervalRef.current);
      fakeReplyIntervalRef.current = null;
    }
  }
  // ------- simulated online
  function startSimulatedOnline(initial) {
    if (simActiveRef.current) return;
    simActiveRef.current = true;
    setSimulatedBadge(true);

    let current = typeof initial === 'number' ? initial : Math.floor((minDemo + maxDemo) / 2);
    setOnlineCount(current);

    simRef.current = setInterval(() => {
      const delta = Math.floor((Math.random() - 0.5) * 16);
      current = Math.max(minDemo, Math.min(maxDemo, current + delta));
      if (Math.random() < 0.05) {
        const big = Math.floor((Math.random() - 0.5) * 60);
        current = Math.max(minDemo, Math.min(maxDemo, current + big));
      }
      setOnlineCount(current);
    }, intervalMs);
  }
  function stopSimulatedOnline() {
    if (simRef.current) { clearInterval(simRef.current); simRef.current = null; }
    simActiveRef.current = false;
    setSimulatedBadge(false);
  }

  // inject styles once (responsive + side-by-side chat)
  useEffect(() => {
    const css = `
:root { font-family: Inter, Arial, sans-serif; }
html, body, #root { height: 100%; margin: 0; }
body { background:#f3f4f6; color:#111827; -webkit-font-smoothing:antialiased; -moz-osx-font-smoothing:grayscale; }

.app-root { min-height:100vh; box-sizing:border-box; padding:18px; width:100%; display:flex; flex-direction:column; gap:16px; }

/* header */
.header { display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap; }
.header h1 { margin:0; font-size:20px; white-space:nowrap; }
.sub { font-size:13px; color:#666; white-space:nowrap; }

/* layout: main + sidebar */
.layout {
  display:grid;
  grid-template-columns: 1fr 320px;
  gap:16px;
  align-items:start;
  width:100%;
  box-sizing:border-box;
  min-height: calc(100vh - 120px);
  padding-bottom:8px;
}

/* main card */
.main-card { background:#fff; border-radius:12px; padding:14px; box-shadow:0 6px 18px rgba(20,20,50,0.06); display:flex; flex-direction:column; gap:12px; min-height:0; }

/* controls */
.controls { display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
.btn { padding:8px 12px; border-radius:10px; background:#0b84ff; color:#fff; border:none; cursor:pointer; font-weight:600; }
.btn-ghost { margin-left:8px; background:#eee; color:#333; }
.status { margin-left:auto; display:flex; gap:8px; align-items:center; }

/* media + chat container: we keep media-panel as container that lays out videos and chat side-by-side */
.media-and-chat { display:flex; gap:12px; flex-direction:column; min-height:0; }

/* media panel contains videos and chat as two columns on desktop */
.media-panel {
  width:100%;
  border-radius:10px;
  overflow:hidden;
  background:#111827;
  padding:12px;
  display:flex;
  flex-direction:row; /* <-- changed: side-by-side by default */
  gap:12px;
  min-height:0;
  box-sizing:border-box;
}

/* videos area (left column) */
.videos { display:flex; flex-direction:column; gap:12px; flex:1 1 auto; min-width:0; }

/* keep each video responsive */
.local, .remote { display:flex; flex-direction:column; gap:8px; min-height:0; }
.caption { font-size:12px; color:#ddd; margin-bottom:4px; }
.video { width:100%; height:260px; border-radius:10px; background:#000; object-fit:cover; display:block; min-height:120px; }

/* chat section (right column) */
.chat-section { width:360px; max-width:100%; display:flex; flex-direction:column; gap:8px; box-sizing:border-box; }

/* chat header / window / input */
.chat-header { display:flex; justify-content:space-between; align-items:center; }
.chat-title { color:#bbb; }
.btn-report { font-size:12px; padding:6px 10px; border-radius:8px; background:#ffecec; border:1px solid #f5c2c2; }
.chat-window { margin-top:8px; height:320px; overflow:auto; padding:10px; background:rgba(255,255,255,0.02); border-radius:8px; }
.empty { color:#9aa; font-size:13px; }
.msg { margin-bottom:8px; }
.msg .from { font-size:12px; color:#8f8f8f; }
.msg .bubble { display:inline-block; padding:8px 10px; border-radius:8px; margin-top:4px; max-width:85%; word-wrap:break-word; }
.msg-out .bubble { background:#d1ffe0; }
.msg-in .bubble { background:#ffffffcc; }
.msg-system .bubble { background:#fff3c4; }
.chat-input { display:flex; gap:8px; margin-top:8px; }
.chat-input input { flex:1; padding:10px 12px; border-radius:8px; border:1px solid #ddd; background:#fff; }

/* sidebar card */
.sidebar { width:100%; max-width:320px; display:flex; flex-direction:column; gap:12px; box-sizing:border-box; }
.card { padding:12px; border-radius:10px; background:#fff; box-shadow:0 6px 18px rgba(20,20,50,0.06); }
.peer-name { font-size:13px; font-weight:700; }
.peer-status { font-size:12px; color:#666; margin-top:6px; }
.tips { margin-top:10px; font-size:12px; color:#444; }

/* responsive tweaks */
/* when smaller than 1100px, stack chat under videos */
@media (max-width:1100px) {
  .media-panel { flex-direction:column; }
  .videos { flex-direction:column; }
  .video { height:240px; }
  .chat-section { width:100%; max-width:100%; }
}

/* mobile */
@media (max-width:680px) {
  .header h1 { font-size:18px; }
  .controls { gap:8px; }
  .video { height:200px; }
  .chat-window { height:220px; }
  .chat-input input { padding:10px; }
  .btn { padding:8px 10px; font-size:14px; }
  .layout { padding-bottom:20px; }
}

/* small polish */
@media (prefers-reduced-motion: reduce) {
  * { transition:none !important; animation:none !important; }
}
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
    socketRef.current = io(SIGNAL_URL, { autoConnect: false });
    const socket = socketRef.current;

    socket.on('connect', () => {
      selfIdRef.current = socket.id;
      console.log('[socket] connected', socket.id);
      socket.emit('presence', { ts: Date.now() });
      trackEvent('client_socket_connect', { socket_id: socket.id });

      setTimeout(() => {
        if (DEMO_FORCE && !simActiveRef.current && (!socket || !socket.connected || onlineCount === 0)) {
          startSimulatedOnline();
        }
      }, 1200);
    });

    socket.on('online', (count) => {
      if (typeof count === 'number' && Number.isFinite(count)) {
        stopSimulatedOnline();
        setOnlineCount(count);
      }
    });

    socket.on('matched', ({ matchId, peer }) => {
      console.log('[socket] matched', peer);
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
    });

    socket.on('moderation', ({ offender, action, reason }) => {
      if (action === 'ban') {
        penaltiesRef.current[offender] = penaltiesRef.current[offender] || {};
        penaltiesRef.current[offender].banned = true;
        savePenalties();
        appendSystem(`User ${offender} banned by server moderation`);
      }
    });

    socket.on('disconnect', () => {
      console.log('[socket] disconnected');
      if (DEMO_FORCE) startSimulatedOnline();
    });

    return () => {
      if (socketRef.current) socketRef.current.disconnect();
      stopSimulatedOnline();
      if (fallbackTimerRef.current) clearTimeout(fallbackTimerRef.current);
      if (fakeSessionTimerRef.current) clearTimeout(fakeSessionTimerRef.current);
	  if (fakeSessionTimerRef.current) clearTimeout(fakeSessionTimerRef.current);

// Keep fake chat for ~60 seconds
fakeSessionTimerRef.current = setTimeout(() => {
  if (!peerIdRef.current) {
    cleanupFakePreview();
    startSignalling();
  }
}, 60000);

// Start periodic fake replies
startFakeReplies();
    };
  }, []);

  async function startSignalling() {
    // enforce terms & age before joining
    if (!ageVerified || !acceptedTerms) {
      setShowTermsModal(true);
      appendSystem('You must confirm age (18+) and accept Terms & Conditions before joining.');
      return;
    }

    // check local ban
    const myId = selfIdRef.current;
    if (myId && penaltiesRef.current[myId] && penaltiesRef.current[myId].banned) {
      appendSystem('You are banned and cannot join chats.');
      return;
    }

    if (!socketRef.current) return;
    if (!socketRef.current.connected) socketRef.current.connect();
    socketRef.current.emit('find');
    setState('searching');

   fakeFallbackActive.current = false;
if (fallbackTimerRef.current) {
  clearTimeout(fallbackTimerRef.current);
  fallbackTimerRef.current = null;
}

// fallback to a fake preview if no real peer within ~1.3s
fallbackTimerRef.current = setTimeout(() => {
  // avoid stale React state; just check if real peer is still missing
  if (!peerIdRef.current) startFakePreviewDuringReal();
}, 4000);
  }

  function startFakePreviewDuringReal() {
    fakeFallbackActive.current = true;
    const name = NAMES[Math.floor(Math.random() * NAMES.length)];
    setMatchName('Stranger');
    setState('matched');

    try {
      const localEl = localVideoRef.current;
      const remoteEl = remoteVideoRef.current;
      if (localEl) fakePreviewRef.current.local = createCanvasStream(localEl, 'You');
      if (remoteEl) fakePreviewRef.current.remote = createCanvasStream(remoteEl, 'Peer');
    } catch (e) { console.warn('fake preview failed', e); }

    setTimeout(() => { if (fakeFallbackActive.current) setState('connected'); }, 700);

    if (fakeSessionTimerRef.current) clearTimeout(fakeSessionTimerRef.current);
    fakeSessionTimerRef.current = setTimeout(() => {
      if (!peerIdRef.current) {
        cleanupFakePreview();
        startSignalling();
      }
    }, 8000);
  }

  function cleanupFakePreview() {
    fakeFallbackActive.current = false;
    const f = fakePreviewRef.current || {};
    try {
      if (f.local) { clearInterval(f.local.interval); f.local.stream.getTracks().forEach(t => t.stop()); }
      if (f.remote) { clearInterval(f.remote.interval); f.remote.stream.getTracks().forEach(t => t.stop()); }
    } catch (e) {}
    fakePreviewRef.current = {};
	  stopFakeReplies();
    if (fakeSessionTimerRef.current) { clearTimeout(fakeSessionTimerRef.current); fakeSessionTimerRef.current = null; }
  }

  async function startWebRTC(isInitiator) {
    pcRef.current = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });
    const pc = pcRef.current;

    remoteStreamRef.current = new MediaStream();
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = remoteStreamRef.current;
      remoteVideoRef.current.play().catch(()=>{});
    }

    pc.ontrack = (e) => {
      if (e.streams && e.streams[0]) e.streams[0].getTracks().forEach(t => remoteStreamRef.current.addTrack(t));
      else remoteStreamRef.current.addTrack(e.track);
    };

    pc.onicecandidate = (e) => {
      if (e.candidate && peerIdRef.current && socketRef.current && socketRef.current.connected) {
        socketRef.current.emit('sig', { to: peerIdRef.current, type: 'ice', data: e.candidate });
      }
    };

    if (isInitiator) {
      const dc = pc.createDataChannel('chat');
      setupDataChannel(dc);
    } else {
      pc.ondatachannel = (e) => setupDataChannel(e.channel);
    }

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') appendSystem('Connection lost.');
    };

    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const hasVideo = devices.some(d => d.kind === 'videoinput');
      const hasAudio = devices.some(d => d.kind === 'audioinput');

      const constraints = {};
      if (hasAudio) constraints.audio = true;
      if (hasVideo) constraints.video = { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } };

      if (!hasAudio && !hasVideo) {
        appendSystem('⚠️ No camera/mic found. Text chat only.');
        if (isInitiator) {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          if (socketRef.current && peerIdRef.current) socketRef.current.emit('sig', { to: peerIdRef.current, type: 'offer', data: pc.localDescription });
        }
        setState('connected'); return;
      }

      localStreamRef.current = await navigator.mediaDevices.getUserMedia(constraints);
	  // apply audio/video toggle state
      localStreamRef.current.getAudioTracks().forEach(t => t.enabled = audioEnabledRef.current);
      localStreamRef.current.getVideoTracks().forEach(t => t.enabled = videoEnabledRef.current);
      localStreamRef.current.getTracks().forEach(track => pc.addTrack(track, localStreamRef.current));
      if (localVideoRef.current) localVideoRef.current.srcObject = localStreamRef.current;
      if (hasAudio && !hasVideo) appendSystem('🎤 Audio-only mode (no camera detected)');
      else if (hasVideo && !hasAudio) appendSystem('🎥 Video-only mode (no microphone detected)');
      else appendSystem('✅ Video & audio connected');
    } catch (e) {
      console.warn('getUserMedia failed', e);
      if (e && e.name === 'NotFoundError') appendSystem('❌ Camera/mic not found. Continuing with text chat only.');
      else if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) appendSystem('🔒 Permission denied.');
      else appendSystem('⚠️ Media error. Text chat still works.');
      if (isInitiator) {
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          if (socketRef.current && peerIdRef.current) socketRef.current.emit('sig', { to: peerIdRef.current, type: 'offer', data: pc.localDescription });
        } catch (err) { console.warn(err); }
      }
      setState('connected');
      return;
    }

    try {
      if (isInitiator) {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        if (socketRef.current && peerIdRef.current) socketRef.current.emit('sig', { to: peerIdRef.current, type: 'offer', data: pc.localDescription });
      }
    } catch (err) { console.warn('Error creating/sending offer', err); }

    setState('connected');
  }

  function setupDataChannel(dc) {
    dcRef.current = dc;
    dc.onopen = () => {
      appendSystem('You Can Text Now. Connected To Stranger');
      trackEvent('chat_connected', { peer: matchName || null });
    };
    dc.onmessage = (e) => {
      const text = String(e.data || '');
      const peer = peerIdRef.current || 'unknown';
      const moderation = moderateText(text);

      if (!isPeerAllowed(peer)) {
        appendSystem('Message blocked: peer is suspended or banned.');
        return;
      }

      if (!moderation.allowed) {
        applyPenaltyTo(peer, moderation.reason, 'auto-moderation');
        trackEvent('incoming_blocked', { peer, reason: moderation.reason });
        appendSystem(`Incoming message blocked for policy: ${moderation.reason}`);
        return;
      }

      appendMessage({ id: Date.now(), from: 'Stranger', text });
    };
    dc.onclose = () => appendSystem('Stranger disconnect, Click Start');
    dc.onerror = (err) => console.warn('DC error', err);
  }

  // send message with moderation checks
  function send() {
    if (!input.trim()) return;

    const moderation = moderateText(input);
    if (!moderation.allowed) {
      appendSystem(`Your message was blocked: ${moderation.reason}`);
      const myId = selfIdRef.current || 'local';
      applyPenaltyTo(myId, `outgoing_${moderation.reason}`, 'self');
      trackEvent('outgoing_blocked', { reason: moderation.reason });
      return;
    }

    const peer = peerIdRef.current;
    if (peer && !isPeerAllowed(peer)) {
      appendSystem('Cannot send: peer is suspended or banned.');
      return;
    }

    const outgoing = { id: Date.now(), from: 'You', text: input.trim() };
    appendMessage(outgoing);
    trackEvent('message_sent', { text_length: outgoing.text.length });

    if (dcRef.current && dcRef.current.readyState === 'open' && peerIdRef.current) {
      try { dcRef.current.send(outgoing.text); } catch (e) { console.warn(e); }
    } else if (fakeFallbackActive.current){
      // immediate reply to your message (delayed ~0.7-1.6s)
      setTimeout(() => {
        const reply = {
          id: Date.now() + 1,
          from: matchName || 'Stranger',
          text: generatePeerReply(outgoing.text)
        };
        appendMessage(reply);
      }, 700 + Math.random() * 900);

      // ensure periodic replies continue / refresh interval
      startFakeReplies();
    }

    setInput('');
  }

  // report a specific message
  function reportMessage(msg) {
    const offender = (msg.from !== 'You' && msg.from !== 'System') ? peerIdRef.current : selfIdRef.current;
    recordReport(offender, { message: msg.text, reporter: (selfIdRef.current || 'local'), ts: Date.now() });
    if (socketRef.current && socketRef.current.connected) {
      socketRef.current.emit('report', { offender, message: msg.text, reporter: selfIdRef.current || 'local' });
    }
    applyPenaltyTo(offender, 'reported_by_user', selfIdRef.current || 'local');
    appendSystem('Thank you — the message was reported and will be reviewed.');
  }

  // --- stop/cleanup
  async function stop() {
    if (socketRef.current && socketRef.current.connected) {
      socketRef.current.emit('cancel');
    }
    trackEvent('chat_stop', { reason: 'manual' });
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

  // UI helper to accept terms and age
  function acceptAndClose() {
    if (!ageVerified) { appendSystem('Please confirm you are 18+ to continue.'); return; }
    if (!acceptedTerms) { appendSystem('Please accept Terms & Conditions to continue.'); return; }
    setShowTermsModal(false);
  }

  // Helper: user clicks the main Report button (global)
  function handleReport() {
    const offender = peerIdRef.current;
    if (!offender) {
      appendSystem('No connected peer to report.');
      return;
    }
    recordReport(offender, { message: 'Reported via Report button', reporter: selfIdRef.current || 'local', ts: Date.now() });
    if (socketRef.current && socketRef.current.connected) socketRef.current.emit('report', { offender, reporter: selfIdRef.current || 'local' });
    applyPenaltyTo(offender, 'reported_via_button', selfIdRef.current || 'local');
    appendSystem('Report submitted — thank you.');
    stop();
  }

  // small UI: show Terms & Guidelines component
  function TermsGuidelines() {
    return (
      <div style={{ marginTop: 10, fontSize: 13, color: '#444' }}>
        <strong>Community Guidelines</strong>
        <ul>
          <li>Be respectful — no hate, threats, or harassment.</li>
          <li>No sexual content, nudity, or explicit language.</li>
          <li>No sharing of personal or contact info.</li>
          <li>Report abusive users — we will review and act.</li>
          <li>Must be 18+ to use this site. Violations lead to suspension or ban.</li>
        </ul>
        <div style={{ marginTop: 8 }}>
          <a href="#" onClick={(e)=>{ e.preventDefault(); setShowTermsModal(true); }}>Read full Terms & Conditions</a>
        </div>
      </div>
    );
  }

  // onStart
  function onStart() {
    setMessages([]);
    trackEvent('chat_start', { method: 'start_button' });
    startSignalling();
  }

  // Render
  return (
    <div className="app-root">
      <header className="header">
        <h1>TalkNow — Chat With Stranger</h1>
        <div style={{display:'flex', alignItems:'center', gap:12}}>
          <div className="sub">Happy And Safe Chatting</div>
          <div style={{fontSize:13, color:'#0b84ff', fontWeight:700, display:'flex', alignItems:'center', gap:8}}>
            <span style={{width:10, height:10, borderRadius:999, background:'#22c55e', display:'inline-block'}} />
            <span>{onlineCount} online</span>
            {simulatedBadge && <span style={{fontSize:11, color:'#888', marginLeft:8}}>(RealTime)</span>}
          </div>
        </div>
      </header>

      <div className="layout">
        <main className="main-card">
          <div className="controls">
            <div style={{display:'flex', gap:8, alignItems:'center'}}>
              <label style={{display:'flex', alignItems:'center', gap:8}}>
                <input type="checkbox" checked={acceptedTerms} onChange={e => setAcceptedTerms(e.target.checked)} />
                <span style={{fontSize:13}}>I accept Terms & Conditions</span>
              </label>

              <label style={{display:'flex', alignItems:'center', gap:8}}>
                <input type="checkbox" checked={ageVerified} onChange={e => setAgeVerified(e.target.checked)} />
                <span style={{fontSize:13}}>I confirm I am 18+</span>
              </label>

              <button onClick={onStart} disabled={state === 'searching' || state === 'connected'} className="btn">Start</button>
              <button onClick={stop} disabled={state === 'idle'} className="btn btn-ghost">Stop</button>
			  <button onClick={toggleMute} className="btn btn-ghost">{muted ? 'Unmute' : 'Mute'}</button>
<button onClick={toggleVideo} className="btn btn-ghost">{videoOff ? 'Video On' : 'Video Off'}</button>
            </div>

            <div className="status">
              <div className="label">Status:</div>
              <div className="value" style={{marginLeft:8}}>{state}</div>
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
                <div className="chat-header" style={{alignItems:'center'}}>
                  <div style={{display:'flex', alignItems:'center', gap:8}}>
                    <div className="chat-title">Chat</div>
                    <div style={{fontSize:12, color:'#aaa'}}>{matchName ?? 'No peer'}</div>
                  </div>
                  <div style={{display:'flex', gap:8, alignItems:'center'}}>
                    <button onClick={handleReport} className="btn btn-report">Report</button>
                  </div>
                </div>

                <div className="chat-window">
                  {messages.length === 0 && <div className="empty">No messages yet — be friendly and safe.</div>}
                  {messages.map(m => (
                    <div key={m.id} style={{marginBottom:8}} className={`msg ${m.from === 'You' ? 'msg-out' : m.from === 'System' ? 'msg-system' : 'msg-in'}`}>
                      <div className="from" style={{fontSize:12, color:'#8f8f8f'}}>{m.from}</div>
                      <div className="bubble" style={{display:'inline-block', padding:8, borderRadius:8, marginTop:4, maxWidth:'85%', background: m.from === 'You' ? '#d1ffe0' : m.from === 'System' ? '#fff3c4' : '#ffffffcc'}}>
                        {m.text}
                      </div>
                      {m.from !== 'You' && m.from !== 'System' && (
                        <button style={{marginLeft:10, fontSize:11}} onClick={() => reportMessage(m)}>Report</button>
                      )}
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

                <div style={{marginTop:8}}>
                  <TermsGuidelines />
                </div>
              </div>
            </div>

            <aside className="sidebar">
              <div className="card">
                <div className="peer-name">{matchName ?? 'No peer'}</div>
                <div className="peer-status">{state === 'connected' ? 'Connected' : '—'}</div>

                <div style={{marginTop:10}}>
                  <strong>Quick Rules</strong>
                  <ol style={{fontSize:13, marginTop:6}}>
                    <li>Be civil. No hate or threats.</li>
                    <li>No sexual or explicit content.</li>
                    <li>No personal contact sharing.</li>
                    <li>Violations: warning → temporary suspension → ban.</li>
                  </ol>
                </div>

                <div style={{marginTop:10, fontSize:13}}>
                  <strong>Enforcement</strong>
                  <p style={{margin:0}}>This demo uses automated filters and user reports. Severe or repeat violations will be suspended or banned.</p>
                </div>
              </div>
            </aside>
          </div>
        </main>
      </div>

      {showTermsModal && (
        <div style={{
          position:'fixed', inset:0, display:'flex', alignItems:'center', justifyContent:'center',
          background:'rgba(0,0,0,0.45)', zIndex:9999, padding:20
        }}>
          <div style={{width:'100%', maxWidth:760, background:'#fff', borderRadius:10, padding:20, boxSizing:'border-box', maxHeight:'90vh', overflow:'auto'}}>
            <h2>Terms & Conditions — TalkNow (Short)</h2>
            <p>
              By using TalkNow you confirm you are 18 years or older and agree to follow our community rules.
              Do not share personal contact info, images containing nudity, or links. Harassment, hate speech,
              sexual content, or threats are strictly prohibited.
            </p>
            <p>
              Consequences: first verified violation will receive a warning. Second verified violation leads to a temporary suspension
              (demo: {TEMP_SUSPENSION_MINUTES} minutes). Repeated or severe violations may result in permanent ban.
            </p>

            <div style={{marginTop:12}}>
              <label style={{display:'flex', gap:8, alignItems:'center'}}>
                <input type="checkbox" checked={acceptedTerms} onChange={e => setAcceptedTerms(e.target.checked)} />
                <span>I accept these Terms & Conditions</span>
              </label>
            </div>

            <hr style={{margin:'12px 0'}} />

            <div>
              <label style={{display:'flex', gap:8, alignItems:'center'}}>
                <input type="checkbox" checked={ageVerified} onChange={e => setAgeVerified(e.target.checked)} />
                <span>I confirm I am 18 years of age or older</span>
              </label>
            </div>

            <div style={{display:'flex', gap:8, marginTop:16, justifyContent:'flex-end'}}>
              <button onClick={() => { setShowTermsModal(false); }} className="btn btn-ghost">Close</button>
              <button onClick={acceptAndClose} className="btn">Accept & Continue</button>
            </div>
          </div>
        </div>
      )}
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
