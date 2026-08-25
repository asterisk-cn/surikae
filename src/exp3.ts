// 勝利条件の比較：「2レーン取得で勝利」vs「取得レーン数の多い方が勝利」
import { createGame, applyAction, botView, DEFAULT_CONFIG, type Rng, type PlayerId } from './engine.ts';
import { makeGreedyBot } from './bot.ts';

function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const greedy = makeGreedyBot();
const N = 30000;
const rng = mulberry32(201);
let drawStrict = 0, drawMajority = 0;
const patterns = new Map<string, number>();
for (let i = 0; i < N; i++) {
  let s = createGame(rng, DEFAULT_CONFIG);
  while (s.phase === 'magic') s = applyAction(s, greedy(botView(s, s.current, DEFAULT_CONFIG), rng, DEFAULT_CONFIG), rng, DEFAULT_CONFIG);
  const [a, b] = s.result!.score;
  const key = `${Math.max(a,b)}-${Math.min(a,b)}`;
  patterns.set(key, (patterns.get(key) ?? 0) + 1);
  if (s.result!.winner === null) drawStrict++;
  if (a === b) drawMajority++;
}
const pct = (x: number) => (100 * x / N).toFixed(1) + '%';
console.log('スコアパターン分布:', [...patterns.entries()].sort().map(([k, v]) => `${k}: ${pct(v)}`).join(' / '));
console.log(`引き分け率 現行(2レーン必須): ${pct(drawStrict)} / 多数決方式: ${pct(drawMajority)}`);
