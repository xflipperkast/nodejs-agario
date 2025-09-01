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
const FOOD_COUNT = 600;
const FOOD_MASS = 1.5;
const FOOD_RESPAWN_BATCH = 20;
const MAX_SPEED = 9;
const MASS_SPEED_DAMP = 0.06;
const PLAYER_EAT_RATIO = 1.25;

const players = new Map();
const foods = new Map();

function rand(min, max) { return Math.random() * (max - min) + min; }
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function toRadius(mass) { return Math.sqrt(mass) * 4; }

function spawnFood(id) {
  foods.set(id, { id, x: rand(-WORLD_SIZE, WORLD_SIZE), y: rand(-WORLD_SIZE, WORLD_SIZE) });
}

for (let i = 0; i < FOOD_COUNT; i++) spawnFood(`f${i}`);

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
      lastInput: Date.now()
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

  socket.on("disconnect", () => {
    players.delete(socket.id);
  });
});

function step(dt) {
  const foodIds = Array.from(foods.keys());
  const playerArr = Array.from(players.values());

  for (const p of playerArr) {
    if (!p.alive) continue;
    const dx = p.tx - p.x;
    const dy = p.ty - p.y;
    const dist = Math.hypot(dx, dy) || 1;
    const speed = Math.max(1.5, MAX_SPEED - MASS_SPEED_DAMP * Math.sqrt(p.mass));
    const vx = (dx / dist) * speed;
    const vy = (dy / dist) * speed;
    p.x = clamp(p.x + vx * dt, -WORLD_SIZE, WORLD_SIZE);
    p.y = clamp(p.y + vy * dt, -WORLD_SIZE, WORLD_SIZE);

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
  for (const f of foods.values()) fs.push({ x: f.x, y: f.y });
  return { players: ps, foods: fs, leaderboard: top };
}

setInterval(() => {
  step(1 / TICK_RATE);
  const snap = snapshot();
  io.emit("state", snap);
}, 1000 / TICK_RATE);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {});
