import express from "express";
import http from "http";
import { Server } from "socket.io";

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static("public"));

const TICK_RATE = 30;
const WORLD_SIZE = 3200;
const START_MASS = 25;
// Double the food count so the map has more pellets to eat
const FOOD_COUNT = 3000;
const FOOD_MASS = 1.5;
const FOOD_RESPAWN_BATCH = 100;
const PLAYER_EAT_RATIO = 1.25;
const EJECT_MASS = 14;
const EJECT_SPEED = 400;
const MAX_EJECT_PER_SEC = 7;
const VIRUS_COUNT = 15;
const VIRUS_MASS = 100;

const players = new Map();
const foods = new Map();
const ejects = new Map();
const viruses = new Map();

function rand(min, max) { return Math.random() * (max - min) + min; }
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function toRadius(mass) { return Math.sqrt(mass) * 4; }

function spawnFood(id) {
  // Each food pellet gets a random color so the map looks more vibrant
  const color = `hsl(${Math.floor(rand(0, 360))}deg 80% 55%)`;
  foods.set(id, {
    id,
    x: rand(-WORLD_SIZE, WORLD_SIZE),
    y: rand(-WORLD_SIZE, WORLD_SIZE),
    color
  });
}

for (let i = 0; i < FOOD_COUNT; i++) spawnFood(`f${i}`);

function spawnVirus(id) {
  viruses.set(id, {
    id,
    x: rand(-WORLD_SIZE, WORLD_SIZE),
    y: rand(-WORLD_SIZE, WORLD_SIZE),
    r: toRadius(VIRUS_MASS)
  });
}
for (let i = 0; i < VIRUS_COUNT; i++) spawnVirus(`v${i}`);

io.on("connection", socket => {
  socket.on("join", ({ name }) => {
    const color = `hsl(${Math.floor(rand(0,360))}deg 80% 55%)`;
    const player = {
      id: socket.id,
      name: String(name || "Player").slice(0, 20),
      x: rand(-WORLD_SIZE, WORLD_SIZE),
      y: rand(-WORLD_SIZE, WORLD_SIZE),
      tx: 0,
      ty: 0,
      mass: START_MASS,
      color,
      alive: true,
      score: 0,
      lastInput: Date.now(),
      vx: 0,
      vy: 0,
      ejects: 0,
      lastEject: 0
    };
    players.set(socket.id, player);
    socket.emit("init", {
      id: socket.id,
      world: { size: WORLD_SIZE }
    });
  });

  socket.on("input", ({ tx, ty }) => {
    const p = players.get(socket.id);
    if (!p || !p.alive) return;
    p.tx = tx;
    p.ty = ty;
    p.lastInput = Date.now();
  });

  socket.on("eject", () => {
    const p = players.get(socket.id);
    if (!p || !p.alive) return;
    const now = Date.now();
    if (now - p.lastEject > 1000) { p.lastEject = now; p.ejects = 0; }
    if (p.ejects >= MAX_EJECT_PER_SEC) return;
    if (p.mass <= EJECT_MASS) return;
    p.mass -= EJECT_MASS;
    const angle = Math.atan2(p.ty - p.y, p.tx - p.x);
    const id = `e${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
    ejects.set(id, {
      id,
      x: p.x,
      y: p.y,
      vx: Math.cos(angle) * EJECT_SPEED,
      vy: Math.sin(angle) * EJECT_SPEED,
      color: p.color
    });
    p.ejects++;
  });

  socket.on("split", () => {
    const p = players.get(socket.id);
    if (!p || !p.alive) return;
    if (p.mass < 35) return;
    const angle = Math.atan2(p.ty - p.y, p.tx - p.x);
    p.vx += Math.cos(angle) * EJECT_SPEED;
    p.vy += Math.sin(angle) * EJECT_SPEED;
  });

  socket.on("disconnect", () => {
    players.delete(socket.id);
  });
});

function step(dt) {
  for (const [id, e] of ejects) {
    e.x += e.vx * dt;
    e.y += e.vy * dt;
    e.vx *= 0.9;
    e.vy *= 0.9;
    e.x = clamp(e.x, -WORLD_SIZE, WORLD_SIZE);
    e.y = clamp(e.y, -WORLD_SIZE, WORLD_SIZE);
  }

  const foodIds = Array.from(foods.keys());
  const ejectIds = Array.from(ejects.keys());
  const playerArr = Array.from(players.values());

  for (const p of playerArr) {
    if (!p.alive) continue;
    const dx = p.tx - p.x;
    const dy = p.ty - p.y;
    const dist = Math.hypot(dx, dy) || 1;
    p.vx *= 0.9;
    p.vy *= 0.9;
    // Small cells should move quickly while larger ones slow down
    const speed = 150 / Math.sqrt(p.mass);
    p.vx += (dx / dist) * speed;
    p.vy += (dy / dist) * speed;
    p.x = clamp(p.x + p.vx * dt, -WORLD_SIZE, WORLD_SIZE);
    p.y = clamp(p.y + p.vy * dt, -WORLD_SIZE, WORLD_SIZE);

    const pr = toRadius(p.mass);
    for (let i = 0; i < foodIds.length; i++) {
      const fid = foodIds[i];
      const f = foods.get(fid);
      if (!f) continue;
      const d = Math.hypot(f.x - p.x, f.y - p.y);
      if (d < pr) {
        p.mass += FOOD_MASS;
        p.score = Math.max(p.score, p.mass);
        foods.delete(fid);
      }
    }

    for (let i = 0; i < ejectIds.length; i++) {
      const eid = ejectIds[i];
      const e = ejects.get(eid);
      if (!e) continue;
      const d = Math.hypot(e.x - p.x, e.y - p.y);
      if (d < pr) {
        p.mass += EJECT_MASS * 0.7;
        p.score = Math.max(p.score, p.mass);
        ejects.delete(eid);
      }
    }

    for (const [vid, v] of viruses) {
      const d = Math.hypot(v.x - p.x, v.y - p.y);
      if (d < pr + v.r && p.mass > VIRUS_MASS * 2) {
        p.mass = p.mass / 2 + VIRUS_MASS;
        const angle = Math.atan2(p.ty - p.y, p.tx - p.x);
        p.vx += Math.cos(angle) * EJECT_SPEED;
        p.vy += Math.sin(angle) * EJECT_SPEED;
        viruses.delete(vid);
        spawnVirus(`vx${Date.now()}_${Math.random().toString(36).slice(2,7)}`);
      }
    }
  }

  let respawn = FOOD_COUNT - foods.size;
  if (respawn > 0) {
    const batch = Math.min(respawn, FOOD_RESPAWN_BATCH);
    for (let i = 0; i < batch; i++) spawnFood(`fx${Date.now()}_${Math.random().toString(36).slice(2, 7)}_${i}`);
  }

  for (let i = 0; i < playerArr.length; i++) {
    const a = playerArr[i];
    if (!a.alive) continue;
    for (let j = i + 1; j < playerArr.length; j++) {
      const b = playerArr[j];
      if (!b.alive) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.hypot(dx, dy);
      const ra = toRadius(a.mass);
      const rb = toRadius(b.mass);
      if (d < Math.max(ra, rb) && d !== 0) {
        if (a.mass > b.mass * PLAYER_EAT_RATIO) {
          a.mass += b.mass * 0.9;
          a.score = Math.max(a.score, a.mass);
          b.alive = false;
          players.delete(b.id);
        } else if (b.mass > a.mass * PLAYER_EAT_RATIO) {
          b.mass += a.mass * 0.9;
          b.score = Math.max(b.score, b.mass);
          a.alive = false;
          players.delete(a.id);
        }
      }
    }
  }
}

function snapshot() {
  const ps = [];
  for (const p of players.values()) {
    ps.push({
      id: p.id,
      name: p.name,
      x: Math.round(p.x * 100) / 100,
      y: Math.round(p.y * 100) / 100,
      r: Math.round(toRadius(p.mass) * 100) / 100,
      color: p.color,
      mass: Math.round(p.mass * 10) / 10
    });
  }
  const top = ps
    .sort((a, b) => b.mass - a.mass)
    .slice(0, 10)
    .map(v => ({ name: v.name, mass: v.mass }));
  const fs = [];
  for (const f of foods.values()) fs.push({ x: f.x, y: f.y, color: f.color });
  for (const e of ejects.values()) fs.push({ x: e.x, y: e.y, color: e.color });
  const vs = [];
  for (const v of viruses.values()) vs.push({ x: v.x, y: v.y, r: v.r });
  return { players: ps, foods: fs, viruses: vs, leaderboard: top };
}

setInterval(() => {
  step(1 / TICK_RATE);
  const snap = snapshot();
  io.emit("state", snap);
}, 1000 / TICK_RATE);

const PORT = process.env.PORT || 3000;
// Log a message when the server starts so tests can confirm startup
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
