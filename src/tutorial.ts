// あそびかた：台本つきの一局．
// 盤はCpuSessionと同じSessionとして振る舞うので，Game.svelteは普段どおり動く．
// 違うのは三点：配りが固定であること，台本の手以外は受け取らないこと，
// そして4つの手を続けて触らせるあいだ手番を渡さないこと（説明の順を守るため）．
// 説明は文章にせず，押す札とボタンを盤の上で光らせて指す．

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

/** 盤の下に出る一行と，盤の上で光らせるもの．
 *  札の位置は言葉にせず，その札自身を明滅させて指す */
export type Guide = {
  who: 'me' | 'opp';
  lead?: string; // 手の名前で言えないときだけ，見出しをそのまま書く
  mine?: Lane[]; // 光らせる自分の札
  theirs?: Lane[]; // 光らせる相手の札
  press?: string; // 押すボタン／相手が打った手の名前．そのまま見出しになる
  note?: string[]; // 見出しの下に置く説明（1行1つ）
};

type Step = {
  guide: Guide;
  action: Action;
  /** ヤマから引く札．台本どおりに引かせるため，山の中の位置から乱数を逆算する */
  draw?: Card;
  /** この手のあとも自分の手番のままにする（4つの手を続けて触らせる間だけ） */
  keepTurn?: boolean;
  /** 打ったあとに出す一言．打つ前に言っても実感がないものを，ここに置く．
   *  タップで次へ進む */
  after?: Guide;
};

// 配りは固定．自分の合計が小さいので先手も自分になる（10 < 19）
const MY_HAND: Card[] = [5, 3, 2];
const OPP_HAND: Card[] = [9, 4, 6];
const PILE: Card[] = [1, 7, 8];

/** 台本．まず4つの手を続けて触り（そのあいだ手番は渡さない），
 *  相手の番を一度だけ挟んでから，ぱすで開示して終わる．
 *  盤の上は 1負2勝 で終わる（9には勝てないまま） */
const SCRIPT: Step[] = [
  {
    // 2 を捨てて 8 を引く．1レーン取れるようになる
    guide: {
      who: 'me',
      lead: 'やまからかーどをひきなおす',
      mine: [2],
      press: 'ひきなおし',
    },
    action: { type: 'change', lane: 2 },
    draw: 8,
    keepTurn: true,
  },
  {
    // 5 と 3 を入れ替えて，相手の 4 に 5 をぶつける
    guide: {
      who: 'me',
      lead: 'じぶんの2まいをいれかえる',
      mine: [0, 1],
      press: 'いれかえ',
    },
    action: { type: 'swap', lanes: [0, 1] },
    keepTurn: true,
  },
  {
    // 使い道のない 3 を渡して，相手の 6 を取り上げる
    guide: {
      who: 'me',
      lead: 'あいてのかーどとすりかえる',
      mine: [0],
      theirs: [2],
      press: 'すりかえ',
    },
    action: { type: 'xswap', mine: 0, theirs: 2 },
    keepTurn: true,
    // 打つ前に言っても実感がない．一度使ったところで言う
    after: { who: 'me', lead: 'すりかえは いちどのみ' },
  },
  {
    guide: {
      who: 'me',
      lead: 'うごかしたようにみせかける',
      mine: [2],
      theirs: [1],
      press: 'ぶらふ',
    },
    action: { type: 'bluff', lanes: [2], foreign: 1 },
  },
  {
    guide: { who: 'opp', lead: 'あいてもおなじことができる', press: 'ぶらふ' },
    action: { type: 'bluff', lanes: [0], foreign: 1 },
  },
  {
    guide: { who: 'me', lead: 'これでしょうぶする', press: 'ぱす' },
    action: { type: 'pass' },
  },
];

/** 相手の番へ進む前に置く間．読んでから，自分で送る */
const TAP_NOTE = 'たっぷ で つづける';

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

/** 自分の演出が終わるころに相手が動きだすための待ち．引き直しだけ長い */
function beatOf(a: Action): number {
  if (a.type === 'change') return 2600;
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
  /** 透かし．自分の手の効き目が見えるように，4つの手の間は数字を薄く出す．
   *  相手の番に入ったところで消す：そこから先は本物か見せかけかも分からない */
  private peekVal: { mine: Card[]; theirs: Card[] } | null = null;
  private peekSubs = new Set<(v: { mine: Card[]; theirs: Card[] } | null) => void>();
  private peekOn = true;
  /** 止まって読ませているところ．待つのは，読む速さを自分で決めさせるため．
   *  'after' … 打ったあとの一言／'opp' … 相手の番の手前 */
  private waiting: 'after' | 'opp' | null = null;
  private afterGuide: Guide | null = null;
  /** はじめの見せ合いの案内を出している間．伏せたら消す
   *  （先攻の合図が横切ったあとまで「おぼえる」が残っていると，指示に見える） */
  private intro = false;
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
          ([0, 1, 2] as Lane[]).some((t) =>
            canFakeXswap(this.s, m, t, this.cfg),
          ),
        ),
      canChange: this.s.pile.length > 0,
      pile: this.s.pile.slice(),
      turn: this.s.turn,
    };
  }

  start() {
    this.em.emit({ t: 'start' });
    this.refreshPeek();
    // 配っている間は，覚えることだけを言う
    this.intro = true;
    this.setGuide({ who: 'me', lead: 'かーどをおぼえる', note: [TAP_NOTE] });
  }

  /** 盤が自分の入力を受けられるようになったところで，その手の一行を出す．
   *  配りも演出も長さが場面で変わるので，時間ではなく盤の合図に合わせる．
   *  透かしもここで差し替える（演出が済んだ形＝盤に見えている形になる） */
  ready() {
    this.intro = false;
    this.refreshPeek();
    // 打ったあとの一言は，演出が済んでから出す（盤に結果が見えている状態で読む）
    if (this.waiting === 'after' && this.afterGuide) {
      this.setGuide(this.withTap(this.afterGuide));
      return;
    }
    this.showCurrent();
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
    if (step.after) {
      this.afterGuide = step.after;
      this.waiting = 'after'; // 一言は ready（演出のあと）で出す
    }
    // 4つの手を続けて触らせる間は，手番を渡さない
    if (step.keepTurn) {
      this.s = { ...this.s, current: this.me };
      return;
    }
    // ここから相手の番．自分の演出が済んだころに，何が起きるかを出して待つ
    this.later(() => this.offerOpp(), beatOf(a));
  }

  /** 盤のどこかが押された．止まって読ませているときだけ，先へ進む */
  tap() {
    // 覚え終わりの一押し．ここで案内を消す（このあと伏せて，先攻の合図が入る）
    if (this.intro) {
      this.intro = false;
      this.setGuide(null);
      return;
    }
    if (this.waiting === 'after') {
      this.waiting = null;
      this.afterGuide = null;
      const step = SCRIPT[this.i];
      if (step?.guide.who === 'opp') this.offerOpp();
      else this.showCurrent();
      return;
    }
    if (this.waiting === 'opp') {
      this.waiting = null;
      this.playOpp();
    }
  }

  /** 相手の番の手前で止まる．透かしはここで消える */
  private offerOpp() {
    const next = SCRIPT[this.i];
    if (!next || next.guide.who !== 'opp' || this.waiting === 'after') return;
    this.peekOn = false;
    this.refreshPeek();
    this.waiting = 'opp';
    this.setGuide(this.withTap(next.guide));
  }

  /** いまの手の一行を出す（自分の番のときだけ） */
  private showCurrent() {
    const step = SCRIPT[this.i];
    if (step?.guide.who === 'me') this.setGuide(step.guide);
  }

  private withTap(g: Guide): Guide {
    return { ...g, note: [...(g.note ?? []), TAP_NOTE] };
  }

  /** 相手の番．台本どおりに打つ．一行は震えと同じ拍で出す */
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
    // 次の一行は，盤が入力を受けられるようになってから（ready）
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
    this.peekOn = true;
    this.waiting = null;
    this.afterGuide = null;
    this.intro = false;
    this.refreshPeek();
    this.setGuide(null);
    this.start();
  }

  subscribe(cb: (e: SessionEvent) => void) {
    this.em.subs.add(cb);
    this.em.drain(cb);
    return () => this.em.subs.delete(cb);
  }

  /** 伏せた札に透かす数字を受け取る．消えたあとはnull（記憶だけが頼りになる） */
  onPeek(cb: (v: { mine: Card[]; theirs: Card[] } | null) => void) {
    this.peekSubs.add(cb);
    cb(this.peekVal);
    return () => this.peekSubs.delete(cb);
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
    this.peekSubs.clear();
  }

  private refreshPeek() {
    this.peekVal = this.peekOn
      ? { mine: this.s.hands[0].slice(), theirs: this.s.hands[1].slice() }
      : null;
    this.peekSubs.forEach((f) => f(this.peekVal));
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
