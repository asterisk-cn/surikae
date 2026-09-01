<script lang="ts">
  import { tick } from 'svelte';
  import { fly } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import Card from './Card.svelte';
  import {
    observableOf,
    foreignOf,
    type Action,
    type Lane,
    type Card as CardV,
  } from '../engine.ts';
  import {
    type Session,
    type SessionEvent,
    type ClientView,
  } from '../session.ts';

  let {
    session,
    onExit,
    hint = null,
    onReady = undefined,
  }: {
    session: Session;
    onExit: () => void;
    /** あそびかたの一行．普段の対局ではnull */
    hint?: { lead: string; note?: string } | null;
    /** 配りと先攻の合図が済み，手番が始まったところで呼ばれる */
    onReady?: (() => void) | undefined;
  } = $props();

  const SHAKE_MS = 950; // 全アクション共通の演出長（固定）
  const FLIP_MS = 560; // Card.svelte の .flip と揃える
  const FLIP_GAP = 120; // 伏せるときのレーンごとのずらし
  const PREVIEW_MS = 3000; // 開始時，6枚を覚えるための時間
  const REVEAL_MS = 1000; // ヤマから引いた札を両者に見せる時間
  const BANNER_MS = 420; // 先攻／後攻が横切る時間
  // 配りの拍．1〜9が一枚ずつあることを，伏せる前に見せてしまう
  const D_IN = 55; // 9枚が現れるずらし
  const D_RISE = 360; // 一枚が現れる時間
  const D_HOLD = 600; // 並んだまま見せている時間
  const D_TURN = 35; // 伏せるずらし
  const D_GATHER = 400; // 山へ集まる
  const D_CUT = 170; // 一度の切り
  const D_OUT = 80; // 配るずらし
  const D_FLY = 380; // 一枚が飛ぶ時間
  const D_TOSS = 300; // 捨てた札が場から抜けるまで

  let view = $state<ClientView>(session.view);
  let scene = $state<'wait' | 'deal' | 'preview' | 'magic' | 'reveal'>('wait');
  let busy = $state(false);
  let selMine = $state<Lane[]>([]);
  let selOpp = $state<Lane[]>([]);
  let shakingMe = $state([false, false, false]);
  let shakingOpp = $state([false, false, false]);
  let flipped = $state([false, false, false]);
  // 開始時は6枚とも表．「伏せる」で自分の3枚も裏返る（以降は記憶が頼り）
  let openMe = $state([true, true, true]);
  let openOpp = $state([true, true, true]);
  let live = $state(false); // 伏せ終わるまで相手の動きは進めない
  let toast = $state('');
  let banner = $state(''); // 先攻／後攻を画面中央に横切らせる
  let fin = $state<Extract<SessionEvent, { t: 'finished' }> | null>(null);
  let againWait = $state(false); // 対人：相手も押すまで配り直されない

  /** 配りの演出で飛ばす札．盤の実スロットを実測してそこへ運ぶ */
  type Ghost = {
    key: string; // 伏せたまま動かす札は値を持たないので，識別は別に持つ
    v: CardV | null; // 値を見せない札は null（DOMにも載らない）
    own: 'me' | 'opp' | 'none'; // 配る前は中立．縁が誰の色でもない
    x: number; // 盤の左上を原点とした中心座標
    y: number;
    s: number; // 縮尺
    r: number; // 傾き
    o: number; // 不透明度
    up: boolean;
    d: number; // 遷移時間
    delay: number;
  };
  let ghosts = $state<Ghost[]>([]);
  let slotW = $state(0);
  let slotH = $state(0);
  let boardEl = $state<HTMLElement | undefined>(undefined);
  let skipDeal = false;
  // 札を入れ替えている間だけ，そのスロットの本物を消して場所を空ける
  let swapMe = $state<Lane | null>(null);
  let swapOpp = $state<Lane | null>(null);

  let inputOk = $derived(scene === 'magic' && view.isMyTurn && !busy);
  // 本物を使い切っていても「奪うふり」のために相手の札は選べる
  let oppSelectable = $derived(
    inputOk && view.canFakeXswap && selMine.length === 1 && selOpp.length === 0,
  );
  // 1枚＝作り変え／自分2枚＝入れ替え／自分1＋相手1＝奪う
  let actionKind = $derived.by(() => {
    if (selOpp.length === 1 && selMine.length === 1) return 'xswap' as const;
    if (selOpp.length === 0 && selMine.length === 2) return 'swap' as const;
    if (selOpp.length === 0 && selMine.length === 1) return 'change' as const;
    return null;
  });
  // 見せかけ：2枚の「入れ替えのふり」か，相手の札を選んだ「奪うふり」．
  // 作り変えのふりは無い（引いた札は開示されるので嘘が通らない）
  let bluffAction = $derived.by<Action | null>(() => {
    if (selMine.length === 1 && selOpp.length === 1)
      return { type: 'bluff', lanes: [selMine[0]], foreign: selOpp[0] };
    if (selOpp.length === 0 && selMine.length === 2)
      return { type: 'bluff', lanes: selMine.slice().sort() as Lane[] };
    return null;
  });
  let canBluff = $derived(bluffAction !== null);
  // すりかえは一局に一度きり．使い切ってから同じ手を組んだら，ボタンがそう言う
  let xswapSpent = $derived(actionKind === 'xswap' && !view.canXswap);
  // 札は1〜9が一枚ずつ．山の3枚が出きったら，もう引けない
  let pileEmpty = $derived(actionKind === 'change' && !view.canChange);
  // 「すりかえ」ボタンは，いま選んでいる手の名前になる
  let actLabel = $derived(
    xswapSpent
      ? 'もうつかえない'
      : pileEmpty
        ? 'やまがない'
        : actionKind === 'change'
          ? 'ひきなおし'
          : actionKind === 'swap'
            ? 'いれかえ'
            : 'すりかえ',
  );
  // 手番は，その側の卓の縁を染めて示す
  let turnSide = $derived.by(() => {
    if (scene !== 'magic' || !live) return null;
    // 自分の手はエンジン側では即座に解決されるので，演出の途中で view の手番は
    // もう相手に移っている．引いた札をめくっている間に朱が点くのはおかしいので，
    // 自分の演出が終わるまでは自分の側を灯したままにする
    if (acting) return 'me';
    return view.isMyTurn ? 'me' : 'opp';
  });
  // 奪うのは回数が残っているとき，引くのは山があるときだけ．ふりはいつでも打てる
  let canAct = $derived(actionKind !== null && !xswapSpent && !pileEmpty);

  function sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
  }
  function refresh() {
    view = session.view;
  }

  function myFaceUp(l: number) {
    return openMe[l] || flipped[l];
  }
  function oppFaceUp(l: number) {
    return openOpp[l] || flipped[l];
  }
  /** 盤のスロットを実測する．配りと引き直しの両方で使う．
      .row に限るのは，配り札の層まで拾わないため */
  function measureSlots() {
    const board = boardEl;
    const cards = board
      ? ([...board.querySelectorAll('.row button.card')] as HTMLElement[])
      : [];
    if (!board || cards.length !== 6) return null;
    const first = cards[0].getBoundingClientRect();
    if (first.width < 24 || first.height < 24) return null;
    const br = board.getBoundingClientRect();
    return {
      board,
      w: first.width,
      h: first.height,
      rc: cards.map((c) => {
        const r = c.getBoundingClientRect();
        return {
          cx: r.left - br.left + r.width / 2,
          cy: r.top - br.top + r.height / 2,
        };
      }),
    };
  }

  /** 札の入れ替え．まず古い札を伏せたまま自分の側の外へ捨て，空いたところへ
      引いた札が山のあった位置から表向きで飛んでくる．読ませてから一度だけ伏せる．
      捨て札を表にしないのは，すりかえで正体を失ったレーンを引き直したとき，
      受け取っていた札の値が本人に分かってしまうため（値もDOMに載せない）．
      「中身が変わった面を表に返す」向きを通らないので，回転の後半が描かれ
      損ねて札が消える問題も経路から無くなる */
  async function replaceDrawn(side: 'me' | 'opp', l: Lane, drawn: CardV) {
    const m = measureSlots();
    if (!m) {
      await sleep(REVEAL_MS); // 測れないときは間だけ取る
      return;
    }
    slotW = m.w;
    slotH = m.h;
    const k = side === 'opp' ? l : 3 + l;
    const slot = m.rc[k];
    const pileCx = (m.rc[0].cx + m.rc[2].cx) / 2;
    const pileCy = (m.rc[0].cy + m.rc[3].cy) / 2; // 中央の境界線＝山のあった場所
    const away = side === 'me' ? m.h * 0.6 : -m.h * 0.6; // 自分の側の外へ
    if (side === 'me') swapMe = l;
    else swapOpp = l;
    try {
      // ---- 捨てる：伏せたまま，場から抜けていく ----
      ghosts = [
        {
          key: 'toss',
          v: null,
          own: side,
          x: slot.cx,
          y: slot.cy,
          s: 1,
          r: 0,
          o: 1,
          up: false,
          d: 0,
          delay: 0,
        },
      ];
      await tick();
      void m.board.offsetHeight;
      ghosts = ghosts.map((g) => ({
        ...g,
        y: slot.cy + away,
        s: 0.82,
        r: jitter(l + 1, 9),
        o: 0,
        d: D_TOSS,
      }));
      await sleep(D_TOSS * 0.6); // 抜けきる前に次の札が動きだす

      // ---- 引く：山のあった位置から表向きで飛んでくる ----
      ghosts = [
        ...ghosts,
        {
          key: 'draw',
          v: drawn,
          own: side,
          x: pileCx,
          y: pileCy,
          s: 0.88,
          r: jitter(drawn, 7),
          o: 1,
          up: true,
          d: 0,
          delay: 0,
        },
      ];
      await tick();
      void m.board.offsetHeight;
      ghosts = ghosts.map((g) =>
        g.key === 'draw'
          ? { ...g, x: slot.cx, y: slot.cy, s: 1, r: 0, d: D_FLY }
          : g,
      );
      await sleep(D_FLY);
      ghosts = ghosts.filter((g) => g.key === 'draw'); // 捨て札はもう消えている
      await sleep(REVEAL_MS); // 重なったまま読ませる
      ghosts = ghosts.map((g) => ({ ...g, up: false, d: 0 }));
      await sleep(FLIP_MS); // 一度だけ伏せる
    } finally {
      ghosts = [];
      if (side === 'me') swapMe = null;
      else swapOpp = null;
    }
  }

  function myShown(l: number): CardV | null {
    if (scene === 'reveal' && fin) return fin.myHand[l];
    return view.myKnown[l] ? view.myHand[l] : null;
  }

  // ---- イベント直列化 ----
  const q: SessionEvent[] = [];
  let pumping = false;
  let acting = $state(false); // 自分の演出中は相手の演出を割り込ませない
  const unsubscribe = session.subscribe((e) => {
    q.push(e);
    void pump();
  });
  $effect(() => () => {
    unsubscribe();
    session.close();
  });

  async function pump() {
    if (pumping) return;
    pumping = true;
    while (q.length > 0) {
      const e = q[0];
      // 伏せ終わるまで，また自分の演出が終わるまでは，相手の動きを保留する
      if ((!live || acting) && e.t !== 'start') break;
      q.shift();
      if (e.t === 'start') {
        refresh();
        // 二局目以降：前の局の名残を消してから配りに入る
        fin = null;
        flipped = [false, false, false];
        shakingMe = [false, false, false];
        shakingOpp = [false, false, false];
        selMine = [];
        selOpp = [];
        swapMe = null;
        swapOpp = null;
        ghosts = [];
        toast = '';
        banner = '';
        live = false;
        busy = false;
        skipDeal = false;
        againWait = false;
        // 配り終わるまで盤の6枚は伏せたまま．表に返すのは配りの後
        openMe = [false, false, false];
        openOpp = [false, false, false];
        scene = 'deal';
        void dealThenPreview();
      } else if (e.t === 'oppShake') {
        busy = true;
        await Promise.all([
          playShake('opp', e.lanes),
          e.myLanes?.length ? playShake('me', e.myLanes) : Promise.resolve(),
        ]);
        refresh();
        if (e.drew !== undefined && e.lanes.length === 1) {
          await replaceDrawn('opp', e.lanes[0], e.drew);
        }
        busy = false;
      } else if (e.t === 'oppPass') {
        busy = true;
        toast = 'あいてがぱす';
        await sleep(950);
        toast = '';
        refresh();
        busy = false;
      } else if (e.t === 'finished') {
        fin = e;
        if (e.byCap) {
          toast = 'てかずぎれ';
          await sleep(950);
          toast = '';
        }
        await revealSequence();
      } else if (e.t === 'error') {
        toast = e.message;
      }
    }
    pumping = false;
  }

  async function playShake(side: 'me' | 'opp', lanes: Lane[]) {
    const target = side === 'me' ? shakingMe : shakingOpp;
    for (const l of lanes) target[l] = true;
    await sleep(SHAKE_MS);
    for (const l of lanes) target[l] = false;
    await sleep(120);
  }

  function pickMine(l: Lane) {
    if (!inputOk) return;
    if (selMine.includes(l)) selMine = selMine.filter((x) => x !== l);
    else if (selOpp.length === 1) selMine = [l];
    else if (selMine.length < 2) selMine = [...selMine, l];
  }
  function pickOpp(l: Lane) {
    if (!oppSelectable && !selOpp.includes(l)) return;
    if (selOpp.includes(l)) selOpp = [];
    else selOpp = [l];
  }
  function clearSel() {
    selMine = [];
    selOpp = [];
  }

  async function act(real: boolean) {
    if (!inputOk) return;
    const mine = selMine.slice().sort() as Lane[];
    const opp = selOpp.slice() as Lane[];
    let a: Action | null = null;
    if (!real) {
      a = bluffAction;
    } else if (actionKind === 'xswap') {
      a = { type: 'xswap', mine: mine[0], theirs: opp[0] };
    } else if (actionKind === 'swap') {
      a = { type: 'swap', lanes: [mine[0], mine[1]] };
    } else if (actionKind === 'change') {
      a = { type: 'change', lane: mine[0] };
    }
    if (!a) return;
    busy = true;
    acting = true;
    clearSel();
    try {
      session.myAction(a); // 即時解決されるが，表示は演出後（操作時間を固定）
    } catch (err) {
      toast = err instanceof Error ? err.message : 'そのてはうてない';
      await sleep(1300);
      toast = '';
      busy = false;
      acting = false;
      void pump();
      return;
    }
    const fr = foreignOf(a);
    await Promise.all([
      playShake('me', observableOf(a)),
      fr.length ? playShake('opp', fr) : Promise.resolve(),
    ]);
    refresh();
    // 引いた札は自分の手元でも一瞬だけ開いて，また伏せる
    if (a.type === 'change')
      await replaceDrawn('me', a.lane, view.myHand[a.lane]);
    busy = false;
    acting = false;
    void pump();
  }

  async function passAct() {
    if (!inputOk || !view.canPass) return;
    busy = true;
    acting = true;
    clearSel();
    try {
      session.myAction({ type: 'pass' });
    } catch (err) {
      toast = err instanceof Error ? err.message : 'そのてはうてない';
      await sleep(1300);
      toast = '';
      busy = false;
      acting = false;
      void pump();
      return;
    }
    toast = 'ぱす';
    await sleep(600); // 自分の手は分かっているので短く．開示を待たせない
    toast = '';
    refresh();
    busy = false;
    acting = false;
    void pump();
  }

  /** 添字から決まる小さな揺らぎ（毎回同じ絵になるよう乱数は使わない） */
  function jitter(i: number, amp: number) {
    return (((i * 2654435761) % 1000) / 1000) * amp - amp / 2;
  }

  /** 9枚を並べて見せ，伏せ，山にまとめて切り，6枚を配る．
      配られる札の正体は伏せてから決まるので，並びから手札は読めない */
  async function dealSequence() {
    await tick();
    const board = boardEl;
    const cards = board
      ? ([...board.querySelectorAll('.row button.card')] as HTMLElement[])
      : [];
    const deck = [...view.myInitial, ...view.oppInitial, ...view.pile].sort(
      (a, b) => a - b,
    );
    // 測れない・枚数が合わないときは黙って飛ばす（演出は無くても進行は同じ）
    if (!board || cards.length !== 6 || deck.length < 6) return;

    // スロットを実測する．背面タブなどで配置がまだ来ていないことがあるので少し粘る
    let first = cards[0].getBoundingClientRect();
    for (let i = 0; i < 5 && first.width < 24; i++) {
      await sleep(60);
      void board.offsetHeight;
      first = cards[0].getBoundingClientRect();
    }
    // それでも測れないなら演出はやらない．潰れた札を出すより何も出さない方がいい
    if (first.width < 24 || first.height < 24) return;
    const br = board.getBoundingClientRect();
    const rc = cards.map((c) => {
      const r = c.getBoundingClientRect();
      return {
        cx: r.left - br.left + r.width / 2,
        cy: r.top - br.top + r.height / 2,
      };
    });
    slotW = first.width;
    slotH = first.height;

    // 盤の中心を軸に，はみ出さない縮尺で3列に並べる
    const bcx = br.width / 2;
    const bcy = br.height / 2;
    const main = board.parentElement;
    const mr = main?.getBoundingClientRect();
    const head = main?.querySelector('header')?.getBoundingClientRect();
    const room = mr
      ? Math.max(
          0,
          Math.min(br.top - ((head?.bottom ?? mr.top) + 8), mr.bottom - br.bottom),
        )
      : 0;
    const gapY = 12;
    const rows = Math.ceil(deck.length / 3);
    const availH = br.height + 2 * room;
    const S = Math.min(1, (availH - (rows - 1) * gapY) / (rows * slotH));
    const rowStep = slotH * S + gapY;
    const gx = (c: number) => bcx + (rc[c].cx - bcx) * S;
    const gy = (r: number) => bcy + (r - (rows - 1) / 2) * rowStep;

    const settle = async (ms: number) => {
      const t0 = performance.now();
      while (performance.now() - t0 < ms) {
        if (skipDeal) return false;
        await sleep(Math.min(50, ms));
      }
      return true;
    };

    // ---- 並ぶ：1〜9が表のまま，少し下から立ち上がる ----
    ghosts = deck.map((v, i) => ({
      key: 'deal' + v,
      v,
      own: 'none' as const,
      x: gx(i % 3),
      y: gy(Math.floor(i / 3)) + 16,
      s: S,
      r: 0,
      o: 0,
      up: true,
      d: 0,
      delay: 0,
    }));
    await tick();
    void board.offsetHeight; // 初期位置を確定させてから動かす（rAFは背面タブで止まる）
    ghosts = ghosts.map((g, i) => ({
      ...g,
      y: gy(Math.floor(i / 3)),
      o: 1,
      d: D_RISE,
      delay: i * D_IN,
    }));
    if (!(await settle(D_RISE + deck.length * D_IN + D_HOLD))) return;

    // ---- 伏せる ----
    for (let i = 0; i < ghosts.length; i++) {
      ghosts[i].up = false;
      if (skipDeal) break;
      await sleep(D_TURN);
    }
    if (!(await settle(FLIP_MS))) return;

    // ---- 山にまとまる ----
    ghosts = ghosts.map((g, i) => ({
      ...g,
      x: bcx + jitter(i, 2),
      y: bcy + (i - deck.length / 2) * 0.8,
      s: S * 0.94,
      r: jitter(i, 5),
      d: D_GATHER,
      delay: i * 16,
    }));
    if (!(await settle(D_GATHER + deck.length * 16))) return;

    // ---- 切る：二つに割ってぶつける ----
    for (const pass of [0, 1]) {
      const half = pass % 2 === 0 ? 4 : 5;
      ghosts = ghosts.map((g, i) => ({
        ...g,
        x: bcx + (i < half ? 30 : -30) + jitter(i, 2),
        r: (i < half ? 4 : -4) + jitter(i, 4),
        d: D_CUT,
        delay: 0,
      }));
      if (!(await settle(D_CUT))) return;
      ghosts = ghosts.map((g, i) => ({
        ...g,
        x: bcx + jitter(i + pass, 2),
        r: jitter(i + pass, 6),
        d: D_CUT,
        delay: 0,
      }));
      if (!(await settle(D_CUT))) return;
    }

    // ---- 配る：伏せたまま，どの札がどこへ行くかは見えない ----
    dealOut(rc);
    if (!(await settle(D_FLY + 5 * D_OUT))) return;
  }

  /** 6枚をスロットへ．残りはヤマとして中央に残る．
      途中で飛ばされたときもここを通るので，まず全部を伏せて山にまとめ直す */
  function dealOut(rc: { cx: number; cy: number }[]) {
    const want = [...view.oppInitial, ...view.myInitial];
    const taken = new Set<number>();
    const cx = (rc[0].cx + rc[2].cx) / 2;
    const cy = (rc[0].cy + rc[3].cy) / 2; // 上下の列の中間＝中央の境界線
    ghosts = ghosts.map((g, i) => ({
      ...g,
      up: false,
      x: cx + jitter(i, 2),
      y: cy + (i - ghosts.length / 2) * 0.8,
      r: jitter(i, 5),
      d: D_FLY,
      delay: 0,
    }));
    for (let k = 0; k < 6; k++) {
      const i = ghosts.findIndex((g, j) => !taken.has(j) && g.v === want[k]);
      if (i < 0) continue;
      taken.add(i);
      ghosts[i] = {
        ...ghosts[i],
        x: rc[k].cx,
        y: rc[k].cy,
        s: 1,
        r: 0,
        up: true, // 飛びながら表を向く．値は並びの場面で描かれているので安全
        own: k < 3 ? 'opp' : 'me',
        d: D_FLY,
        delay: k * D_OUT,
      };
    }
    // 本物も表で現れるようにしておく．伏せて置いてから返すと，一度も描かれて
    // いない表面を表に向けることになり，回転の後半が無地の板になる．
    // いまは .dealing で列が隠れているので，この返りは見えないまま終わる
    openMe = [true, true, true];
    openOpp = [true, true, true];
    // 配られなかった札は場に残さない．中央に置いたままだと卓の6枚と重なる
    ghosts = ghosts.map((g, i) =>
      taken.has(i) ? g : { ...g, o: 0, s: g.s * 0.85, d: D_FLY, delay: 0 },
    );
  }

  /** 配り → 6枚を表に返す → 覚える時間 → 伏せる */
  async function dealThenPreview() {
    await dealSequence();
    // 飛ばされた／測れなかったときのために，最後は必ず配り切った形にする
    if (ghosts.length && boardEl) {
      const cards = [...boardEl.querySelectorAll('.row button.card')] as HTMLElement[];
      if (cards.length === 6) {
        const br = boardEl.getBoundingClientRect();
        dealOut(
          cards.map((c) => {
            const r = c.getBoundingClientRect();
            return {
              cx: r.left - br.left + r.width / 2,
              cy: r.top - br.top + r.height / 2,
            };
          }),
        );
        await sleep(skipDeal ? FLIP_MS : 0); // 隠れたまま返り終わるのを待つ
      }
    }
    // 受け渡し：表のままの本物が同じ位置に現れ，配り札は消える．
    // 返す動きが要らないので継ぎ目も待ちも無い
    scene = 'preview';
    await tick();
    ghosts = ghosts.map((g) => ({ ...g, o: 0, d: 260, delay: 0 }));
    await sleep(260);
    ghosts = [];
    await previewThenCover();
  }

  async function previewThenCover() {
    await sleep(PREVIEW_MS);
    await coverAll();
  }

  /** 6枚を順に伏せる．ここから先は，自分の札も記憶だけが頼りになる */
  async function coverAll() {
    if (busy || scene !== 'preview') return;
    busy = true;
    acting = true;
    scene = 'magic';
    for (const l of [0, 1, 2]) {
      openOpp[l] = false;
      openMe[l] = false;
      if (l < 2) await sleep(FLIP_GAP);
    }
    await sleep(FLIP_MS + 80); // 6枚が伏せ切るのを待ってから
    banner = view.isMyTurn ? 'せんこう' : 'こうこう';
    await sleep(BANNER_MS + 650); // 横切る間だけでは読めないので少し留める
    banner = ''; // 抜けていく間に手番が始まる
    await sleep(BANNER_MS);
    busy = false;
    acting = false;
    live = true;
    onReady?.();
    void pump();
  }

  /** もう一局．対人では相手も押したところで配り直される（それまでは待つ） */
  function again() {
    if (againWait) return;
    againWait = true;
    session.again();
  }

  async function revealSequence() {
    scene = 'reveal';
    await sleep(220);
    for (const l of [0, 1, 2] as Lane[]) {
      flipped[l] = true;
      await sleep(380);
    }
  }

  function verdictFor(l: Lane, who: 'me' | 'opp'): 'win' | 'lose' | 'tie' | null {
    if (scene !== 'reveal' || !flipped[l] || !fin) return null;
    const w = fin.laneWinners[l];
    if (w === null) return 'tie';
    return w === who ? 'win' : 'lose';
  }

  let verdictText = $derived.by(() => {
    if (!fin || scene !== 'reveal' || flipped.some((f) => !f)) return '';
    if (fin.winner === 'me') return 'かち';
    if (fin.winner === 'opp') return 'まけ';
    return 'ひきわけ';
  });

  function oppShown(l: number): CardV | null {
    if (scene === 'reveal' && fin) return fin.oppHand[l];
    // 引いた札は配り札の層で見せるので，盤の札は初期の公開値のままでよい
    return view.oppInitial[l] ?? null;
  }
</script>

<svelte:window
  onpointerdown={() => {
    if (scene === 'deal') skipDeal = true;
  }}
/>

<main>
  <header>
    <h1>すりかえ</h1>
    <button class="exit" onclick={onExit} aria-label="もどる" title="もどる">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M14 4H6.5A1.5 1.5 0 0 0 5 5.5v13A1.5 1.5 0 0 0 6.5 20H14" />
        <path d="M17.5 8.5 21 12l-3.5 3.5" />
        <path d="M21 12h-10.5" />
      </svg>
    </button>
  </header>

  {#if scene === 'wait'}
    <section class="board center">
      <p class="hint waiting">たいきちゅう</p>
    </section>
  {:else}
    <!-- 盤は一枚きり．場面が変わっても札は差し替えず，表裏だけを返す -->
    <section class="board" class:dealing={scene === 'deal'} bind:this={boardEl}>
      <!-- 手番の合図：中央の境界線から，その側へ伸びる -->
      <div class="side top" class:on={turnSide === 'opp'} aria-hidden="true"></div>
      <div class="side bottom" class:on={turnSide === 'me'} aria-hidden="true"></div>

      <div class="row">
        {#each [0, 1, 2] as l}
          <Card
            value={oppShown(l)}
            faceUp={oppFaceUp(l)}
            hidden={swapOpp === l}
            shaking={shakingOpp[l]}
            selected={selOpp.includes(l as Lane)}
            selectable={oppSelectable || selOpp.includes(l as Lane)}
            pulse={scene === 'preview'}
            owner="opp"
            verdict={verdictFor(l as Lane, 'opp')}
            onclick={() => pickOpp(l as Lane)}
          />
        {/each}
      </div>
      <div class="lanes" aria-hidden="true"></div>
      {#if banner}
        <!-- 先攻／後攻は自分の札の下を横切る -->
        <div class="banner" aria-live="polite">
          <span
            in:fly={{ x: -180, duration: BANNER_MS, easing: cubicOut }}
            out:fly={{ x: 180, duration: BANNER_MS, easing: cubicOut }}
            >{banner}</span
          >
        </div>
      {/if}

      {#if ghosts.length}
        <!-- 配り：9枚が並び，伏せ，山にまとまり，6枚が卓へ出ていく -->
        <div class="dealer" aria-hidden="true">
          {#each ghosts as g (g.key)}
            <div
              class="ghost"
              style="width:{slotW}px;height:{slotH}px;opacity:{g.o};transition-duration:{g.d}ms;transition-delay:{g.delay}ms;transform:translate({g.x -
                slotW / 2}px,{g.y - slotH / 2}px) scale({g.s}) rotate({g.r}deg)"
            >
              <Card value={g.v} faceUp={g.up} owner={g.own} />
            </div>
          {/each}
        </div>
      {/if}

      <div class="row">
        {#each [0, 1, 2] as l}
          <Card
            value={myShown(l)}
            faceUp={myFaceUp(l)}
            hidden={swapMe === l}
            shaking={shakingMe[l]}
            selected={selMine.includes(l as Lane)}
            selectable={inputOk}
            pulse={scene === 'preview'}
            owner="me"
            verdict={verdictFor(l as Lane, 'me')}
            onclick={() => pickMine(l as Lane)}
          />
        {/each}
      </div>

    </section>

    <section class="dock">
      {#if hint && scene !== 'reveal' && !banner}
        <p class="guide" class:opp={hint.lead.startsWith('あいて')}>
          {hint.lead}
        </p>
        {#if hint.note}<p class="guide-note">{hint.note}</p>{/if}
      {/if}
      {#if toast}
        <p class="toast">{toast}</p>
      {:else if scene === 'magic'}
        {#if inputOk}
          <div class="actions">
            <button
              class="act"
              class:spent={xswapSpent}
              disabled={!canAct}
              onclick={() => act(true)}>{actLabel}</button
            >
            <button class="act" disabled={!canBluff} onclick={() => act(false)}
              >ぶらふ</button
            >
            <button class="act" disabled={!view.canPass} onclick={passAct}
              >ぱす</button
            >
          </div>
        {/if}
      {:else if verdictText}
        <p class="verdict">{verdictText}</p>
        <p class="score">{fin?.score[0]} - {fin?.score[1]}</p>
        <button class="primary" disabled={againWait} onclick={again}
          >{againWait ? 'あいてをまつ' : 'もういちど'}</button
        >
      {/if}
    </section>
  {/if}
</main>

<style>
  /* 手番の合図：中央の境界線を芯に，その側へ伸びて薄れていく染み．
     両側とも top:50%（= .lanes の線の高さ）に置き，そこから外へ向かって開く．
     色ごとに濃さが違うのは意図的：卓が深藍なので，朱は色相の反転だけで立つが，
     藍は同系で色相に逃げ場がなく，明度で稼ぐしかない．地との知覚差（ΔE2000）を
     両側とも約35.5に揃えた結果が，白藍0.58／朱0.79という非対称な濃さ */
  .side {
    position: absolute;
    left: 50%;
    top: 50%;
    width: 168%;
    height: 30dvh;
    min-height: 190px;
    pointer-events: none;
    opacity: 0;
    transition: opacity 500ms ease;
    z-index: -1;
  }
  .side.on { opacity: 1; }
  .side.top {
    transform: translate(-50%, -100%);
    background: radial-gradient(
      ellipse at 50% 100%,
      rgba(199, 62, 58, 0.79) 0%,
      rgba(199, 62, 58, 0.3) 38%,
      rgba(199, 62, 58, 0) 70%
    );
  }
  .side.bottom {
    transform: translate(-50%, 0);
    background: radial-gradient(
      ellipse at 50% 0%,
      rgba(178, 208, 236, 0.58) 0%,
      rgba(178, 208, 236, 0.22) 38%,
      rgba(178, 208, 236, 0) 70%
    );
  }

  /* 配りの層．盤の実スロットを実測して，そこへ札を運ぶ */
  .dealer {
    position: absolute;
    inset: 0;
    pointer-events: none;
    z-index: 10;
  }
  .ghost {
    position: absolute;
    left: 0;
    top: 0;
    transform-origin: 50% 50%;
    transition-property: transform, opacity;
    transition-timing-function: cubic-bezier(0.3, 0.7, 0.2, 1);
    will-change: transform, opacity;
  }
  /* 配っている間，本物の6枚は場所だけ取って姿を消している */
  .board.dealing .row {
    opacity: 0;
  }

  /* 先攻／後攻：盤の上を横切って消える */
  /* 先攻／後攻は自分についての知らせなので，自分の札の下に出す．
     操作列と同じ高さに載るので，これから手を選ぶ場所で告げられる */
  .banner {
    position: absolute;
    left: 0;
    right: 0;
    top: 100%;
    display: grid;
    place-items: center;
    padding-top: 20px;
    pointer-events: none;
    z-index: 20;
  }
  .banner span {
    font-family: var(--font-display);
    font-weight: 800;
    /* 字送り0.42emで4文字．狭い画面でもはみ出さないよう上下を挟む */
    font-size: clamp(2.6rem, 13vw, 3.4rem);
    letter-spacing: 0.42em;
    text-indent: 0.42em;
    color: var(--kin);
    text-shadow: 0 0 28px rgba(11, 14, 26, 0.9);
  }

  main {
    height: 100dvh;
    max-width: 480px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    padding: max(env(safe-area-inset-top), 12px) 16px
      max(env(safe-area-inset-bottom), 12px);
  }

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding-bottom: 6px;
  }
  h1 {
    font-family: var(--font-display);
    font-weight: 700;
    font-size: 1.35rem;
    letter-spacing: 0.35em;
  }
  h1 span {
    font-size: 0.8rem;
    letter-spacing: 0.3em;
    color: var(--washi-dim);
  }
  /* 退出：戸口から出ていく形 */
  .exit {
    display: grid;
    place-items: center;
    width: 34px;
    height: 34px;
    margin-right: -6px;
    color: rgba(236, 229, 211, 0.45);
    transition: color 150ms ease;
  }
  .exit:hover { color: var(--washi); }
  .exit svg {
    width: 20px;
    height: 20px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .board {
    position: relative;
    z-index: 0;
    flex: 0 0 auto;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 0;
    min-height: 0;
    margin-top: auto; /* 盤と操作列をひとかたまりで中央に置く */
  }
  .board.center {
    flex: 1;
    align-items: center;
  }
  .row {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 14px;
    padding: 0 6px;
  }
  /* 中央の境界線 */
  .lanes {
    position: relative;
    height: 52px;
  }
  .lanes::before {
    content: '';
    position: absolute;
    left: -16px;
    right: -16px;
    top: 50%;
    height: 1px;
    background: linear-gradient(
      to right,
      transparent,
      rgba(236, 229, 211, 0.32) 12%,
      rgba(236, 229, 211, 0.32) 88%,
      transparent
    );
    opacity: 1;
    transition: opacity 500ms ease;
  }
  /* 線は卓が出来てから引かれる．配っている間はまだ卓が無い */
  .board.dealing .lanes::before {
    opacity: 0;
  }

  .dock {
    margin-bottom: auto;
    min-height: 118px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: flex-start;
    gap: 10px;
    padding-top: 20px;
    text-align: center;
  }
  .hint {
    font-size: 0.82rem;
    color: var(--washi-dim);
    letter-spacing: 0.06em;
  }
  .waiting { animation: breathe 2.2s ease-in-out infinite; }
  @keyframes breathe {
    0%, 100% { opacity: 0.45; }
    50% { opacity: 1; }
  }
  /* あそびかたの一行．手番の色（自分＝藍鼠／相手＝朱）で誰の番かを兼ねる */
  .guide {
    font-family: var(--font-display);
    font-size: 0.95rem;
    font-weight: 700;
    letter-spacing: 0.1em;
    color: var(--ai);
  }
  .guide.opp { color: var(--shu); }
  .guide-note {
    font-size: 0.72rem;
    letter-spacing: 0.08em;
    color: rgba(236, 229, 211, 0.45);
    margin-top: -4px;
  }
  .toast {
    font-family: var(--font-display);
    font-size: 1rem;
    letter-spacing: 0.2em;
    color: var(--kin);
  }

  /* 三つの選択肢は等価に並べる．どれを選んだかを相手に悟らせない */
  .actions {
    display: flex;
    gap: 10px;
    width: 100%;
    max-width: 340px;
    padding: 0 6px;
  }
  .act {
    flex: 1;
    padding: 12px 0;
    border: 1px solid var(--washi-dim);
    border-radius: 6px;
    color: var(--washi);
    font-size: 0.95rem;
    letter-spacing: 0.12em;
    white-space: nowrap;
    transition: opacity 150ms ease, transform 120ms ease;
  }
  /* 「もうつかえない」は他より長いので，枠を保ったまま字を詰める */
  .act.spent {
    font-size: 0.78rem;
    letter-spacing: 0.04em;
  }
  .primary {
    padding: 12px 22px;
    border-radius: 6px;
    font-size: 0.95rem;
    letter-spacing: 0.2em;
    background: var(--washi);
    color: var(--sumi);
    font-weight: 700;
    transition: opacity 150ms ease, transform 120ms ease;
  }
  .act:not(:disabled):active,
  .primary:not(:disabled):active {
    transform: translateY(1px);
  }
  button:disabled { opacity: 0.3; cursor: default; }

  .verdict {
    font-family: var(--font-display);
    font-size: 1.5rem;
    letter-spacing: 0.3em;
    color: var(--kin);
  }
  .score {
    font-family: var(--font-display);
    color: var(--washi-dim);
    letter-spacing: 0.2em;
  }
</style>
