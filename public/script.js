const socket = io('/');
const videoGrid = document.getElementById('video-grid');
const MY_NAME = (typeof USER_NAME !== 'undefined' && USER_NAME) || 'Guest';

// Join the lightweight preview channel so document preview works even
// before (or without) camera/mic access. Re-sent on every (re)connect:
// a transport drop gives the server a fresh socket without our state,
// and without this Present would silently stop working afterwards.
function sendPreviewJoin() {
  try {
    if (typeof ROOM_ID !== 'undefined' && ROOM_ID) {
      socket.emit('preview-join', {
        roomId: ROOM_ID,
        userName: MY_NAME,
        hostKey: (typeof HOST_KEY !== 'undefined' && HOST_KEY) || null,
        guest: (typeof GUEST_VIEW !== 'undefined' && GUEST_VIEW) || false,
      });
    }
  } catch {}
}
sendPreviewJoin();
socket.on('connect', sendPreviewJoin);

// Uses the embedded PeerServer at /peerjs on the same origin
const myPeer = new Peer(undefined, {
  host: location.hostname,
  port: location.port || (location.protocol === 'https:' ? 443 : 80),
  path: '/peerjs'
});

const peers = {}; // userId -> { call, tile }
let myStream = null;
let myPeerId = null;
let myTile = null;
let micOn = true;
let camOn = true;
const mediaState = () => ({ micOn, camOn });
// Normalize: server may send string (legacy) or { userName, micOn, camOn }
const normUser = v => typeof v === 'string'
  ? { userName: v, micOn: true, camOn: true }
  : { userName: (v && v.userName) || 'Guest', micOn: v?.micOn !== false, camOn: v?.camOn !== false };
const statusEl = document.getElementById('status');
const countEl = document.getElementById('count');
const setStatus = t => { if (statusEl) statusEl.textContent = t; };
function updateCount() {
  if (!countEl) return;
  const n = videoGrid.querySelectorAll('.video-tile').length;
  countEl.textContent = `${n} in call`;
}
new MutationObserver(updateCount).observe(videoGrid, { childList: true });
updateCount();

function maybeJoin() {
  if (myStream && myPeerId) {
    // Phase 4: Signaling — register name + initial mic/cam status
    socket.emit('join-room', ROOM_ID, myPeerId, MY_NAME, mediaState());
    setStatus(`[ Phase 4: Signaling ] joined as ${MY_NAME}`);
  }
}

// 1. Answer incoming calls (name + media state via Peer metadata + Socket.io)
myPeer.on('call', call => {
  const meta = call.metadata || {};
  const callerName = meta.userName || 'Guest';
  const callerMedia = { micOn: meta.micOn !== false, camOn: meta.camOn !== false };
  call.answer(myStream);
  const video = document.createElement('video');
  const tile = addVideoStream(video, null, callerName, callerMedia);
  call.on('stream', userVideoStream => {
    video.srcObject = userVideoStream;
  });
  call.on('close', () => tile.remove());
  peers[call.peer] = { call, tile };
});

// 2. Connect to newly joined users — name + media state via Socket.io
socket.on('user-connected', (userId, userName, media) => {
  const u = normUser(media ? { userName, ...media } : userName);
  if (myStream) connectToNewUser(userId, myStream, u.userName, { micOn: u.micOn, camOn: u.camOn });
});

// 3. Learn names + media state of users already in the room
socket.on('existing-users', users => {
  for (const [userId, raw] of Object.entries(users)) {
    const u = normUser(raw);
    if (myStream && !peers[userId]) connectToNewUser(userId, myStream, u.userName, { micOn: u.micOn, camOn: u.camOn });
  }
});

// Phase 5: peer toggled mic/cam → update their tile badge in real time
socket.on('user-media-updated', (userId, media) => {
  if (peers[userId]) updateTileMedia(peers[userId].tile, media);
});

// Remove tile on disconnect
socket.on('user-disconnected', userId => {
  if (peers[userId]) peers[userId].call.close();
});

// Screening files: someone uploaded to this event → refresh list so everyone can save it
// (skip the reload if a live preview is running — the file list stays valid mid-presentation)
socket.on('event-files-updated', eventId => {
  try {
    if (typeof EVENT_ID !== 'undefined' && EVENT_ID && eventId === EVENT_ID) {
      if (currentPresentation) return;
      window.location.reload();
    }
  } catch {}
});

// ---- Live preview: host presents a file + turns pages, everyone follows ----
// Only the event creator (IS_HOST) may emit; server re-checks host name.
const IS_HOST_ME = (typeof IS_HOST !== 'undefined' && IS_HOST) || false;
const FILE_INDEX = {};
try { (SCREEN_FILES || []).forEach(f => { FILE_INDEX[f.id] = f; }); } catch {}
let currentPresentation = null; // { eventId, fileId, page, scroll }
let pdfDoc = null;
let pdfFileId = null;
let pdfPages = 1;
// Render guards: the host sits in two socket rooms at once, so every update
// can arrive twice — without these, twin renders race on the same canvas.
let renderSeq = 0;
let activePdfTask = null;
let lastRenderedKey = null;
const presKey = s => s ? `${s.fileId}:${s.page}` : 'null';
const stageDoc = document.getElementById('stageDoc');
const stageBody = document.getElementById('stageBody');
const stagePlaceholder = document.getElementById('stagePlaceholder');
const pdfCanvas = document.getElementById('pdfCanvas');
const stageImg = document.getElementById('stageImg');
const stageFrame = document.getElementById('stageFrame');
const stageDocx = document.getElementById('stageDocx');
const prevBtn = document.getElementById('prevPage');
const nextBtn = document.getElementById('nextPage');
const stopBtn = document.getElementById('stopPresent');
const pageInd = document.getElementById('pageInd');
try {
  if (window.pdfjsLib) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc =
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  }
} catch {}

function fileUrl(f) { return `/uploads/${encodeURIComponent(f.storedName)}`; }
function absoluteFileUrl(f) { return `${location.origin}${fileUrl(f)}`; }
function isPdf(f) {
  return (f.mime || '') === 'application/pdf' || /\.pdf$/i.test(f.originalName || '');
}
function isImage(f) { return (f.mime || '').startsWith('image/'); }
function isOffice(f) {
  return /officedocument|msword|ms-powerpoint|ms-excel|opendocument/.test(f.mime || '') ||
    /\.(docx?|pptx?|xlsx?|odt|odp|ods|rtf)$/i.test(f.originalName || '');
}
function isDocx(f) {
  return (f.mime || '') === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    /\.docx$/i.test(f.originalName || '');
}
// Office Online viewer needs a publicly reachable URL — not localhost.
function canEmbedOffice() {
  const h = location.hostname;
  return h && !/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[?::1\]?)$/i.test(h);
}
function officeEmbedUrl(f) {
  return `https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(absoluteFileUrl(f))}`;
}
function hideStageMedia() {
  if (pdfCanvas) pdfCanvas.hidden = true;
  if (stageImg) stageImg.hidden = true;
  if (stageFrame) { stageFrame.hidden = true; stageFrame.removeAttribute('src'); }
  if (stageDocx) { stageDocx.hidden = true; }
}

// .docx stage content renders fully client-side (no public URL needed): fetch
// the file bytes from our own server and render them with docx-preview.
const docxBufferCache = {}; // storedName -> ArrayBuffer
async function fetchDocxBuffer(f) {
  const key = f.storedName;
  if (docxBufferCache[key]) return docxBufferCache[key].slice(0);
  const res = await fetch(fileUrl(f));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  docxBufferCache[key] = buf;
  return buf.slice(0);
}

// ---- Shared scrolling: host scrolls the live document, everyone follows ----
// Position travels as a 0..1 ratio so different screen sizes stay in sync.
let applyingRemoteScroll = false;
let pendingScrollRatio = null; // { fileId, ratio } applied once content renders
let lastScrollEmit = 0;
let scrollEndTimer = null;
function stageScrollRatio() {
  if (!stageDocx || stageDocx.hidden) return 0;
  const max = stageDocx.scrollHeight - stageDocx.clientHeight;
  return max > 0 ? stageDocx.scrollTop / max : 0;
}
function applyScrollRatio(ratio) {
  if (!stageDocx || stageDocx.hidden) return;
  const r = Math.max(0, Math.min(1, Number(ratio) || 0));
  const max = stageDocx.scrollHeight - stageDocx.clientHeight;
  if (max <= 0) return;
  if (Math.abs(stageDocx.scrollTop / max - r) < 0.02) return; // already there
  applyingRemoteScroll = true;
  stageDocx.scrollTop = r * max;
  requestAnimationFrame(() => { applyingRemoteScroll = false; });
}
if (stageDocx) stageDocx.addEventListener('scroll', () => {
  if (!IS_HOST_ME || applyingRemoteScroll) return;
  const f = currentPresentation && FILE_INDEX[currentPresentation.fileId];
  if (!f || !isDocx(f)) return;
  const send = () => {
    lastScrollEmit = Date.now();
    socket.emit('host-scroll', { fileId: f.id, ratio: stageScrollRatio(), hostKey: myHostKey() });
  };
  if (Date.now() - lastScrollEmit > 120) send();
  clearTimeout(scrollEndTimer);
  scrollEndTimer = setTimeout(send, 250);
}, { passive: true });
socket.on('preview-scroll', ({ fileId, ratio } = {}) => {
  if (IS_HOST_ME) return; // host drives; never follow echoes
  if (!currentPresentation || currentPresentation.fileId !== fileId) {
    pendingScrollRatio = { fileId, ratio };
    return;
  }
  if (stageDocx && !stageDocx.hidden && currentPresentation && isDocx(FILE_INDEX[fileId] || {})) {
    applyScrollRatio(ratio);
  } else {
    pendingScrollRatio = { fileId, ratio };
  }
});

function setStageControlsEnabled(on, total) {
  if (!IS_HOST_ME) {
    if (pageInd && currentPresentation) {
      const f = FILE_INDEX[currentPresentation.fileId];
      pageInd.textContent = f && isPdf(f) ? `Page ${currentPresentation.page} of ${total || pdfPages || '?'}` : (f ? f.originalName : 'Follows host');
    }
    return;
  }
  const has = !!on;
  if (prevBtn) prevBtn.disabled = !has || (currentPresentation?.page || 1) <= 1;
  if (nextBtn) nextBtn.disabled = !has || (currentPresentation?.page || 1) >= (total || pdfPages || 1) || !isPdf(FILE_INDEX[currentPresentation?.fileId] || {});
  if (stopBtn) stopBtn.disabled = !has;
  if (pageInd) pageInd.textContent = !has ? 'No doc' : `Page ${currentPresentation.page} of ${total || pdfPages}`;
}

async function renderPdfPage(file, page, seq) {
  const url = fileUrl(file);
  if (!window.pdfjsLib) {
    // Fallback: iframe with #page= anchor when PDF.js CDN is unavailable
    hideStageMedia();
    if (stageFrame) {
      stageFrame.hidden = false;
      stageFrame.src = `${url}#page=${page}`;
    }
    pdfPages = Math.max(pdfPages, page);
    return 'ok';
  }
  if (!pdfDoc || pdfFileId !== file.id) {
    cancelPdfRender();
    pdfDoc = await window.pdfjsLib.getDocument(url).promise;
    if (seq !== renderSeq) return 'stale';
    pdfFileId = file.id;
    pdfPages = pdfDoc.numPages;
  }
  const safe = Math.min(Math.max(1, page), pdfDoc.numPages);
  const pdfPage = await pdfDoc.getPage(safe);
  if (seq !== renderSeq) return 'stale';
  cancelPdfRender();
  const viewport = pdfPage.getViewport({ scale: 1.5 });
  const ctx = pdfCanvas.getContext('2d');
  pdfCanvas.width = viewport.width;
  pdfCanvas.height = viewport.height;
  const task = pdfPage.render({ canvasContext: ctx, viewport });
  activePdfTask = task;
  try {
    await task.promise;
  } catch (err) {
    if (seq !== renderSeq || (err && err.name === 'RenderingCancelledException')) return 'stale';
    throw err;
  }
  if (seq !== renderSeq) return 'stale';
  return 'ok';
}
function cancelPdfRender() {
  try { if (activePdfTask) activePdfTask.cancel(); } catch {}
  activePdfTask = null;
}

async function renderPresentation(state) {
  const prevId = currentPresentation && currentPresentation.fileId;
  currentPresentation = state;
  const hasStage = document.getElementById('stage');
  if (!hasStage) return;
  // mark which file is live
  document.querySelectorAll('.present-btn').forEach(b => {
    const live = !!(state && b.dataset.fileId === state.fileId);
    b.textContent = live ? 'Live ✓' : 'Present';
    b.classList.toggle('live', live);
  });
  if (!state) {
    pdfDoc = null; pdfFileId = null; pdfPages = 1;
    renderSeq++;
    cancelPdfRender();
    lastRenderedKey = 'null';
    hideStageMedia();
    if (stagePlaceholder) stagePlaceholder.hidden = false;
    if (stageDoc) stageDoc.textContent = 'Nothing presenting yet';
    setStageControlsEnabled(false);
    updateSwipeHint();
    return;
  }
  const file = FILE_INDEX[state.fileId];
  if (!file) {
    // File list is stale (uploaded after this page loaded) — reload once to fetch it.
    try { window.location.reload(); } catch {}
    return;
  }
  if (state.fileId !== prevId) pendingScrollRatio = null; // new doc, drop stale scroll
  // Duplicate delivery (host is in two socket rooms): already showing it.
  if (presKey(state) === lastRenderedKey) {
    markPresentBtn(state.fileId);
    if (isPdf(file)) setStageControlsEnabled(true, pdfPages);
    return;
  }
  if (stageDoc) stageDoc.textContent = file.originalName;
  if (stagePlaceholder) stagePlaceholder.hidden = true;
  if (isPdf(file)) {
    hideStageMedia();
    if (pdfCanvas) pdfCanvas.hidden = false;
    const mySeq = ++renderSeq;
    try {
      const res = await renderPdfPage(file, state.page, mySeq);
      if (res === 'stale' || mySeq !== renderSeq) return; // superseded — newer render owns the UI
      lastRenderedKey = presKey(state);
      setStageControlsEnabled(true, pdfPages);
      markPresentBtn(state.fileId);
      updateSwipeHint();
      return;
    } catch (err) {
      if (mySeq !== renderSeq) return;
      console.error('Preview failed:', err);
    }
  } else if (isImage(file)) {
    pdfDoc = null; pdfFileId = null; pdfPages = 1;
    renderSeq++;
    cancelPdfRender();
    lastRenderedKey = presKey(state);
    hideStageMedia();
    if (stageImg) {
      stageImg.hidden = false;
      stageImg.src = fileUrl(file);
      stageImg.alt = `Preview of ${file.originalName}`;
    }
    setStageControlsEnabled(true, 1);
    markPresentBtn(state.fileId);
    updateSwipeHint();
    return;
  } else if (isDocx(file)) {
    // Word documents render as one scrollable page — host scrolls, all follow.
    pdfDoc = null; pdfFileId = null; pdfPages = 1;
    renderSeq++;
    cancelPdfRender();
    const mySeq = renderSeq;
    hideStageMedia();
    if (stagePlaceholder) stagePlaceholder.hidden = true;
    if (stageDocx) {
      stageDocx.hidden = false;
      stageDocx.innerHTML = '<p class="sub-dim">Loading document…</p>';
      try {
        if (!window.docx || typeof window.docx.renderAsync !== 'function') {
          throw new Error('docx renderer unavailable');
        }
        const buf = await fetchDocxBuffer(file);
        if (mySeq !== renderSeq) return; // superseded
        stageDocx.innerHTML = '';
        const body = document.createElement('div');
        body.className = 'docx-body';
        stageDocx.append(body);
        await window.docx.renderAsync(buf, body);
        if (mySeq !== renderSeq) return; // superseded
        lastRenderedKey = presKey(state);
        const r = (pendingScrollRatio && pendingScrollRatio.fileId === file.id) ? pendingScrollRatio.ratio
          : (typeof state.scroll === 'number' ? state.scroll : null);
        pendingScrollRatio = null;
        if (r != null) applyScrollRatio(r);
      } catch (err) {
        console.error('docx stage preview failed:', err);
        stageDocx.innerHTML =
          `<p class="sub-dim">Could not render here — <a href="${fileUrl(file)}" target="_blank" rel="noopener">open in a new tab</a>.</p>`;
      }
    }
    setStageControlsEnabled(true, 1);
    if (pageInd) {
      pageInd.textContent = IS_HOST_ME ? 'Scroll — everyone follows you' : `${file.originalName} — follows host`;
    }
    if (prevBtn) prevBtn.disabled = true;
    if (nextBtn) nextBtn.disabled = true;
    markPresentBtn(state.fileId);
    updateSwipeHint();
    return;
  }
  // Other types (video/audio/docs): show Open link inside the stage
  pdfDoc = null; pdfFileId = null; pdfPages = 1;
  renderSeq++;
  cancelPdfRender();
  lastRenderedKey = presKey(state);
  hideStageMedia();
  if (isOffice(file) && canEmbedOffice() && stageFrame) {
    if (stagePlaceholder) stagePlaceholder.hidden = true;
    stageFrame.hidden = false;
    stageFrame.src = officeEmbedUrl(file);
    setStageControlsEnabled(true, 1);
    if (pageInd) {
      pageInd.textContent = IS_HOST_ME
        ? 'Use the viewer’s own page controls'
        : `${file.originalName} — follows host`;
    }
    markPresentBtn(state.fileId);
    return;
  }
  if (stagePlaceholder) {
    stagePlaceholder.hidden = false;
    stagePlaceholder.innerHTML =
      isOffice(file) && !canEmbedOffice()
        ? `This document needs a public link for inline preview — <a href="${fileUrl(file)}" target="_blank" rel="noopener">open it in a new tab</a> while the host narrates.`
        : `This file can't be paged inline — <a href="${fileUrl(file)}" target="_blank" rel="noopener">open it in a new tab</a> while the host narrates.`;
  }
  setStageControlsEnabled(true, 1);
  markPresentBtn(state.fileId);
  updateSwipeHint();
}

function markPresentBtn(fileId) {
  document.querySelectorAll('.present-btn').forEach(b => {
    const live = b.dataset.fileId === fileId;
    b.textContent = live ? 'Live ✓' : 'Present';
    b.classList.toggle('live', live);
  });
  // Visible to everyone (host + viewers): which file is on the shared stage.
  document.querySelectorAll('.screen-file-list li[data-file-id]').forEach(li => {
    const live = !!fileId && li.dataset.fileId === fileId;
    li.classList.toggle('live-file', live);
    li.querySelectorAll('[data-live-pill]').forEach(p => { p.hidden = !live; });
  });
}
function myHostKey() {
  try { return (typeof HOST_KEY !== 'undefined' && HOST_KEY) || null; } catch { return null; }
}

socket.on('presentation-updated', state => {
  clearTimeout(presentWatchdog);
  renderPresentation(state);
});

// Host-only controls (buttons only exist for the host; server re-checks the key)
let presentWatchdog = null;
function watchPresent(fileId, action) {
  clearTimeout(presentWatchdog);
  presentWatchdog = setTimeout(() => {
    const stillWaiting = action === 'stop'
      ? !!currentPresentation
      : (!currentPresentation || currentPresentation.fileId !== fileId);
    if (stillWaiting && stageDoc) {
      stageDoc.textContent = '⚠ Preview didn’t respond — check connection, then rejoin via your host link';
    }
  }, 2500);
}
document.addEventListener('click', e => {
  const btn = e.target.closest('.present-btn');
  if (!btn || !IS_HOST_ME) return;
  const fileId = btn.dataset.fileId;
  socket.emit('host-presentation', { fileId, page: 1, hostKey: myHostKey() });
  watchPresent(fileId, 'present');
});
if (prevBtn) prevBtn.onclick = () => {
  if (!IS_HOST_ME || !currentPresentation) return;
  socket.emit('host-presentation', { fileId: currentPresentation.fileId, page: currentPresentation.page - 1, hostKey: myHostKey() });
  watchPresent(currentPresentation.fileId, 'present');
};
if (nextBtn) nextBtn.onclick = () => {
  if (!IS_HOST_ME || !currentPresentation) return;
  socket.emit('host-presentation', { fileId: currentPresentation.fileId, page: currentPresentation.page + 1, hostKey: myHostKey() });
  watchPresent(currentPresentation.fileId, 'present');
};
if (stopBtn) stopBtn.onclick = () => {
  if (!IS_HOST_ME) return;
  socket.emit('host-presentation-stop', { hostKey: myHostKey() });
  watchPresent(null, 'stop');
};

// ---- Slide to turn pages (touch screens): host swipes sideways on the
// preview to flip pages, exactly like the Prev/Next buttons. Viewers'
// swipes are ignored — only the host drives the shared page (enforced
// client-side here and again by host key on the server).
const swipeHint = document.getElementById('swipeHint');
function updateSwipeHint() {
  if (!swipeHint) return;
  const f = currentPresentation && FILE_INDEX[currentPresentation.fileId];
  swipeHint.hidden = !(IS_HOST_ME && f && isPdf(f));
}
let touchStart = null;
if (stageBody) {
  stageBody.addEventListener('touchstart', e => {
    if (!e.touches || e.touches.length !== 1) { touchStart = null; return; }
    const t = e.touches[0];
    touchStart = { x: t.clientX, y: t.clientY };
  }, { passive: true });
  stageBody.addEventListener('touchend', e => {
    if (!touchStart) return;
    const t = (e.changedTouches && e.changedTouches[0]) || null;
    const start = touchStart;
    touchStart = null;
    if (!t || !IS_HOST_ME || !currentPresentation) return;
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    if (Math.abs(dx) < 60 || Math.abs(dx) < 2 * Math.abs(dy)) return; // need a clear sideways slide
    if (dx < 0) {
      if (nextBtn && !nextBtn.disabled) nextBtn.click();
    } else {
      if (prevBtn && !prevBtn.disabled) prevBtn.click();
    }
  }, { passive: true });
  stageBody.addEventListener('touchcancel', () => { touchStart = null; }, { passive: true });
}
// Desktop convenience: left/right arrows turn pages for the host.
document.addEventListener('keydown', e => {
  if (!IS_HOST_ME || !currentPresentation) return;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test((e.target && e.target.tagName) || '')) return;
  if (e.key === 'ArrowRight' && nextBtn && !nextBtn.disabled) { e.preventDefault(); nextBtn.click(); }
  else if (e.key === 'ArrowLeft' && prevBtn && !prevBtn.disabled) { e.preventDefault(); prevBtn.click(); }
});

// 4. Local stream, then join (join only when BOTH stream + peer ready — avoids race)
navigator.mediaDevices.getUserMedia({ video: true, audio: true })
  .then(stream => {
    myStream = stream;
    const myVideo = document.createElement('video');
    myVideo.muted = true;
    myTile = addVideoStream(myVideo, stream, `${MY_NAME} (you)`, mediaState());
    setStatus('[ Phase 5: P2P Stream ] live — calling peers directly');
    maybeJoin();
  })
  .catch(err => {
    console.error('Camera/mic error:', err);
    videoGrid.innerHTML = '<p class="err">Could not access camera/mic. Check permissions.</p>';
  });

myPeer.on('open', id => {
  myPeerId = id;
  setStatus('[ Phase 3: Room Init ] got Peer ID, waiting for camera…');
  maybeJoin();
});

function connectToNewUser(userId, stream, userName = 'Guest', media = { micOn: true, camOn: true }) {
  const call = myPeer.call(userId, stream, { metadata: { userName: MY_NAME, ...mediaState() } });
  if (!call) return;
  const video = document.createElement('video');
  const tile = addVideoStream(video, null, userName, media);
  call.on('stream', userVideoStream => {
    video.srcObject = userVideoStream;
  });
  call.on('close', () => tile.remove());
  peers[userId] = { call, tile };
}

// Phase 5: Call & Controls — toggles sync UI on all peers via Socket
const muteBtn = document.getElementById('muteBtn');
const videoBtn = document.getElementById('videoBtn');
if (muteBtn) muteBtn.onclick = () => {
  if (!myStream) return;
  const track = myStream.getAudioTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  micOn = track.enabled;
  muteBtn.textContent = micOn ? 'Mute microphone' : 'Unmute microphone';
  muteBtn.classList.toggle('off', !micOn);
  muteBtn.setAttribute('aria-pressed', String(!micOn));
  if (myTile) updateTileMedia(myTile, mediaState());
  socket.emit('media-toggle', mediaState());
};
if (videoBtn) videoBtn.onclick = () => {
  if (!myStream) return;
  const track = myStream.getVideoTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  camOn = track.enabled;
  videoBtn.textContent = camOn ? 'Stop video' : 'Start video';
  videoBtn.classList.toggle('off', !camOn);
  videoBtn.setAttribute('aria-pressed', String(!camOn));
  if (myTile) updateTileMedia(myTile, mediaState());
  socket.emit('media-toggle', mediaState());
};

// Phase 6: Teardown — tab close alerts server, survivors remove tile
window.addEventListener('beforeunload', () => {
  try { socket.emit('leave-room'); } catch {}
  try { myPeer.destroy(); } catch {}
  if (myStream) myStream.getTracks().forEach(t => t.stop());
});

// Phase 5: tiles show name + live mic/cam badges, synced via Socket
function renderTag(base, { micOn = true, camOn = true } = {}) {
  return `${base}${micOn ? '' : ' · Muted'}${camOn ? '' : ' · Video off'}`;
}
function updateTileMedia(tile, media = {}) {
  if (!tile) return;
  tile._media = { micOn: media.micOn !== false, camOn: media.camOn !== false };
  const tag = tile.querySelector('.name-tag');
  if (tag) tag.textContent = renderTag(tile._baseName || 'Guest', tile._media);
  tile.classList.toggle('cam-off', !tile._media.camOn);
}
function addVideoStream(video, stream, displayName = 'Guest', media = { micOn: true, camOn: true }) {
  const tile = document.createElement('div');
  tile.className = 'video-tile';
  if (stream) tile.classList.add('own-tile'); // local self-view (used for mobile PiP)
  video.playsInline = true;
  video.autoplay = true;
  if (stream) video.srcObject = stream;
  video.addEventListener('loadedmetadata', () => video.play().catch(() => {}));
  const tag = document.createElement('div');
  tag.className = 'name-tag';
  tile._baseName = displayName;
  tile._media = { micOn: media.micOn !== false, camOn: media.camOn !== false };
  tag.textContent = renderTag(displayName, tile._media);
  tile.classList.toggle('cam-off', !tile._media.camOn);
  tile.append(video, tag);
  videoGrid.append(tile);
  return tile;
}
