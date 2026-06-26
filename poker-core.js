'use strict';
/*
 * poker-core.js —— 纯扑克逻辑（无 DOM、无网络），服务器与测试共用。
 * 从单机版 poker.html 移植，已通过 12 万手随机牌对照验证的快速评估器。
 */

const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const HAND_NAMES = ['高牌', '一对', '两对', '三条', '顺子', '同花', '葫芦', '四条', '同花顺', '皇家同花顺'];

const SMALL_BLIND = 10;
const BIG_BLIND = 20;
const MAX_SEATS = 6;

// AI 性格（5 个，与单机版一致）
const AI_PERSONALITIES = [
  { name: '阿尔法', aggression: 1.15, bluff: 0.10, tightness: 1.0, slowplay: 0.18, style: '稳健好斗' },
  { name: '贝塔', aggression: 0.80, bluff: 0.04, tightness: 1.25, slowplay: 0.10, style: '谨慎岩石' },
  { name: '伽马', aggression: 1.45, bluff: 0.20, tightness: 0.78, slowplay: 0.08, style: '松凶疯子' },
  { name: '德尔塔', aggression: 1.0, bluff: 0.07, tightness: 1.1, slowplay: 0.14, style: '均衡型' },
  { name: '艾普西龙', aggression: 1.3, bluff: 0.14, tightness: 0.9, slowplay: 0.10, style: '激进诈唬' }
];

// 联机版 AI 固定用"普通"难度（也可日后做成房间选项）
const AI_DIFFICULTY = { trialMul: 1.0, mistake: 0.10, equityNoise: 0.06, aggMul: 1.0 };

function rankVal(r) { return RANKS.indexOf(r) + 2; }

function makeDeck() {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push({ rank: r, suit: s });
  return d;
}
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* ===== 牌型评估（快速版，无组合枚举） ===== */
function mk(cat, tiebreak) { return { cat, tiebreak, name: HAND_NAMES[cat] }; }
function straightHighFrom(descVals) {
  const uniq = [...new Set(descVals)].sort((a, b) => b - a);
  if (uniq[0] === 14) uniq.push(1);
  let run = 1;
  for (let i = 1; i < uniq.length; i++) {
    if (uniq[i] === uniq[i - 1] - 1) {
      run++;
      if (run >= 5) return uniq[i] + 4;
    } else run = 1;
  }
  return 0;
}
function evaluate(cards) {
  const rankCount = {};
  const suitCards = {};
  for (const c of cards) {
    const v = rankVal(c.rank);
    rankCount[v] = (rankCount[v] || 0) + 1;
    (suitCards[c.suit] = suitCards[c.suit] || []).push(v);
  }
  const distinct = Object.keys(rankCount).map(Number).sort((a, b) => b - a);
  let flushSuit = null;
  for (const s in suitCards) { if (suitCards[s].length >= 5) { flushSuit = s; break; } }
  if (flushSuit) {
    const fv = suitCards[flushSuit].slice().sort((a, b) => b - a);
    const sfHigh = straightHighFrom(fv);
    if (sfHigh) return mk(sfHigh === 14 ? 9 : 8, [sfHigh]);
  }
  const byCount = distinct.slice().sort((a, b) => {
    if (rankCount[b] !== rankCount[a]) return rankCount[b] - rankCount[a];
    return b - a;
  });
  const c0 = rankCount[byCount[0]];
  const c1 = byCount[1] != null ? rankCount[byCount[1]] : 0;
  if (c0 === 4) {
    const quad = byCount[0];
    const kicker = distinct.find(v => v !== quad);
    return mk(7, [quad, kicker]);
  }
  if (c0 === 3 && c1 >= 2) {
    const trip = byCount[0];
    let pair = -1;
    for (let i = 1; i < byCount.length; i++) { if (rankCount[byCount[i]] >= 2) { pair = byCount[i]; break; } }
    return mk(6, [trip, pair]);
  }
  if (flushSuit) {
    const fv = suitCards[flushSuit].slice().sort((a, b) => b - a).slice(0, 5);
    return mk(5, fv);
  }
  const sHigh = straightHighFrom(distinct);
  if (sHigh) return mk(4, [sHigh]);
  if (c0 === 3) {
    const trip = byCount[0];
    const kickers = distinct.filter(v => v !== trip).slice(0, 2);
    return mk(3, [trip, ...kickers]);
  }
  const pairs = distinct.filter(v => rankCount[v] === 2);
  if (pairs.length >= 2) {
    const [hi, lo] = pairs.slice(0, 2);
    const kicker = distinct.find(v => v !== hi && v !== lo);
    return mk(2, [hi, lo, kicker]);
  }
  if (c0 === 2) {
    const pair = byCount[0];
    const kickers = distinct.filter(v => v !== pair).slice(0, 3);
    return mk(1, [pair, ...kickers]);
  }
  return mk(0, distinct.slice(0, 5));
}
function cmpScore(a, b) {
  if (a.cat !== b.cat) return a.cat - b.cat;
  const la = a.tiebreak, lb = b.tiebreak;
  for (let i = 0; i < Math.max(la.length, lb.length); i++) {
    const x = la[i] || 0, y = lb[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

/* ===== 蒙特卡洛胜率 ===== */
// board: 公共牌数组; holeCards: 玩家两张底牌
function winEquity(holeCards, board, oppCount, trialMul) {
  trialMul = trialMul || 1.0;
  oppCount = Math.max(1, oppCount);
  if (board.length === 0) {
    const headsUp = preflopEquity(holeCards);
    return Math.max(0.05, Math.pow(headsUp, 0.72 + 0.28 * oppCount));
  }
  const baseTrials = board.length === 5 ? 240 : (board.length === 4 ? 320 : 400);
  const trials = Math.max(80, Math.round(baseTrials * trialMul));
  const known = [...holeCards, ...board];
  const knownKey = new Set(known.map(c => c.rank + c.suit));
  const remaining = [];
  for (const s of SUITS) for (const rk of RANKS) {
    if (!knownKey.has(rk + s)) remaining.push({ rank: rk, suit: s });
  }
  const needBoard = 5 - board.length;
  let score = 0;
  for (let t = 0; t < trials; t++) {
    const pool = remaining.slice();
    for (let i = 0; i < pool.length; i++) {
      const j = i + Math.floor(Math.random() * (pool.length - i));
      const tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp;
    }
    let idx = 0;
    const fullBoard = board.slice();
    for (let k = 0; k < needBoard; k++) fullBoard.push(pool[idx++]);
    const myScore = evaluate([...holeCards, ...fullBoard]);
    let better = 0, tie = 0;
    for (let o = 0; o < oppCount; o++) {
      const oc = [pool[idx++], pool[idx++]];
      const os = evaluate([...oc, ...fullBoard]);
      const cmp = cmpScore(os, myScore);
      if (cmp > 0) { better++; break; }
      else if (cmp === 0) tie++;
    }
    if (better === 0) score += tie > 0 ? 1 / (tie + 1) : 1;
  }
  return score / trials;
}
function preflopEquity(cards) {
  const v1 = rankVal(cards[0].rank), v2 = rankVal(cards[1].rank);
  const hi = Math.max(v1, v2), lo = Math.min(v1, v2);
  const pair = v1 === v2;
  const suited = cards[0].suit === cards[1].suit;
  const gap = hi - lo;
  let s;
  if (pair) {
    s = 0.50 + (hi - 2) / 12 * 0.35;
  } else {
    s = 0.32 + (hi - 2) / 12 * 0.22 + (lo - 2) / 12 * 0.12;
    if (suited) s += 0.05;
    if (gap === 1) s += 0.04;
    else if (gap === 2) s += 0.02;
    else if (gap > 4) s -= 0.05;
  }
  return Math.max(0.12, Math.min(0.90, s));
}

/* ===== AI 决策 =====
 * 纯函数：给定牌局快照，返回一个动作 {type:'fold'|'check'|'call'|'raise', size?}
 * ctx = { holeCards, board, stage, pot, currentBet, minRaise, myBet, myStack, oppLive, persona }
 */
function aiDecide(ctx) {
  const persona = ctx.persona || { aggression: 1, bluff: 0.08, tightness: 1, slowplay: 0.12 };
  const diff = AI_DIFFICULTY;
  const toCall = ctx.currentBet - ctx.myBet;

  let equity = winEquity(ctx.holeCards, ctx.board, ctx.oppLive, diff.trialMul);
  if (diff.equityNoise > 0) {
    equity += (Math.random() * 2 - 1) * diff.equityNoise;
    equity = Math.max(0, Math.min(1, equity));
  }
  const potOdds = toCall > 0 ? toCall / (ctx.pot + toCall) : 0;
  const r = Math.random();
  const agg = persona.aggression * diff.aggMul;
  const wantBluff = r < persona.bluff && equity > 0.18;
  const semiBluffStreet = (ctx.stage === 'flop' || ctx.stage === 'turn');
  const raiseThresh = 0.62 / agg;
  const strongThresh = 0.80 / Math.sqrt(agg);
  const foldMargin = 0.03 * persona.tightness;

  function betSize() {
    const base = ctx.pot > 0 ? ctx.pot : BIG_BLIND;
    const frac = (0.45 + equity * 0.55) * agg;
    let raiseTo = ctx.currentBet + Math.round((base * frac) / 10) * 10;
    if (equity > 0.92 && Math.random() < 0.4 * agg) raiseTo = ctx.myBet + ctx.myStack;
    raiseTo = Math.max(raiseTo, ctx.currentBet + ctx.minRaise);
    raiseTo = Math.min(raiseTo, ctx.myBet + ctx.myStack);
    return raiseTo;
  }

  let decision;
  if (toCall === 0) {
    const slowplay = equity > 0.85 && r < persona.slowplay;
    if (slowplay) decision = { type: 'check' };
    else if (equity > raiseThresh || wantBluff || (semiBluffStreet && equity > 0.45 && r < 0.35 * agg))
      decision = { type: 'raise', size: betSize() };
    else decision = { type: 'check' };
  } else {
    if (equity > strongThresh && !(equity > 0.9 && r < persona.slowplay))
      decision = { type: 'raise', size: betSize() };
    else if (equity >= potOdds + foldMargin) decision = { type: 'call' };
    else if (wantBluff && r < persona.bluff * 0.5) decision = { type: 'raise', size: betSize() };
    else decision = { type: 'fold' };
  }
  if (decision.type === 'fold' && toCall === 0) decision = { type: 'check' };

  if (Math.random() < diff.mistake) {
    if (decision.type === 'fold' && toCall <= ctx.myStack) decision = { type: 'call' };
    else if (decision.type === 'check' && equity < 0.5) decision = { type: 'raise', size: betSize() };
    else if (decision.type === 'raise' && equity < 0.55) decision = { type: 'call' };
    if (decision.type === 'fold' && toCall === 0) decision = { type: 'check' };
  }
  return { decision, equity };
}

/* ===== 边池分配 =====
 * players: 全部参与过本手的玩家 [{id, folded, totalBet, score?}]
 * 返回每个玩家赢得的金额映射 {id: amount}，并标出哪些是赢家
 * score 为 null 表示该玩家弃牌（不参与比牌）
 */
function distributePots(players) {
  const winnings = {};
  const winnerIds = new Set();
  for (const p of players) winnings[p.id] = 0;

  const contributors = players.filter(p => p.totalBet > 0);
  const levels = [...new Set(contributors.map(p => p.totalBet))].sort((a, b) => a - b);
  let prev = 0;
  for (const lvl of levels) {
    const layer = lvl - prev;
    const participants = contributors.filter(p => p.totalBet >= lvl);
    const potSize = layer * participants.length;
    if (potSize <= 0) { prev = lvl; continue; }
    // 有资格赢这层的：没弃牌(有 score)且投入达到该层
    const eligible = players.filter(p => p.score && p.totalBet >= lvl);
    if (eligible.length === 0) { prev = lvl; continue; }
    let best = eligible[0];
    for (const s of eligible) if (cmpScore(s.score, best.score) > 0) best = s;
    const winners = eligible.filter(s => cmpScore(s.score, best.score) === 0);
    const share = Math.floor(potSize / winners.length);
    let rem = potSize - share * winners.length;
    for (const w of winners) {
      winnings[w.id] += share;
      winnerIds.add(w.id);
      if (rem > 0) { winnings[w.id] += 1; rem--; }
    }
    prev = lvl;
  }
  return { winnings, winnerIds };
}

module.exports = {
  SUITS, RANKS, HAND_NAMES, SMALL_BLIND, BIG_BLIND, MAX_SEATS,
  AI_PERSONALITIES, AI_DIFFICULTY,
  rankVal, makeDeck, shuffle, evaluate, cmpScore,
  winEquity, preflopEquity, aiDecide, distributePots
};
