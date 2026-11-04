// Campus Event Registration & Management: Node.js backend (no npm packages needed)
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, "data.json");
const PUBLIC_DIR = path.join(__dirname, "public");
const CATEGORIES = ["Academic", "Social", "Sports", "Career", "Cultural", "Other"];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIME = {".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".ico": "image/x-icon"};

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ---------- storage (JSON file) ----------
let db = { events: [], regs: [] };

function seed() {
  db = { events: [{ id: "sample01", title: "Freshers’ Welcome Party", date: "2026-11-20", venue: "Main Hall", category: "Social", status: "active" }], regs: [] };
  save();
}
function load() {
  try {
    db = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    if (!Array.isArray(db.events) || !Array.isArray(db.regs)) throw new Error("bad shape");
  } catch (e) {
    if (e.code !== "ENOENT") {
      try { fs.renameSync(DATA_FILE, DATA_FILE + ".corrupt"); console.warn("data.json was unreadable and was moved to data.json.corrupt"); } catch (_) {}
    }
    seed();
  }
}
function save() {
  try {
    const tmp = DATA_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, DATA_FILE); // atomic swap so a crash can't corrupt the file
  } catch (e) {
    throw new ApiError(500, "Could not save data to disk: " + e.message);
  }
}

// ---------- helpers ----------
const uid = () => crypto.randomBytes(4).toString("hex");
const clean = v => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");

function findEvent(id) {
  const e = db.events.find(x => x.id === id);
  if (!e) throw new ApiError(404, "Event not found. It may have been deleted.");
  return e;
}

function validateEvent(b) {
  const title = clean(b.title), date = clean(b.date), venue = clean(b.venue), category = clean(b.category);
  if (!title) throw new ApiError(400, "Please enter an event title.");
  if (title.length > 80) throw new ApiError(400, "Title is too long (80 characters max).");
  if (!date) throw new ApiError(400, "Please choose a date for the event.");
  const d = new Date(date + "T00:00:00Z");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(d) || d.toISOString().slice(0, 10) !== date)
    throw new ApiError(400, "Please enter a valid date.");
  if (!venue) throw new ApiError(400, "Please enter a venue.");
  if (venue.length > 80) throw new ApiError(400, "Venue is too long (80 characters max).");
  if (!CATEGORIES.includes(category)) throw new ApiError(400, "Please choose a valid category.");
  return { title, date, venue, category };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", c => {
      size += c.length;
      if (size > 100 * 1024) { reject(new ApiError(413, "Request is too large.")); req.destroy(); }
      else chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        const parsed = JSON.parse(raw);
        resolve(parsed && typeof parsed === "object" ? parsed : {});
      } catch (_) { reject(new ApiError(400, "Invalid request body.")); }
    });
    req.on("error", () => reject(new ApiError(400, "Could not read the request.")));
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

// ---------- API ----------
async function api(req, res, pathname) {
  const m = req.method;
  const p = pathname.slice(5).split("/").filter(Boolean); // strip "/api/"

  if (p[0] === "events") {
    // GET /api/events
    if (p.length === 1 && m === "GET") {
      return sendJson(res, 200, db.events.map(e => ({ ...e, registrations: db.regs.filter(r => r.eventId === e.id).length })));
    }
    // POST /api/events
    if (p.length === 1 && m === "POST") {
      const ev = { id: uid(), ...validateEvent(await readBody(req)), status: "active" };
      db.events.push(ev);
      save();
      return sendJson(res, 201, { message: "Event created successfully." });
    }
    // PUT /api/events/:id
    if (p.length === 2 && m === "PUT") {
      const ev = findEvent(p[1]);
      Object.assign(ev, validateEvent(await readBody(req)));
      save();
      return sendJson(res, 200, { message: "Event updated successfully." });
    }
    // DELETE /api/events/:id
    if (p.length === 2 && m === "DELETE") {
      const ev = findEvent(p[1]);
      db.events = db.events.filter(e => e.id !== ev.id);
      db.regs = db.regs.filter(r => r.eventId !== ev.id);
      save();
      return sendJson(res, 200, { message: "Event deleted." });
    }
    // POST /api/events/:id/cancel
    if (p.length === 3 && p[2] === "cancel" && m === "POST") {
      const ev = findEvent(p[1]);
      if (ev.status === "cancelled") throw new ApiError(409, "This event is already cancelled.");
      ev.status = "cancelled";
      save();
      return sendJson(res, 200, { message: "Event cancelled." });
    }
    // GET /api/events/:id/registrations
    if (p.length === 3 && p[2] === "registrations" && m === "GET") {
      const ev = findEvent(p[1]);
      const registrations = db.regs.filter(r => r.eventId === ev.id).map(({ id, name, email }) => ({ id, name, email }));
      return sendJson(res, 200, { event: ev.title, registrations });
    }
    // POST /api/events/:id/registrations
    if (p.length === 3 && p[2] === "registrations" && m === "POST") {
      const ev = findEvent(p[1]);
      if (ev.status === "cancelled") throw new ApiError(409, "This event is cancelled, so registration is closed.");
      const b = await readBody(req);
      const name = clean(b.name), email = clean(b.email).toLowerCase();
      if (!name) throw new ApiError(400, "Please enter your name.");
      if (name.length > 80) throw new ApiError(400, "Name is too long (80 characters max).");
      if (!EMAIL_RE.test(email)) throw new ApiError(400, "Please enter a valid email address.");
      if (db.regs.some(r => r.eventId === ev.id && r.email === email))
        throw new ApiError(409, "This email is already registered for the event.");
      db.regs.push({ id: uid(), eventId: ev.id, name, email });
      save();
      return sendJson(res, 201, { message: `Registration successful. See you at the event, ${name}!` });
    }
    throw new ApiError(405, "Unsupported request.");
  }

  // DELETE /api/registrations/:id
  if (p[0] === "registrations" && p.length === 2 && m === "DELETE") {
    const before = db.regs.length;
    db.regs = db.regs.filter(r => r.id !== p[1]);
    if (db.regs.length === before) throw new ApiError(404, "Registration not found.");
    save();
    return sendJson(res, 200, { message: "Registration removed." });
  }
  throw new ApiError(404, "Not found.");
}

// ---------- static files ----------
function serveStatic(res, pathname) {
  const rel = pathname === "/" ? "index.html" : pathname.slice(1);
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) throw new ApiError(403, "Forbidden.");
  fs.readFile(file, (err, data) => {
    if (err) return sendJson(res, 404, { error: "Not found." });
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    if (pathname.startsWith("/api/")) await api(req, res, pathname);
    else serveStatic(res, pathname);
  } catch (e) {
    if (e instanceof ApiError) return sendJson(res, e.status, { error: e.message });
    console.error(e);
    sendJson(res, 500, { error: "Unexpected server error. Please try again." });
  }
});

load();
server.listen(PORT, () => console.log(`Campus Events running at http://localhost:${PORT}  (Ctrl+C to stop)`));
