'use strict';
/*
 * server.js —— 德州扑克联机服务器
 * 职责：
 *   1) 用内置 http 提供前端静态文件（public/）
 *   2) 用 ws 处理 WebSocket：建房/进房/坐下/开始/行动
 *   3) 每个房间一个 Table 实例（权威游戏逻辑），状态变化时按玩家分别推送视图
 *
 * 消息协议（客户端 -> 服务器，JSON）：
 *   {t:'create', name, startStack}        创建房间，返回房间号
 *   {t:'join',   room, name}              加入房间
 *   {t:'start',  aiTarget}                房主开始（aiTarget=补AI到几人,2..6,0=不补）
 *   {t:'action', action:{type, amount}}   行动
 *   {t:'addAI'} / {t:'removeAI'}          房主增减 AI（仅未开局或手间）
 *   {t:'leave'}                           离开房间
 *   {t:'ping'}                            心跳
 *
 * 服务器 -> 客户端：
 *   {t:'created', room, you}              建房成功
 *   {t:'joined', room, you, host}         进房成功
 *   {t:'state', ...view, room, host, msg} 牌局状态（按接收者定制）
 *   {t:'error', msg}                      错误
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Table } = require('./table');
// ws 是外部依赖，延迟到真正启动服务器时才加载，
// 这样在没装 ws 的环境（如测试沙盒）仍可 require 本模块测试房间逻辑。

const PORT = process.env.PORT || 8080;
const PUBLIC_DIR = path.join(__dirname, 'public');

/* ---------- 静态文件服务 ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.ico': 'image/x-icon' };
const httpServer = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(PUBLIC_DIR, path.normalize(urlPath).replace(/^(\.\.[/\\])+/, ''));
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

/* ---------- 房间管理 ---------- */
const rooms = new Map();   // code -> { code, hostId, table, clients:Map(id->ws), names:Map(id->name) }

function genRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉易混字符
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms.has(code));
  return code;
}

function makeRoom(startStack, maxSeats) {
  const code = genRoomCode();
  const room = { code, hostId: null, clients: new Map(), table: null };
  room.table = new Table({
    startStack, maxSeats,
    onState: (extra) => broadcastState(room, extra),
    log: (m) => console.log(`[${code}] ${m}`)
  });
  rooms.set(code, room);
  return room;
}

function broadcastState(room, extra) {
  extra = extra || {};
  for (const [id, ws] of room.clients) {
    if (ws.readyState !== ws.OPEN) continue;
    const view = room.table.viewFor(id);
    send(ws, Object.assign({ t: 'state', room: room.code, host: room.hostId, msg: extra.msg || '' }, view));
  }
}

function send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch (e) {} }

function cleanupRoom(room) {
  if (room.clients.size === 0) {
    rooms.delete(room.code);
    console.log(`[${room.code}] 房间已空，回收`);
  }
}

/* ---------- WebSocket ---------- */
function onConnection(ws) {
  ws.id = 'p_' + Math.random().toString(36).slice(2, 10);
  ws.room = null;
  ws.isAlive = true;

  ws.on('message', (buf) => {
    let m;
    try { m = JSON.parse(buf.toString()); } catch (e) { return; }
    handleMessage(ws, m);
  });

  ws.on('close', () => {
    const room = ws.room && rooms.get(ws.room);
    if (!room) return;
    room.clients.delete(ws.id);
    room.table.setConnected(ws.id, false);
    // 房主离开则转移房主
    if (room.hostId === ws.id) {
      const next = [...room.clients.keys()][0];
      room.hostId = next || null;
    }
    // 牌局进行中保留座位（标记断线/弃牌），否则直接移除
    if (room.table.handActive) {
      room.table.setConnected(ws.id, false);
      room.table.removeHuman(ws.id);
    } else {
      room.table.removeHuman(ws.id);
    }
    broadcastState(room);
    cleanupRoom(room);
  });

  ws.on('pong', () => { ws.isAlive = true; });
}

function handleMessage(ws, m) {
  switch (m.t) {
    case 'create': {
      const stack = [1000, 2000, 3000].includes(m.startStack) ? m.startStack : 1000;
      const seats = (m.maxSeats >= 2 && m.maxSeats <= 6) ? (m.maxSeats | 0) : 6;
      const room = makeRoom(stack, seats);
      const name = (m.name || '玩家').slice(0, 12);
      joinRoom(ws, room, name);
      room.hostId = ws.id;
      send(ws, { t: 'created', room: room.code, you: ws.id });
      broadcastState(room);
      break;
    }
    case 'join': {
      const room = rooms.get((m.room || '').toUpperCase().trim());
      if (!room) { send(ws, { t: 'error', msg: '房间不存在，请检查房间号' }); return; }
      if (room.table.occupiedSeats().length >= room.table.maxSeats) { send(ws, { t: 'error', msg: `房间已满（${room.table.maxSeats}人桌）` }); return; }
      const name = (m.name || '玩家').slice(0, 12);
      const seat = joinRoom(ws, room, name);
      if (seat === -1) { send(ws, { t: 'error', msg: '没有空座位了' }); return; }
      send(ws, { t: 'joined', room: room.code, you: ws.id, host: room.hostId });
      broadcastState(room, { msg: `${name} 加入了房间` });
      break;
    }
    case 'start': {
      const room = ws.room && rooms.get(ws.room);
      if (!room) return;
      if (room.hostId !== ws.id) { send(ws, { t: 'error', msg: '只有房主能开始游戏' }); return; }
      if (room.table.handActive) { send(ws, { t: 'error', msg: '本手还在进行中' }); return; }
      const aiTarget = Math.min(6, Math.max(0, m.aiTarget | 0));
      const okStart = room.table.startGame(aiTarget);
      if (!okStart) send(ws, { t: 'error', msg: '至少需要 2 名玩家（可补充 AI）' });
      break;
    }
    case 'action': {
      const room = ws.room && rooms.get(ws.room);
      if (!room) return;
      const res = room.table.humanAction(ws.id, m.action || {});
      if (!res.ok) send(ws, { t: 'error', msg: res.err });
      break;
    }
    case 'addAI': {
      const room = ws.room && rooms.get(ws.room);
      if (!room || room.hostId !== ws.id) return;
      if (room.table.handActive) { send(ws, { t: 'error', msg: '手牌进行中不能增减 AI' }); return; }
      const target = Math.min(6, room.table.occupiedSeats().length + 1);
      room.table.fillWithAI(target);
      broadcastState(room, { msg: '已添加一个电脑玩家' });
      break;
    }
    case 'removeAI': {
      const room = ws.room && rooms.get(ws.room);
      if (!room || room.hostId !== ws.id) return;
      if (room.table.handActive) { send(ws, { t: 'error', msg: '手牌进行中不能增减 AI' }); return; }
      // 移除一个 AI
      const seatsArr = room.table.seats;
      for (let i = seatsArr.length - 1; i >= 0; i--) {
        if (seatsArr[i] && seatsArr[i].isAI) { seatsArr[i] = null; break; }
      }
      broadcastState(room, { msg: '已移除一个电脑玩家' });
      break;
    }
    case 'leave': {
      const room = ws.room && rooms.get(ws.room);
      if (!room) return;
      room.clients.delete(ws.id);
      room.table.removeHuman(ws.id);
      if (room.hostId === ws.id) room.hostId = [...room.clients.keys()][0] || null;
      ws.room = null;
      broadcastState(room);
      cleanupRoom(room);
      break;
    }
    case 'rebuy': {
      const room = ws.room && rooms.get(ws.room);
      if (!room) return;
      const res = room.table.requestRebuy(ws.id);
      if (!res.ok) { send(ws, { t: 'error', msg: res.err }); return; }
      const seat = room.table.seatOf(ws.id);
      const name = seat !== -1 ? room.table.seats[seat].name : '玩家';
      const stack = room.table.startStack;
      broadcastState(room, { msg: res.immediate ? `${name} 补码 +${stack}` : `${name} 申请补码（下一手生效）` });
      break;
    }
    case 'ready': {
      const room = ws.room && rooms.get(ws.room);
      if (!room) return;
      const res = room.table.setReady(ws.id);
      if (!res.ok) send(ws, { t: 'error', msg: res.err });
      break;
    }
    case 'chat': {
      const room = ws.room && rooms.get(ws.room);
      if (!room) return;
      // 频率限制：每人每 800ms 最多一条
      const now = Date.now();
      if (ws._lastChat && now - ws._lastChat < 800) return;
      ws._lastChat = now;
      const seat = room.table.seatOf(ws.id);
      const name = seat !== -1 ? room.table.seats[seat].name : '玩家';
      let text = String(m.text || "").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 60).trim();
      if (!text) return;
      const chatMsg = { t: 'chat', from: ws.id, name, text, emoji: !!m.emoji, ts: now };
      for (const [, cws] of room.clients) {
        if (cws.readyState === cws.OPEN) send(cws, chatMsg);
      }
      break;
    }
    case 'ping': send(ws, { t: 'pong' }); break;
  }
}

function joinRoom(ws, room, name) {
  const seat = room.table.addHuman(ws.id, name);
  if (seat === -1) return -1;
  room.clients.set(ws.id, ws);
  ws.room = room.code;
  return seat;
}

/* ---------- 启动：加载 ws、接入连接、心跳、监听端口 ---------- */
function startServer() {
  const { WebSocketServer } = require('ws');   // 延迟加载，测试环境无需安装
  const wss = new WebSocketServer({ server: httpServer });
  wss.on('connection', onConnection);
  // 心跳：清理掉线连接
  setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws.isAlive === false) return ws.terminate();
      ws.isAlive = false;
      try { ws.ping(); } catch (e) {}
    });
  }, 30000);
  httpServer.listen(PORT, () => {
    console.log(`德州扑克联机服务器已启动: http://localhost:${PORT}`);
  });
}

if (require.main === module) startServer();

// 导出内部逻辑供测试使用（不影响正常运行）
module.exports = { rooms, makeRoom, handleMessage, broadcastState, genRoomCode, onConnection, startServer };
