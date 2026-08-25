// NetSession同士をメモリ内で接続し，整合性を検証する
import { NetSession, type Transport, type NetMsg, type SessionEvent } from './session.ts';
import type { Action, Lane } from './engine.ts';

function pipePair(): [Transport, Transport] {
  let fa: ((m: NetMsg) => void) | null = null;
  let fb: ((m: NetMsg) => void) | null = null;
  const a: Transport = {
    send: (m) => queueMicrotask(() => fb?.(structuredClone(m))),
    onMessage: (f) => (fa = f),
    close: () => {},
  };
  const b: Transport = {
    send: (m) => queueMicrotask(() => fa?.(structuredClone(m))),
    onMessage: (f) => (fb = f),
    close: () => {},
  };
  return [a, b];
}

function rndAction(canPass: boolean, r: () => number, canX: boolean): Action {
  const roll = r();
  if (canPass && roll < 0.2) return { type: 'pass' };
  if (canX && roll < 0.4)
    return { type: 'xswap', mine: Math.floor(r() * 3) as Lane, theirs: Math.floor(r() * 3) as Lane };
  if (roll < 0.6) return { type: 'change', lane: Math.floor(r() * 3) as Lane };
  if (roll < 0.8) {
    const p: [Lane, Lane][] = [[0,1],[0,2],[1,2]];
    return { type: 'swap', lanes: p[Math.floor(r() * 3)] };
  }
  if (canX && roll < 0.9)
    return {
      type: 'bluff',
      lanes: [Math.floor(r() * 3) as Lane],
      foreign: Math.floor(r() * 3) as Lane,
    };
  const pb: [Lane, Lane][] = [[0,1],[0,2],[1,2]];
  return { type: 'bluff', lanes: pb[Math.floor(r() * 3)] };
}

async function tick() { await new Promise((res) => setTimeout(res, 0)); }

let fails = 0;
for (let g = 0; g < 500; g++) {
  const [ta, tb] = pipePair();
  const host = new NetSession('host', ta);
  const join = new NetSession('join', tb);
  const fins: Record<string, Extract<SessionEvent, { t: 'finished' }>> = {};
  host.subscribe((e) => { if (e.t === 'finished') fins.host = e; });
  join.subscribe((e) => { if (e.t === 'finished') fins.join = e; });
  host.start(); join.start();
  await tick(); await tick();

  const r = Math.random;
  for (let step = 0; step < 40 && (!fins.host || !fins.join); step++) {
    const active = host.view.isMyTurn ? host : join.view.isMyTurn ? join : null;
    if (active)
      active.myAction(rndAction(active.view.canPass, r, active.view.canXswap));
    await tick(); await tick();
  }

  if (!fins.host || !fins.join) { console.log(`game ${g}: 未決着`); fails++; continue; }
  const h = fins.host, j = fins.join;
  const ok =
    h.score[0] === j.score[1] && h.score[1] === j.score[0] &&
    ((h.winner === null && j.winner === null) ||
     (h.winner === 'me' && j.winner === 'opp') ||
     (h.winner === 'opp' && j.winner === 'me')) &&
    JSON.stringify(h.myHand) === JSON.stringify(j.oppHand) &&
    JSON.stringify(h.oppHand) === JSON.stringify(j.myHand) &&
    h.byCap === j.byCap;
  if (!ok) { console.log(`game ${g}: 不一致`, h, j); fails++; }
}
console.log(fails === 0 ? '500戦すべて両視点の判定が一致' : `${fails}件の不整合`);
