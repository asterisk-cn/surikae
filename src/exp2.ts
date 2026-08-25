// テンポ価値の分離実験：先手をランダム化して比較
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

function run(label: string, firstRule: 'lower' | 'random' | 'higher', seed: number) {
  const rng = mulberry32(seed);
  let fmWins = 0, fmGames = 0, hiWins = 0, hiGames = 0, draws = 0;
  for (let i = 0; i < N; i++) {
    let s = createGame(rng, DEFAULT_CONFIG);
    const t0 = s.initialHands[0].reduce((a, b) => a + b, 0);
    const t1 = s.initialHands[1].reduce((a, b) => a + b, 0);
    if (firstRule === 'random') s = { ...s, current: (rng() < 0.5 ? 0 : 1) as PlayerId };
    if (firstRule === 'higher' && t0 !== t1) s = { ...s, current: (t0 > t1 ? 0 : 1) as PlayerId };
    const first = s.current;
    while (s.phase === 'magic') s = applyAction(s, greedy(botView(s, s.current, DEFAULT_CONFIG), rng, DEFAULT_CONFIG), rng, DEFAULT_CONFIG);
    const w = s.result!.winner;
    if (w === null) { draws++; continue; }
    fmGames++; if (w === first) fmWins++;
    if (t0 !== t1) { hiGames++; if (w === (t0 > t1 ? 0 : 1)) hiWins++; }
  }
  const pct = (x: number, d: number) => (100 * x / d).toFixed(1) + '%';
  console.log(`${label}: 先手勝率 ${pct(fmWins, fmGames)} / 高合計側勝率 ${pct(hiWins, hiGames)} / 引分 ${pct(draws, N)}`);
}

run('先手=低合計（現行仕様）', 'lower', 101);
run('先手=ランダム        ', 'random', 102);
run('先手=高合計（逆仕様）', 'higher', 103);
