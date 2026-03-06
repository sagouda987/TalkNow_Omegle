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

  // added UI toggles & responsive state
  const [chatCollapsed, setChatCollapsed] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [isMobile, setIsMobile] = useState(false);

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
  // <-- add this:
  const manualStopRef = useRef(false);


  // input ref to manage cursor and emoji insertion
  const inputRef = useRef(null);

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

  function attachStreamToVideo(videoEl, stream, muted = false) {
    if (!videoEl) return;
    if (videoEl.srcObject !== stream) videoEl.srcObject = stream || null;
    videoEl.muted = muted;
    videoEl.autoplay = true;
    videoEl.playsInline = true;
    if (stream) videoEl.play().catch(() => {});
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

  // useWindowSize hook-like behavior to detect mobile breakpoint
  useEffect(() => {
    function onResize() {
      const w = window.innerWidth;
      setIsMobile(w <= 680);
      // automatically expand chat when desktop
      if (w > 680) setChatCollapsed(false);
    }
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // inject styles once (responsive + side-by-side chat)
  useEffect(() => {
    const css = `
@import url('https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&display=swap');

:root{
  --bg-1: #08172b;
  --bg-2: #122742;
  --surface: #f7fafc;
  --surface-strong: #ffffff;
  --ink: #0f172a;
  --ink-soft: #475569;
  --accent: #0ea5e9;
  --accent-strong: #0369a1;
  --ok: #16a34a;
  --danger: #ef4444;
  --warn: #f59e0b;
  --radius: 16px;
  --radius-sm: 12px;
  --ring: 0 0 0 2px rgba(14, 165, 233, 0.24);
}

* { box-sizing: border-box; }
html, body, #root {
  width: 100%;
  min-height: 100%;
  height: 100%;
  margin: 0;
}
body {
  font-family: "Manrope", "Segoe UI", "Helvetica Neue", sans-serif;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  background:
    radial-gradient(1200px 540px at 12% -8%, rgba(14,165,233,0.22), transparent 65%),
    radial-gradient(900px 520px at 105% 15%, rgba(56,189,248,0.16), transparent 60%),
    linear-gradient(165deg, var(--bg-1), var(--bg-2) 62%, #0d213a);
  color: #e2e8f0;
}

.app-root {
  width: min(1440px, 100vw - clamp(12px, 3vw, 38px));
  margin: clamp(10px, 2.2vw, 24px) auto;
  padding: clamp(12px, 2vw, 24px);
  border-radius: 24px;
  min-height: calc(100vh - clamp(20px, 3vw, 40px));
  display: flex;
  flex-direction: column;
  gap: clamp(12px, 1.5vw, 18px);
  background: rgba(7, 16, 29, 0.44);
  border: 1px solid rgba(148, 163, 184, 0.22);
  backdrop-filter: blur(14px);
  box-shadow: 0 22px 50px rgba(2, 6, 23, 0.38);
}
@supports not (backdrop-filter: blur(14px)) {
  .app-root { background: rgba(7, 16, 29, 0.9); }
}
@supports (min-height: 100dvh) {
  .app-root { min-height: calc(100dvh - clamp(20px, 3vw, 40px)); }
}

.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px 16px;
  flex-wrap: wrap;
  padding: 12px 14px;
  border-radius: var(--radius);
  border: 1px solid rgba(148, 163, 184, 0.25);
  background: linear-gradient(140deg, rgba(2,132,199,0.2), rgba(15,23,42,0.3));
}
.header h1 {
  margin: 0;
  font-size: clamp(1.05rem, 1.3vw + 0.85rem, 1.65rem);
  letter-spacing: 0.02em;
}
.rainbow-title {
  font-weight: 800;
  color: #eaf4ff;
  text-shadow: 0 1px 14px rgba(56, 189, 248, 0.18);
}
.sub {
  font-size: 0.86rem;
  color: rgba(226, 232, 240, 0.88);
}

.layout {
  display: block;
  width: 100%;
  min-height: 0;
}

.main-card {
  background: linear-gradient(175deg, rgba(255,255,255,0.96), rgba(241,245,249,0.94));
  border-radius: var(--radius);
  border: 1px solid rgba(203, 213, 225, 0.7);
  padding: clamp(12px, 1.6vw, 18px);
  box-shadow: 0 16px 34px rgba(15, 23, 42, 0.14);
  color: var(--ink);
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
  width: 100%;
}

.controls {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
  background: rgba(226, 232, 240, 0.55);
  border: 1px solid rgba(203, 213, 225, 0.7);
  border-radius: var(--radius-sm);
  padding: 10px;
}
.control-group {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.control-group label {
  padding: 6px 9px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.82);
  border: 1px solid rgba(148, 163, 184, 0.28);
}

.btn {
  border: 0;
  border-radius: 10px;
  padding: 9px 13px;
  font-size: 0.86rem;
  font-weight: 700;
  letter-spacing: 0.01em;
  color: #f8fafc;
  background: linear-gradient(145deg, var(--accent), var(--accent-strong));
  cursor: pointer;
  transition: transform .18s ease, box-shadow .2s ease, filter .2s ease, opacity .2s ease;
  box-shadow: 0 8px 16px rgba(2,132,199,0.22);
}
.btn:hover { transform: translateY(-1px); box-shadow: 0 10px 18px rgba(2,132,199,0.26); }
.btn:active { transform: translateY(0); }
.btn:focus-visible { outline: none; box-shadow: var(--ring); }
.btn:disabled {
  opacity: .5;
  cursor: not-allowed;
  transform: none;
  box-shadow: none;
}
.btn-ghost {
  color: #0f172a;
  background: rgba(248, 250, 252, 0.94);
  border: 1px solid rgba(148, 163, 184, 0.42);
  box-shadow: none;
}
.btn-report {
  color: #7f1d1d;
  background: #fef2f2;
  border: 1px solid #fecaca;
  box-shadow: none;
}

.status {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--ink-soft);
  font-size: .84rem;
}
.status-value {
  border-radius: 999px;
  padding: 4px 11px;
  text-transform: capitalize;
  font-weight: 700;
  letter-spacing: .01em;
}
.status-idle { background: rgba(239,68,68,0.14); color: #991b1b; }
.status-searching { background: rgba(245,158,11,0.16); color: #92400e; }
.status-connected { background: rgba(34,197,94,0.16); color: #166534; }

.media-and-chat {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
}
.media-panel {
  width: 100%;
  min-height: min(72vh, 680px);
  border-radius: var(--radius-sm);
  border: 1px solid rgba(148, 163, 184, 0.3);
  background: linear-gradient(170deg, #0b1f36 0%, #0a172a 100%);
  color: #dbeafe;
  padding: 12px;
  display: grid;
  grid-template-columns: minmax(0, 1.2fr) minmax(360px, 0.9fr);
  gap: 12px;
  align-items: stretch;
}

.videos {
  min-width: 0;
  display: grid;
  grid-template-columns: 1fr;
  grid-template-rows: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
.local, .remote {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 10px;
  border-radius: 12px;
  background: rgba(15, 23, 42, 0.55);
  border: 1px solid rgba(148, 163, 184, 0.2);
}
.caption {
  margin-bottom: 8px;
  font-size: .75rem;
  letter-spacing: .08em;
  text-transform: uppercase;
  color: rgba(226, 232, 240, 0.82);
}
.video {
  width: 100%;
  height: clamp(220px, 34vh, 460px);
  border-radius: 10px;
  object-fit: cover;
  background: #020617;
  border: 1px solid rgba(148,163,184,0.22);
  transform-origin: center;
  transition: transform .2s ease, filter .2s ease;
}
.video.default { transform: scale(1); }
.video.small { transform: scale(.96); }
.video.large { transform: scale(1.1); }

.chat-section {
  min-width: 0;
  min-height: 0;
  min-width: 360px;
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.chat-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.chat-title {
  font-size: .95rem;
  font-weight: 700;
  color: rgba(241, 245, 249, 0.94);
}
.chat-window {
  flex: 1 1 auto;
  min-height: 320px;
  max-height: none;
  overflow: auto;
  padding: 10px;
  border-radius: 10px;
  border: 1px solid rgba(148,163,184,.2);
  background: rgba(2, 6, 23, 0.36);
  scrollbar-width: thin;
}
.chat-window::-webkit-scrollbar { width: 8px; }
.chat-window::-webkit-scrollbar-thumb {
  background: rgba(148, 163, 184, 0.45);
  border-radius: 999px;
}
.empty {
  font-size: .82rem;
  color: rgba(148, 163, 184, .95);
}

.msg { margin-bottom: 10px; }
.msg .from {
  margin-bottom: 4px;
  font-size: .75rem;
  color: rgba(148,163,184,.95);
}
.bubble {
  display: inline-block;
  max-width: 88%;
  border-radius: 10px;
  padding: 8px 11px;
  line-height: 1.35;
  word-break: break-word;
  font-size: .87rem;
}
.msg-in .bubble,
.msg-system .bubble {
  background: rgba(148,163,184,.16);
  border: 1px solid rgba(148,163,184,.2);
  color: #e2e8f0;
}
.msg-out .bubble {
  background: rgba(14,165,233,.2);
  border: 1px solid rgba(56,189,248,.26);
  color: #e0f2fe;
}

.chat-input {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
}
.chat-meta {
  margin-top: 6px;
  font-size: .78rem;
  color: rgba(148, 163, 184, .95);
}
.chat-meta a {
  color: #38bdf8;
  text-decoration: none;
}
.chat-meta a:hover {
  text-decoration: underline;
}
.chat-input input {
  width: 100%;
  border: 1px solid rgba(148, 163, 184, .36);
  border-radius: 10px;
  padding: 10px 11px;
  font-size: .88rem;
  outline: 0;
}
.chat-input input:focus { box-shadow: var(--ring); border-color: rgba(14,165,233,.6); }
.emoji-btn {
  border-radius: 10px;
  border: 1px solid rgba(148,163,184,.45);
  background: #f8fafc;
  cursor: pointer;
  padding: 8px 10px;
}
.emoji-pop {
  position: absolute;
  right: 8px;
  bottom: 64px;
  z-index: 1000;
  border-radius: 12px;
  border: 1px solid rgba(148,163,184,.35);
  background: #ffffff;
  box-shadow: 0 20px 40px rgba(15,23,42,.22);
  padding: 8px;
  display: grid;
  grid-template-columns: repeat(8, 28px);
  gap: 6px;
}
.emoji-pop button {
  border: 0;
  background: transparent;
  cursor: pointer;
  font-size: 1rem;
}

.sidebar {
  width: 100%;
  max-width: 320px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.card {
  padding: 14px;
  border-radius: var(--radius-sm);
  border: 1px solid rgba(148, 163, 184, 0.35);
  background: linear-gradient(175deg, rgba(248,250,252,.95), rgba(241,245,249,.92));
  color: var(--ink);
  box-shadow: 0 14px 32px rgba(15, 23, 42, 0.15);
}
.peer-name {
  font-weight: 700;
  font-size: 1rem;
  margin-bottom: 4px;
}
.peer-status {
  font-size: .8rem;
  color: var(--ink-soft);
}
.card ol, .card ul { padding-left: 1.1rem; margin: 8px 0; color: #1e293b; }
.card p { color: #334155; }

@media (max-width: 1220px) {
  .sidebar {
    max-width: none;
  }
}
@media (max-width: 980px) {
  .media-panel {
    grid-template-columns: 1fr;
    min-height: 0;
  }
  .chat-section {
    min-width: 0;
  }
  .videos {
    grid-template-columns: 1fr 1fr;
    grid-template-rows: none;
  }
  .video {
    height: clamp(200px, 30vh, 360px);
  }
}
@media (max-width: 700px) {
  .app-root {
    width: 100vw;
    margin: 0;
    border-radius: 0;
    border-left: 0;
    border-right: 0;
    padding: 10px;
  }
  .header {
    padding: 10px;
  }
  .controls {
    padding: 8px;
  }
  .control-group {
    width: 100%;
  }
  .control-group label {
    width: 100%;
    justify-content: flex-start;
  }
  .status {
    width: 100%;
    margin-left: 0;
    justify-content: flex-start;
  }
  .media-panel {
    padding: 10px;
  }
  .videos {
    grid-template-columns: 1fr;
  }
  .video {
    height: clamp(180px, 28vh, 300px);
  }
  .chat-window {
    min-height: 180px;
    max-height: 38vh;
  }
  .chat-input {
    flex-wrap: wrap;
  }
  .chat-input .btn {
    width: 100%;
    justify-content: center;
  }
}
@media (max-width: 460px) {
  .btn {
    width: 100%;
    justify-content: center;
  }
  .control-group {
    gap: 6px;
  }
}
@media (prefers-reduced-motion: reduce) {
  * {
    animation: none !important;
    transition: none !important;
    scroll-behavior: auto !important;
  }
}

.hidden-sm { display: none; }
@media (min-width: 701px) { .hidden-sm { display: inline-block; } }
    `;
    const style = document.createElement('style');
    style.dataset.owner = 'talknow-singlefile';
    style.appendChild(document.createTextNode(css));
    document.head.appendChild(style);
    return () => {
      if (style && style.parentNode) style.parentNode.removeChild(style);
    };
  }, []);

  // ----------------- FAKE preview helpers -----------------
  const NAMES = ['Aisha', 'Carlos', 'Priya', 'Omar', 'Lina', 'John', 'Sana', 'Ravi'];
  function createCanvasStream(el, label, muted = false) {
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
    try { attachStreamToVideo(el, stream, muted); } catch (e) { /* ignore */ }
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
      setMessages([]);   // CLEAR CHAT IMMEDIATELY ON NEW MATCH
setInput('');
      console.log('[socket] matched', peer);
      if (!peer || peer === selfIdRef.current) {
        console.warn('[socket] invalid/self match ignored', { matchId, peer });
        peerIdRef.current = null;
        setMatchName(null);
        setState('searching');
        if (socketRef.current && socketRef.current.connected) {
          socketRef.current.emit('cancel');
          socketRef.current.emit('find');
        }
        return;
      }
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
      // cleanupConnection();
      // setState('idle');
      // ----> replace above with:
      attemptAutoRestart('peer-disconnected');
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
      if (fakeReplyIntervalRef.current) clearInterval(fakeReplyIntervalRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

   // fallback to a fake preview if no real peer within ~4s
   fallbackTimerRef.current = setTimeout(() => {
     if (!peerIdRef.current) startFakePreviewDuringReal();
   }, 4000);
  }

  function startFakePreviewDuringReal() {
    fakeFallbackActive.current = true;
    setMatchName('Stranger');
    setState('matched');

    try {
      const localEl = localVideoRef.current;
      const remoteEl = remoteVideoRef.current;
      if (localEl) fakePreviewRef.current.local = createCanvasStream(localEl, 'You', true);
      if (remoteEl) fakePreviewRef.current.remote = createCanvasStream(remoteEl, 'Peer', false);
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
      attachStreamToVideo(remoteVideoRef.current, remoteStreamRef.current, false);
    }

    pc.ontrack = (e) => {
      if (e.streams && e.streams[0]) {
        remoteStreamRef.current = e.streams[0];
        attachStreamToVideo(remoteVideoRef.current, remoteStreamRef.current, false);
        return;
      }
      if (!remoteStreamRef.current) remoteStreamRef.current = new MediaStream();
      const alreadyAdded = remoteStreamRef.current.getTracks().some((t) => t.id === e.track.id);
      if (!alreadyAdded) remoteStreamRef.current.addTrack(e.track);
      attachStreamToVideo(remoteVideoRef.current, remoteStreamRef.current, false);
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
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        appendSystem('Connection lost.');
        attemptAutoRestart('pc-connection-failed');
      }
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
      attachStreamToVideo(localVideoRef.current, localStreamRef.current, true);
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
      setMessages([]);
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
     dc.onclose = () => {
      appendSystem('Stranger disconnected — attempting to reconnect...');
      attemptAutoRestart('dc-closed');
    };
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
    manualStopRef.current = true;             // <-- mark manual stop so auto-restart won't happen
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
    attachStreamToVideo(localVideoRef.current, null, true);
    attachStreamToVideo(remoteVideoRef.current, null, false);
  }
// Try to auto-restart matching after a peer disconnects (respects manualStopRef and local ban)
  function attemptAutoRestart(reason = 'peer-disconnected') {
    // don't auto-restart if user manually stopped, or if local user 
    // is banned/suspended
    setMessages([]);
setInput('');
    if (manualStopRef.current) {
      appendSystem('Auto-reconnect skipped (you stopped the session).CLICK START TO FIND NEW PEOPLE.');
      return;
    }
    const myId = selfIdRef.current;
    if (myId && penaltiesRef.current[myId] && penaltiesRef.current[myId].banned) {
      appendSystem('Auto-reconnect skipped: you are banned.');
      return;
    }

    appendSystem('Peer disconnected — attempting to find a new match...');
    cleanupConnection();
    cleanupFakePreview();

    // small backoff so UI updates show before re-requesting
    setState('searching');
    setTimeout(() => {
      if (socketRef.current && socketRef.current.connected) {
        socketRef.current.emit('find');
      } else {
        // safe fallback — will connect socket and start signalling
        startSignalling();
      }
    }, 900);
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

  const [videoSize, setVideoSize] = useState('default'); // 'small' | 'default' | 'large'
function toggleVideoSize() {
  setVideoSize(s =>
    s === 'large' ? 'small' :
    s === 'small' ? 'default' :
    'large'
  );
}

  // ---------------- EMOJI PICKER ----------------
  // simple inline emoji picker — adjust list as desired
  const EMOJIS = ['😄','😊','😂','😍','😉','😢','😮','😡','👍','👎','👏','🙏','🤝','🔥','💯','🎉','🤖','🌟','💬','🥳','🤗','😎','🤔','🙌'];
  const [emojiOpen, setEmojiOpen] = useState(false);

  useEffect(() => {
    function onDocClick(e) {
      if (!emojiOpen) return;
      // close if click outside the emoji pop — inputRef isn't the pop root so we always close on document click
      setEmojiOpen(false);
    }
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, [emojiOpen]);

  function toggleEmoji(e) {
    e.stopPropagation();
    setEmojiOpen(o => !o);
    // focus input when opening
    setTimeout(() => inputRef.current && inputRef.current.focus(), 0);
  }

  function insertEmoji(emoji) {
    // insert emoji at cursor position inside the input
    const el = inputRef.current;
    if (!el) {
      setInput(prev => prev + emoji);
      return;
    }

    const start = el.selectionStart || 0;
    const end = el.selectionEnd || 0;
    const before = input.slice(0, start);
    const after = input.slice(end);
    const next = before + emoji + after;
    setInput(next);

    // move cursor after inserted emoji
    requestAnimationFrame(() => {
      if (el.setSelectionRange) {
        const pos = start + emoji.length;
        el.setSelectionRange(pos, pos);
        el.focus();
      }
    });
  }

  // onStart
    function onStart() {
    manualStopRef.current = false;            // <-- clear manual stop when user starts
    setMessages([]);
    trackEvent('chat_start', { method: 'start_button' });
    startSignalling();
  }

  // Render
  return (
    <div className="app-root">
      <header className="header">
        <h1 className="rainbow-title">TalkNow — Chat With Stranger</h1>
        <div style={{display:'flex', alignItems:'center', gap:12, flexWrap:'wrap'}}>
          <div className="sub">Happy And Safe Chatting</div>
		  <div className="sub" style={{fontSize:12, color:'rgba(226,232,240,0.78)'}}>
  Send feedback/Improvement/Queries: <strong>talknow047@gmail.com</strong>
</div>
          <div style={{fontSize:13, color:'#0b84ff', fontWeight:700, display:'flex', alignItems:'center', gap:8}}>
            <span style={{width:10, height:10, borderRadius:999, background:'#22c55e', display:'inline-block'}} />
            <span>{onlineCount} online</span>
            {simulatedBadge && <span style={{fontSize:11, color:'rgba(226,232,240,0.7)', marginLeft:8}}>(RealTime)</span>}
          </div>
        </div>
      </header>

      <div className="layout">
        <main className="main-card">
          <div className="controls">
            <div style={{display:'flex', gap:8, alignItems:'center'}} className="control-group">
              <label style={{display:'flex', alignItems:'center', gap:8}}>
                <input type="checkbox" checked={acceptedTerms} onChange={e => setAcceptedTerms(e.target.checked)} />
                <span style={{fontSize:13}}>I accept Terms & Conditions</span>
              </label>

              <label style={{display:'flex', alignItems:'center', gap:8}}>
                <input type="checkbox" checked={ageVerified} onChange={e => setAgeVerified(e.target.checked)} />
                <span style={{fontSize:13}}>I confirm I am 18+</span>
              </label>
<button onClick={toggleVideoSize} className="btn btn-ghost">
  Video Size: {videoSize}
</button>
              <button onClick={onStart} disabled={state === 'searching' || state === 'connected'} className="btn">Start</button>
              <button onClick={stop} disabled={state === 'idle'} className="btn btn-ghost">Stop</button>
              <button onClick={toggleMute} className="btn btn-ghost" aria-pressed={muted}>{muted ? 'Unmute' : 'Mute'}</button>
              <button onClick={toggleVideo} className="btn btn-ghost" aria-pressed={videoOff}>{videoOff ? 'Video On' : 'Video Off'}</button>

              {/* Chat collapse toggle */}
              <button
                onClick={() => setChatCollapsed(c => !c)}
                className="btn btn-ghost"
                aria-pressed={chatCollapsed}
                title={chatCollapsed ? "Show chat" : "Hide chat"}
              >
                {chatCollapsed ? 'Show Chat' : 'Hide Chat'}
              </button>
            </div>

            <div className="status" role="status" aria-live="polite">
              <div className="label">Status:</div>
            <div className={`status-value status-${state}`}>
  <b>{state}</b>
</div>
            </div>
          </div>

          <div className="media-and-chat">
            <div className="media-panel">
              <div className="videos">
                <div className="local">
                  <div className="caption">Local</div>
                  <video
  ref={localVideoRef}
  autoPlay
  muted
  playsInline
  className={`video ${videoSize}`}
/>
                </div>
                <div className="remote">
                  <div className="caption">Remote</div>
             <video
  ref={remoteVideoRef}
  autoPlay
  playsInline
  className={`video ${videoSize}`}
/>
                </div>
              </div>

              {/* hide chat on mobile when collapsed */}
              {! (isMobile && chatCollapsed) && (
                <div className="chat-section" aria-hidden={isMobile && chatCollapsed}>
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

    <div className="bubble">
      {m.text}
    </div>

    {m.from !== 'You' && m.from !== 'System' && (
      <button style={{marginLeft:10, fontSize:11}} onClick={() => reportMessage(m)}>Report</button>
    )}
  </div>
))}
                  </div>

                  <div style={{position:'relative'}}>
                    <div className="chat-input">
                      <input
                        ref={inputRef}
                        value={input}
                        onChange={e => setInput(e.target.value)}
                        placeholder={state === 'connected' ? 'Say hi...' : 'Start a conversation when connected.'}
                        onKeyDown={e => { if (e.key === 'Enter') send(); }}
                        disabled={state !== 'connected'}
                        aria-label="Chat message"
                      />

                      <button
                        type="button"
                        className="emoji-btn"
                        onClick={(e) => { e.stopPropagation(); toggleEmoji(e); }}
                        title="Open emoji picker"
                      >
                        😊
                      </button>

                      <button onClick={send} disabled={state !== 'connected' || !input.trim()} className="btn">Send</button>
                    </div>

                    {emojiOpen && (
                      <div className="emoji-pop" onClick={(e) => e.stopPropagation()}>
                        {EMOJIS.map((em) => (
                          <button key={em} onClick={() => insertEmoji(em)}>{em}</button>
                        ))}
                      </div>
                    )}

                  </div>

                  <div className="chat-meta">
                    Be respectful. No explicit content or personal info.{' '}
                    <a href="#" onClick={(e)=>{ e.preventDefault(); setShowTermsModal(true); }}>Read full Terms</a>
                  </div>
                </div>
              )}
            </div>

            <aside className="sidebar" aria-hidden={sidebarCollapsed}>
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
