// あそびかた：台本つきの一局．
// 盤はCpuSessionと同じSessionとして振る舞うので，Game.svelteは普段どおり動く．
// 違うのは二点だけ：配りが固定であることと，台本の手以外は受け取らないこと．
// 説明は文章ではなく，いま押すものを一行で指す（Guide）．

import {
  applyAction,
  observableOf,
  foreignOf,
  canXswap,
  canFakeXswap,
  judgeHands,
  DEFAULT_CONFIG,
  type GameState,
  type Action,
  type Card,
  type Lane,
  type PlayerId,
  type Config,
} from './engine.ts';
import {
  makeEmitter,
  type ClientView,
  type Session,
  type SessionEvent,
} from './session.ts';

/** 盤の下に出る一行．文にはせず，選ぶものと押すものだけを指す */
export type Guide = {
  who: 'me' | 'opp';
  lead?: string; // 選ぶ／押すに収まらないときだけ，一行をそのまま書く
  pick?: string; // 選ぶ札（自分の手番だけ）
  press?: string; // 押すボタン／相手が打った手の名前
  note?: string; // 添える一言
};

type Step = {
  guide: Guide;
  action: Action;
  /** ヤマから引く札．台本どおりに引かせるため，山の中の位置から乱数を逆算する */
  draw?: Card;
};

// 配りは固定．自分の合計が小さいので先手も自分になる（14 < 16）
const MY_HAND: Card[] = [5, 8, 1];
const OPP_HAND: Card[] = [7, 3, 6];
const PILE: Card[] = [2, 4, 9];

/** 台本．自分の手は「いれかえ→ひきなおし→ぶらふ→すりかえ→ぱす」の順に
 *  一度ずつ触る．相手の手はその間に挟まり，最後は2-1で自分が勝つ */
const SCRIPT: Step[] = [
  {
    guide: {
      who: 'me',
      pick: 'ひだり ＋ まんなか',
      press: 'いれかえ',
      note: 'じぶんの 2まい',
    },
    action: { type: 'swap', lanes: [0, 1] },
  },
  {
    guide: {
      who: 'opp',
      press: 'すりかえ',
      note: 'ひだりが しょうたい ふめいに',
    },
    action: { type: 'xswap', mine: 2, theirs: 0 },
  },
  {
    guide: {
      who: 'me',
      pick: 'みぎ',
      press: 'ひきなおし',
      note: 'ひいた札は 1びょうだけ みえる',
    },
    action: { type: 'change', lane: 2 },
    draw: 9,
  },
  {
    guide: { who: 'opp', press: 'ふるえ', note: 'ほんもの？ うそ？' },
    action: { type: 'bluff', lanes: [0], foreign: 1 },
  },
  {
    guide: {
      who: 'me',
      pick: 'みぎ ＋ あいての まんなか',
      press: 'ぶらふ',
      note: '札は うごかない ふるえだけ',
    },
    action: { type: 'bluff', lanes: [2], foreign: 1 },
  },
  {
    guide: { who: 'opp', press: 'ひきなおし', note: 'あいての札も 1びょう みえる' },
    action: { type: 'change', lane: 1 },
    draw: 4,
  },
  {
    guide: {
      who: 'me',
      pick: 'ひだり ＋ あいての ひだり',
      press: 'すりかえ',
      note: '1きょくに 1かいだけ',
    },
    action: { type: 'xswap', mine: 0, theirs: 0 },
  },
  {
    guide: { who: 'opp', press: 'いれかえ', note: 'ふるえは 2つ' },
    action: { type: 'swap', lanes: [0, 2] },
  },
  { guide: { who: 'me', press: 'ぱす', note: 'そのばで けっちゃく' }, action: { type: 'pass' } },
];

/** 手の種類＝盤のボタンの名前 */
function pressOf(a: Action): string {
  switch (a.type) {
    case 'swap':
      return 'いれかえ';
    case 'change':
      return 'ひきなおし';
    case 'xswap':
      return 'すりかえ';
    case 'bluff':
      return 'ぶらふ';
    case 'pass':
      return 'ぱす';
  }
}

/** 同じ手か．自分が組んだ手が台本と一致するかを見る */
function sameAction(a: Action, b: Action): boolean {
  if (a.type !== b.type) return false;
  switch (a.type) {
    case 'swap':
      return (
        [...a.lanes].sort().join() === [...(b as typeof a).lanes].sort().join()
      );
    case 'xswap': {
      const t = b as typeof a;
      return a.mine === t.mine && a.theirs === t.theirs;
    }
    case 'change':
      return a.lane === (b as typeof a).lane;
    case 'bluff': {
      const t = b as typeof a;
      return (
        [...a.lanes].sort().join() === [...t.lanes].sort().join() &&
        a.foreign === t.foreign
      );
    }
    case 'pass':
      return true;
  }
}

/** 演出が終わるまで次の札を出さないための待ち．引き直しだけ長い */
function beatOf(a: Action): number {
  if (a.type === 'change') return 2600;
  if (a.type === 'pass') return 700;
  return 1700;
}

export class TutorialSession implements Session {
  private s: GameState;
  private cfg: Config = DEFAULT_CONFIG;
  private em = makeEmitter();
  private i = 0; // 台本のどこにいるか
  private guide: Guide | null = null;
  private guideSubs = new Set<(g: Guide | null) => void>();
  private timers: ReturnType<typeof setTimeout>[] = [];
  readonly me: PlayerId = 0;

  constructor() {
    this.s = this.freshState();
  }

  private freshState(): GameState {
    return {
      hands: [MY_HAND.slice(), OPP_HAND.slice()],
      initialHands: [MY_HAND.slice(), OPP_HAND.slice()],
      pile: PILE.slice(),
      known: [
        [true, true, true],
        [true, true, true],
      ],
      current: this.me,
      turn: 0,
      actionCount: [0, 0],
      shakeLog: [],
      eventLog: [],
      phase: 'magic',
      result: null,
    };
  }

  /** 台本の札を引かせる乱数．drawFromPileは rng()*長さ を添字にする */
  private rngFor(want: Card | undefined) {
    return () => {
      if (want === undefined) return 0.5;
      const idx = this.s.pile.indexOf(want);
      return idx < 0 ? 0.5 : (idx + 0.5) / this.s.pile.length;
    };
  }

  get view(): ClientView {
    return {
      myInitial: this.s.initialHands[0].slice(),
      oppInitial: this.s.initialHands[1].slice(),
      myHand: this.s.hands[0].slice(),
      myKnown: this.s.known[0].slice(),
      isMyTurn: this.s.phase === 'magic' && this.s.current === this.me,
      canPass:
        this.s.actionCount[0] >= this.cfg.minActionsBeforePass &&
        this.s.actionCount[1] >= this.cfg.minActionsBeforePass,
      canXswap:
        this.s.current === this.me &&
        ([0, 1, 2] as Lane[]).some((m) =>
          ([0, 1, 2] as Lane[]).some((t) => canXswap(this.s, m, t, this.cfg)),
        ),
      canFakeXswap:
        this.s.current === this.me &&
        ([0, 1, 2] as Lane[]).some((m) =>
          ([0, 1, 2] as Lane[]).some((t) => canFakeXswap(this.s, m, t, this.cfg)),
        ),
      canChange: this.s.pile.length > 0,
      pile: this.s.pile.slice(),
      turn: this.s.turn,
    };
  }

  start() {
    this.em.emit({ t: 'start' });
    // 配っている間は，覚えることだけを言う
    this.setGuide({
      who: 'me',
      lead: '3びょう おぼえる',
      note: 'じぶんの札も ふせられる',
    });
  }

  /** 盤が手番を始めたところで最初の一行に差し替える．
   *  配りの長さは演出しだいなので，時間ではなく盤の合図で切り替える */
  begin() {
    this.setGuide(SCRIPT[this.i]?.guide ?? null);
  }

  /** 台本の手だけを受け取る．違う手は短く断って，盤はそのまま */
  myAction(a: Action) {
    const step = SCRIPT[this.i];
    if (!step || step.guide.who !== 'me') throw new Error('あいての ばん');
    if (!sameAction(a, step.action)) {
      // ボタンは合っていて札だけ違うときは，そう言う
      throw new Error(
        a.type === step.action.type
          ? 'えらぶ札が ちがう'
          : `いまは ${pressOf(step.action)}`,
      );
    }

    this.s = applyAction(this.s, a, this.rngFor(step.draw), this.cfg);
    this.i += 1;
    if (this.s.phase === 'reveal') {
      this.setGuide(null);
      this.finish(a.type !== 'pass');
      return;
    }
    this.setGuide(null);
    this.later(() => this.playOpp(), beatOf(a));
  }

  /** 相手の手．台本どおりに打ち，同じ拍で一行を出す */
  private playOpp() {
    const step = SCRIPT[this.i];
    if (!step || step.guide.who !== 'opp' || this.s.phase !== 'magic') return;
    this.setGuide(step.guide);
    this.s = applyAction(this.s, step.action, this.rngFor(step.draw), this.cfg);
    this.i += 1;
    const rec = this.s.shakeLog[this.s.shakeLog.length - 1];
    this.em.emit({
      t: 'oppShake',
      lanes: observableOf(step.action),
      myLanes: foreignOf(step.action),
      ...(rec?.drew !== undefined ? { drew: rec.drew } : {}),
    });
    this.later(
      () => this.setGuide(SCRIPT[this.i]?.guide ?? null),
      beatOf(step.action),
    );
  }

  private finish(byCap: boolean) {
    const r = judgeHands(this.s.hands[0], this.s.hands[1]);
    this.em.emit({
      t: 'finished',
      myHand: this.s.hands[0].slice(),
      oppHand: this.s.hands[1].slice(),
      laneWinners: r.laneWinners.map((w) =>
        w === null ? null : w === this.me ? 'me' : 'opp',
      ),
      score: [r.score[0], r.score[1]],
      winner: r.winner === null ? null : r.winner === this.me ? 'me' : 'opp',
      byCap,
    });
  }

  again() {
    this.clearTimers();
    this.s = this.freshState();
    this.i = 0;
    this.setGuide(null);
    this.start();
  }

  subscribe(cb: (e: SessionEvent) => void) {
    this.em.subs.add(cb);
    this.em.drain(cb);
    return () => this.em.subs.delete(cb);
  }

  /** 盤の下の一行を受け取る．Sessionには無い，あそびかた専用の口 */
  onGuide(cb: (g: Guide | null) => void) {
    this.guideSubs.add(cb);
    cb(this.guide);
    return () => this.guideSubs.delete(cb);
  }

  close() {
    this.clearTimers();
    this.em.subs.clear();
    this.guideSubs.clear();
  }

  private setGuide(g: Guide | null) {
    this.guide = g;
    this.guideSubs.forEach((f) => f(g));
  }
  private later(fn: () => void, ms: number) {
    this.timers.push(setTimeout(fn, ms));
  }
  private clearTimers() {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }
}
