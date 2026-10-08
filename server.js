const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const session = require('express-session');
const { ExpressPeerServer } = require('peer');
const app = express();
const server = http.createServer(app);
const io = require('socket.io')(server);
const { v4: uuidV4 } = require('uuid');
const ngrok = require("@ngrok/ngrok");

app.set('view engine', 'ejs');
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
// Remembers which events this browser created (host keys) so the creator
// keeps host controls without pasting keys. Keys also travel via ?hostKey=
// links for other devices. Display names alone NEVER grant host power.
app.use(session({
  secret: process.env.SESSION_SECRET || 'minizoom-dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 30 },
}));
function sessionKeys(req) {
  if (!Array.isArray(req.session.hostKeys)) req.session.hostKeys = [];
  return req.session.hostKeys;
}
function mergeQueryKeys(req) {
  const keys = sessionKeys(req);
  const raw = req.query.hostKey;
  const list = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  list.map(String).filter(k => k.length >= 8 && k.length <= 64).forEach(k => {
    if (!keys.includes(k)) keys.push(k);
  });
  while (keys.length > 50) keys.shift();
  return keys;
}
// Host proof: user-created events need the secret hostKey; built-in demo
// events (fictional hosts) keep the legacy display-name match.
function isHostFor(event, userName, hostKey, keyList = []) {
  if (!event) return false;
  if (event.custom) {
    const candidates = [hostKey, ...keyList].filter(Boolean).map(String);
    return candidates.some(k => k === event.hostKey);
  }
  return !!userName && userName === event.host;
}

// ---- Screening files (uploads) ----
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
app.use('/uploads', express.static(uploadsDir));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${uuidV4().slice(0, 8)}${ext}`);
  }
});
const BLOCKED_EXT = new Set(['.exe', '.bat', '.cmd', '.msi', '.ps1', '.sh', '.dll']);
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024, files: 5 },
  fileFilter: (req, file, cb) => {
    if (BLOCKED_EXT.has(path.extname(file.originalname).toLowerCase())) {
      return cb(new Error('That file type is not allowed for screening.'));
    }
    cb(null, true);
  }
});
const toFileMeta = (f, uploadedBy) => ({
  id: uuidV4().slice(0, 8),
  originalName: f.originalname,
  storedName: f.filename,
  mime: f.mimetype,
  size: f.size,
  uploadedBy: (uploadedBy || 'Guest').toString().slice(0, 20),
});
// Files attached to built-in (non-custom) events live here since those events are rebuilt per request.
const builtInEventFiles = {};

// PeerJS signalling embedded in the same Express process.
// No second process / port needed. Client connects to /peerjs.
const peerServer = ExpressPeerServer(server, {
  debug: true,
  path: '/'
});
app.use('/peerjs', peerServer);

// Phase 2 data: event schedule (UTC). Times are localized in lobby.ejs.
// Defaults + user-created events (in-memory). CREATE via POST /events.
const customEvents = [];
function findEventById(id) {
  return getEvents().find(e => e.id === id);
}
function getEvents() {
  const now = Date.now();
  const iso = ms => new Date(now + ms).toISOString();
  const defaults = [
    { id: 'evt-standup', title: 'Team Standup', roomId: 'team-standup', startsAtUTC: iso(15 * 60 * 1000), durationMin: 15, host: 'Ada' },
    { id: 'evt-design', title: 'Design Review', roomId: 'design-review', startsAtUTC: iso(2 * 60 * 60 * 1000), durationMin: 45, host: 'Grace' },
    { id: 'evt-allhands', title: 'All Hands', roomId: 'all-hands', startsAtUTC: iso(5 * 60 * 60 * 1000), durationMin: 60, host: 'Linus' },
  ].map(e => ({ ...e, files: builtInEventFiles[e.id] || [] }));
  return [...defaults, ...customEvents];
}

// ---- Persist user-created events to disk so titles, rooms, host keys and
// screening-file metadata survive server restarts. (Uploaded file bytes
// already live in uploads/.) Live presentation state stays in-memory.
const dataDir = path.join(__dirname, 'data');
const eventsFile = path.join(dataDir, 'events.json');
function saveEvents() {
  try {
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(eventsFile, JSON.stringify({ customEvents, builtInEventFiles }, null, 2));
  } catch (err) {
    console.error('Could not save events:', err.message);
  }
}
function loadPersistedEvents() {
  try {
    if (!fs.existsSync(eventsFile)) return;
    const raw = JSON.parse(fs.readFileSync(eventsFile, 'utf8'));
    if (raw && Array.isArray(raw.customEvents)) {
      raw.customEvents
        .filter(e => e && typeof e.id === 'string' && typeof e.roomId === 'string')
        .forEach(e => {
          e.files = Array.isArray(e.files) ? e.files : [];
          customEvents.push(e);
        });
    }
    if (raw && raw.builtInEventFiles && typeof raw.builtInEventFiles === 'object') {
      Object.entries(raw.builtInEventFiles).forEach(([k, v]) => {
        if (Array.isArray(v)) builtInEventFiles[k] = v;
      });
    }
    console.log(`Loaded ${customEvents.length} saved event(s) from disk.`);
  } catch (err) {
    console.error('Could not load saved events:', err.message);
  }
}
loadPersistedEvents();

// Phase 1: Name Entry — landing page
app.get('/', (req, res) => {
  res.render('index');
});

// Phase 2: CREATE a new event → appears in schedule, JOIN via its room
// Supports optional screening files via multipart field "screenFiles" (up to 5).
app.post('/events', upload.array('screenFiles', 5), (req, res) => {
  const host = ((req.query.name || req.body.host || 'Guest')).toString().slice(0, 20);
  const title = (req.body.title || 'Untitled').toString().slice(0, 60);
  const roomId = (req.body.roomId || uuidV4().slice(0, 8)).toString().trim().slice(0, 40);
  const durationMin = Math.min(Math.max(parseInt(req.body.durationMin || '30', 10) || 30, 5), 240);
  let startsAtUTC = req.body.startsAtUTC;
  if (!startsAtUTC || isNaN(Date.parse(startsAtUTC))) {
    // Supports new startsInValue+startsInUnit and legacy startsInMin
    const unitMultipliers = { minutes: 1, hours: 60, days: 1440 };
    const unit = unitMultipliers[req.body.startsInUnit] || 1;
    const rawValue = req.body.startsInValue ?? req.body.startsInMin ?? '30';
    const value = Math.max(parseInt(rawValue, 10) || 30, 1);
    const inMin = Math.min(value * unit, 525600); // cap at ~1 year
    startsAtUTC = new Date(Date.now() + inMin * 60 * 1000).toISOString();
  } else {
    startsAtUTC = new Date(startsAtUTC).toISOString();
  }
  const files = (req.files || []).map(f => toFileMeta(f, host));
  const hostKey = uuidV4();
  const id = uuidV4();
  customEvents.push({ id, title, roomId, startsAtUTC, durationMin, host, custom: true, files, hostKey });
  sessionKeys(req).push(hostKey);
  saveEvents();
  // hostKey in the URL = the creator's host link (bookmark it — it unlocks
  // presenter controls on any device; viewers never receive it).
  // created= flags the lobby to show the share banner for this event.
  res.redirect(`/lobby?name=${encodeURIComponent(host)}&hostKey=${encodeURIComponent(hostKey)}&created=${encodeURIComponent(id)}`);
});

// Add screening file(s) to an existing event — lets attendees contribute files to be screened.
app.post('/events/:id/files', upload.array('screenFiles', 5), (req, res) => {
  const custom = customEvents.find(e => e.id === req.params.id);
  const returnTo = (req.body.returnTo || req.query.returnTo || '').toString();
  const name = ((req.query.name || req.body.host || 'Guest')).toString().slice(0, 20);
  const newFiles = (req.files || []).map(f => toFileMeta(f, name));
  if (custom) {
    custom.files = [...(custom.files || []), ...newFiles];
  } else if (['evt-standup', 'evt-design', 'evt-allhands'].includes(req.params.id)) {
    builtInEventFiles[req.params.id] = [...(builtInEventFiles[req.params.id] || []), ...newFiles];
  } else {
    // Unknown event: clean up uploaded files
    newFiles.forEach(f => { try { fs.unlinkSync(path.join(uploadsDir, f.storedName)); } catch {} });
    return res.status(404).send('Event not found');
  }
  // Notify room participants live (room clients listen for this)
  io.emit('event-files-updated', req.params.id);
  saveEvents();
  if (returnTo.startsWith('/')) return res.redirect(returnTo);
  res.redirect(`/lobby?name=${encodeURIComponent(name)}`);
});

// Remove a screening file (the event host may remove any file; uploaders may
// remove their own). Stops the live preview if it was showing this file.
app.post('/events/:id/files/:fileId/remove', (req, res) => {
  const body = req.body || {};
  const name = ((req.query.name || body.host || 'Guest')).toString().slice(0, 20);
  const returnTo = (body.returnTo || req.query.returnTo || '').toString();
  const backHref = `/lobby?name=${encodeURIComponent(name)}`;
  const event = findEventById(req.params.id);
  if (!event) {
    return res.status(404).render('error', {
      status: 404, heading: 'Event not found.',
      message: 'This event may already have been cancelled.',
      backHref, backLabel: '← Back to lobby',
    });
  }
  const idx = (event.files || []).findIndex(f => f.id === req.params.fileId);
  if (idx === -1) {
    return res.status(404).render('error', {
      status: 404, heading: 'File not found.',
      message: 'This file may already have been removed.',
      backHref, backLabel: '← Back to lobby',
    });
  }
  const file = event.files[idx];
  const keys = mergeQueryKeys(req);
  const given = ((req.query.hostKey || body.hostKey || '')).toString();
  const allowed = isHostFor(event, name, given, keys)
    || (name !== 'Guest' && (((file.uploadedBy || event.host) || 'Guest') === name));
  if (!allowed) {
    return res.status(403).render('error', {
      status: 403, heading: 'Cannot remove this file.',
      message: 'Only the event host or the person who uploaded it can remove it.',
      backHref, backLabel: '← Back to lobby',
    });
  }
  event.files.splice(idx, 1);
  try { fs.unlinkSync(path.join(uploadsDir, file.storedName)); } catch {}
  const rid = event.roomId;
  if (rid && presentations[rid] && presentations[rid].fileId === file.id) {
    delete presentations[rid];
    io.to(rid).emit('presentation-updated', null);
    io.to(`preview:${rid}`).emit('presentation-updated', null);
  }
  saveEvents();
  io.emit('event-files-updated', event.id);
  if (returnTo.startsWith('/')) return res.redirect(returnTo);
  res.redirect(backHref);
});

// Download / save a screening file with its original filename.
app.get('/events/:id/files/:fileId', (req, res) => {
  const event = findEventById(req.params.id);
  if (!event) return res.status(404).send('Event not found');
  const file = (event.files || []).find(f => f.id === req.params.fileId);
  if (!file) return res.status(404).send('File not found');
  const abs = path.join(uploadsDir, file.storedName);
  if (!abs.startsWith(uploadsDir) || !fs.existsSync(abs)) return res.status(404).send('File missing');
  res.download(abs, file.originalName);
});

// Phase 2: CANCEL a user-created event (only the host-key holder sees the button)
app.post('/events/:id/cancel', (req, res) => {
  const host = ((req.query.name || 'Guest')).toString().slice(0, 20);
  const backHref = `/lobby?name=${encodeURIComponent(host)}`;
  const idx = customEvents.findIndex(e => e.id === req.params.id);
  if (idx === -1) {
    return res.status(404).render('error', {
      status: 404, heading: 'Event not found.',
      message: 'This event may already have been cancelled.',
      backHref, backLabel: '← Back to lobby',
    });
  }
  const keys = mergeQueryKeys(req);
  const given = ((req.query.hostKey || req.body.hostKey || '')).toString();
  if (!isHostFor(customEvents[idx], host, given, keys)) {
    return res.status(403).render('error', {
      status: 403, heading: 'Cannot cancel this event.',
      message: 'Only the event creator (host link) can cancel it.',
      backHref, backLabel: '← Back to lobby',
    });
  }
  const [removed] = customEvents.splice(idx, 1);
  (removed.files || []).forEach(f => {
    try { fs.unlinkSync(path.join(uploadsDir, f.storedName)); } catch {}
  });
  saveEvents();
  res.redirect(`/lobby?name=${encodeURIComponent(host)}`);
});

// Phase 2: Event Lobby — schedule + localized times + room pick
app.get('/lobby', (req, res) => {
  const userName = (req.query.name || 'Guest').toString().slice(0, 20);
  const keys = mergeQueryKeys(req);
  const events = getEvents();
  // Which events may this browser control? + the exact key per owned event
  // (server-side only — keys are echoed back solely into the holder's links).
  const hostOf = {};
  const hostKeyOf = {};
  events.forEach(e => {
    const mine = e.custom && keys.includes(e.hostKey);
    hostOf[e.id] = e.custom ? mine : isHostFor(e, userName);
    if (mine) hostKeyOf[e.id] = e.hostKey;
  });
  const occupancy = Object.fromEntries(
    Object.entries(rooms).map(([roomId, users]) => [roomId, Object.keys(users).length])
  );
  // justCreated drives the "share this event" banner — only shown to the
  // proven host, and the banner's viewer link NEVER carries the hostKey.
  const createdId = (req.query.created || '').toString().slice(0, 64);
  let justCreated = createdId ? events.find(e => e.id === createdId) || null : null;
  if (justCreated && !(justCreated.custom && keys.includes(justCreated.hostKey))) {
    justCreated = null;
  }
  res.render('lobby', { userName, events, occupancy, hostOf, hostKeyOf, justCreated });
});

// WebSocket signalling rooms map (also used for lobby occupancy)
// Phase 4: registers name + initial mic/cam status per Peer ID
const rooms = {}; // { roomId: { userId: { userName, micOn, camOn } } }
// Live preview state per room: { eventId, fileId, page } — only the event host may change it.
const presentations = {}; // { roomId: { eventId, fileId, page } }
function getEventByRoom(roomId) {
  return getEvents().find(e => e.roomId === roomId) || null;
}

// Helper for "Create room" button — preserves ?name=
app.get('/new', (req, res) => {
  const name = req.query.name ? `?name=${encodeURIComponent(req.query.name)}` : '';
  res.redirect(`/${uuidV4()}${name}`);
});

// Render the video room. Name comes as ?name= via landing page.
// Anyone opening a bare invite link (no ?name=) first gets a display-name
// prompt — including the host. Host powers are unaffected: the hostKey
// travels via session + the gate form's hidden field, never via the name.
const RESERVED = new Set(['lobby', 'new', 'events', 'uploads', 'favicon.ico']);
app.get('/:room', (req, res) => {
  if (RESERVED.has(req.params.room)) return res.sendStatus(404);
  const hasName = typeof req.query.name !== 'undefined';
  const userName = (req.query.name || 'Guest').toString().slice(0, 20);
  // Guest invite links (?guest=1) never inherit host powers from this
  // browser's session — only an explicit hostKey in the URL still counts.
  const guestView = req.query.guest === '1';
  const keys = guestView ? [] : mergeQueryKeys(req);
  const event = getEvents().find(e => e.roomId === req.params.room) || null;
  const given = ((req.query.hostKey || '')).toString();
  const isHost = isHostFor(event, userName, given, keys);
  if (!hasName) {
    return res.render('enter-name', { roomId: req.params.room, event, hostKey: given || null, guestView });
  }
  // pageKey unlocks presenter controls in this room; only embedded when valid.
  const pageKey = (isHost && event && event.custom) ? event.hostKey : null;
  res.render('room', { roomId: req.params.room, userName, event, isHost, pageKey, guestView });
});

// WebSocket signalling logic
// Workflow: [ Video Room ] --(join-room + name)--> server --(user-connected + name)--> other tiles

io.on('connection', socket => {
  // Phase 4: register user into room with name + initial mic/cam status
  socket.on('join-room', (roomId, userId, userName, media) => {
    userName = (userName || 'Guest').toString().slice(0, 20);
    const micOn = media && typeof media.micOn === 'boolean' ? media.micOn : true;
    const camOn = media && typeof media.camOn === 'boolean' ? media.camOn : true;
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.userId = userId;
    socket.data.userName = userName;

    if (!rooms[roomId]) rooms[roomId] = {};

    // Send existing users (with media state) to the newcomer
    socket.emit('existing-users', rooms[roomId]);

    rooms[roomId][userId] = { userName, micOn, camOn };

    // Broadcast newcomer name + media state to everyone else
    socket.to(roomId).emit('user-connected', userId, userName, { micOn, camOn });

    // Send current live-preview state to the newcomer so they sync instantly
    socket.emit('presentation-updated', presentations[roomId] || null);
  });

  // Phase 5: real-time mic/cam toggle sync → update tiles on all peers
  socket.on('media-toggle', ({ micOn, camOn } = {}) => {
    const { roomId, userId } = socket.data;
    if (!roomId || !userId || !rooms[roomId]?.[userId]) return;
    if (typeof micOn === 'boolean') rooms[roomId][userId].micOn = micOn;
    if (typeof camOn === 'boolean') rooms[roomId][userId].camOn = camOn;
    socket.to(roomId).emit('user-media-updated', userId, {
      micOn: rooms[roomId][userId].micOn,
      camOn: rooms[roomId][userId].camOn,
    });
  });

  // Live preview (host-only): creator picks a file + page, everyone follows.
  // Security: only the event host's display name may drive the preview.
  // Preview works even before/without camera: clients join a lightweight
  // `preview:<roomId>` channel on page load (see preview-join below).
  function previewIdentity() {
    const { roomId, userName, previewRoom, previewUser } = socket.data;
    if (roomId) return { rid: roomId, uname: userName };
    if (previewRoom) return { rid: previewRoom, uname: previewUser };
    return { rid: null, uname: null };
  }
  function broadcastPreview(rid, state) {
    io.to(rid).emit('presentation-updated', state);
    io.to(`preview:${rid}`).emit('presentation-updated', state);
  }
  socket.on('preview-join', ({ roomId, userName, hostKey, guest } = {}) => {
    roomId = (roomId || '').toString().slice(0, 40);
    userName = (userName || 'Guest').toString().slice(0, 20);
    if (!roomId) return;
    socket.join(`preview:${roomId}`);
    socket.data.previewRoom = roomId;
    socket.data.previewUser = userName;
    socket.data.hostKey = (hostKey || '').toString().slice(0, 64) || null;
    // Guest invite-link viewers are view-only: they can never drive the
    // preview, even on built-in events where hosting is name-based.
    socket.data.guestViewer = !!guest;
    socket.emit('presentation-updated', presentations[roomId] || null);
  });
  // True only for the proven event creator — names alone grant nothing on
  // user-created events, so viewers can never hijack or kill a share.
  function canDrivePreview(event, socketKey, userName) {
    if (!event) return false;
    if (event.custom) return !!event.hostKey && socketKey === event.hostKey;
    return !!userName && userName === event.host;
  }
  socket.on('host-presentation', ({ fileId, page, hostKey } = {}) => {
    const { rid, uname } = previewIdentity();
    if (!rid) return;
    const event = getEventByRoom(rid);
    if (!event) return;
    if (socket.data.guestViewer) return; // guest invite link — view only
    const key = ((hostKey || socket.data.hostKey || '')).toString() || null;
    if (!canDrivePreview(event, key, uname)) return;
    const file = (event.files || []).find(f => f.id === fileId);
    if (!file) return;
    const safePage = Math.max(1, parseInt(page, 10) || 1);
    const prev = presentations[rid];
    presentations[rid] = {
      eventId: event.id,
      fileId: file.id,
      page: safePage,
      // keep scroll when re-presenting the same file, else start at top
      scroll: (prev && prev.fileId === file.id && typeof prev.scroll === 'number') ? prev.scroll : 0,
    };
    broadcastPreview(rid, presentations[rid]);
  });

  // Shared scrolling: host scrolls the live document → all viewers follow.
  // Position is a 0..1 ratio so different screen sizes stay in sync.
  // Sender is excluded (it already scrolled itself) — viewers only follow.
  socket.on('host-scroll', ({ fileId, ratio, hostKey } = {}) => {
    const { rid, uname } = previewIdentity();
    if (!rid) return;
    const event = getEventByRoom(rid);
    if (!event) return;
    if (socket.data.guestViewer) return; // guest invite link — view only
    const key = ((hostKey || socket.data.hostKey || '')).toString() || null;
    if (!canDrivePreview(event, key, uname)) return;
    const cur = presentations[rid];
    if (!cur || cur.fileId !== fileId) return; // only the live file
    cur.scroll = Math.max(0, Math.min(1, Number(ratio) || 0));
    const msg = { fileId: cur.fileId, ratio: cur.scroll };
    socket.to(rid).emit('preview-scroll', msg);
    socket.to(`preview:${rid}`).emit('preview-scroll', msg);
  });

  socket.on('host-presentation-stop', ({ hostKey } = {}) => {
    const { rid, uname } = previewIdentity();
    if (!rid) return;
    const event = getEventByRoom(rid);
    if (!event) return;
    if (socket.data.guestViewer) return; // guest invite link — view only
    const key = ((hostKey || socket.data.hostKey || '')).toString() || null;
    if (!canDrivePreview(event, key, uname)) return;
    delete presentations[rid];
    broadcastPreview(rid, null);
  });

  // Phase 6: explicit leave (beforeunload) + tab-close disconnect share cleanup
  function leaveRoom() {
    const { roomId, userId } = socket.data;
    if (roomId && userId) {
      if (rooms[roomId]) delete rooms[roomId][userId];
      socket.to(roomId).emit('user-disconnected', userId);
      // Clear stale preview once the room is empty
      if (rooms[roomId] && Object.keys(rooms[roomId]).length === 0) {
        delete presentations[roomId];
      }
      socket.data.roomId = null;
      socket.data.userId = null;
    }
  }
  socket.on('leave-room', leaveRoom);
  socket.on('disconnect', leaveRoom);
});

const PORT = process.env.PORT || 3000;
// Friendly errors for screening uploads (too large / blocked type)
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const msg = err.code === 'LIMIT_FILE_SIZE' ? 'File too large (max 50 MB each).' : err.message;
    return res.status(400).send(msg);
  }
  if (err && /file type/i.test(err.message || '')) return res.status(400).send(err.message);
  next(err);
});
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  forwardToApp();
});

async function forwardToApp() {
  if (!process.env.NGROK_AUTHTOKEN) {
    console.log('ngrok skipped: set NGROK_AUTHTOKEN env to expose publicly.');
    return;
  }
  try {
    const forwarder = await ngrok.forward({
      addr: `localhost:${PORT}`,
      authtoken_from_env: true,
      domain: process.env.NGROK_DOMAIN || "fifteen-cabana-swimsuit.ngrok-free.dev",
    });
    console.log(`Available at: ${forwarder.url()}`);
  } catch (err) {
    console.error('ngrok failed:', err.message);
  }
}