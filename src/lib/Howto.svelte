<script lang="ts">
  // あそびかた．ルールはengine.tsの実装（DEFAULT_CONFIG）に合わせる．
  // 盤の言葉遣いはGame.svelteのボタン（いれかえ／ひきなおし／すりかえ／ぶらふ／ぱす）と揃える．
  let { onBack }: { onBack: () => void } = $props();
</script>

<main class="howto">
  <header>
    <h2>あそびかた</h2>
    <button class="exit" onclick={onBack} aria-label="もどる" title="もどる">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M14 4H6.5A1.5 1.5 0 0 0 5 5.5v13A1.5 1.5 0 0 0 6.5 20H14" />
        <path d="M17.5 8.5 21 12l-3.5 3.5" />
        <path d="M21 12h-10.5" />
      </svg>
    </button>
  </header>

  <div class="scroll">
    <p class="lead">
      3つのれーんに札を1枚ずつ．数の大きいほうがそのれーんを取り，
      2れーン以上を取ったほうのかち．同数はひきわけ．
    </p>

    <section>
      <h3>くばり</h3>
      <ul>
        <li>札は<b>1〜9が一枚ずつ</b>．そこから3枚ずつ配り，残る3枚がヤマになる．</li>
        <li>
          はじめの3秒だけ6枚すべてが開く．そのあと<b>自分の3枚もふくめて伏せる</b>．
          以降どちらの札も見えない．たよりは記憶だけ．
        </li>
        <li>合計の小さいほうが先手．</li>
      </ul>
    </section>

    <section>
      <h3>てばん</h3>
      <p class="note">
        札を選ぶと，選びかたでボタンの名前が変わる．押した手はその場で解決される．
      </p>
      <dl>
        <dt>いれかえ</dt>
        <dd>自分の2枚を選ぶ．そのれーんの中身が入れ替わる．何度でも打てる．</dd>

        <dt>ひきなおし</dt>
        <dd>
          自分の1枚を選ぶ．ヤマの札と取り替える．
          引いた札は<b>1秒だけ両者に見えて</b>から伏せられる．
          捨てた札は戻らないので，ヤマは3枚で尽きる．
        </dd>

        <dt>すりかえ</dt>
        <dd>
          自分の1枚と相手の1枚を選ぶ．<b>伏せたまま</b>取り替えるので，
          受け取った札の正体は<b>どちらにも分からなくなる</b>．
          一局に一度きり．直前にすりかえられた組み合わせをそのまま
          取り返すことはできない（こう）．
        </dd>

        <dt>ぶらふ</dt>
        <dd>
          札は動かさず，<b>震えだけ</b>を起こす．
          「いれかえのふり」（自分の2枚）と「すりかえのふり」（自分の1枚＋相手の1枚）が打てる．
          すりかえのふりを受けた側は，本物と区別がつかないので
          そのれーんの正体を失う．ひきなおしのふりは無い
          ——引いた札は開示されるので，札が出なければ嘘だと分かってしまう．
        </dd>

        <dt>ぱす</dt>
        <dd>
          その場で決着し，6枚が開かれる．
          ただし<b>互いに一手打つまでは押せない</b>．
          どちらもぱすしないまま8手ずつ打つと，そこで打ち切って決着になる．
        </dd>
      </dl>
    </section>

    <section>
      <h3>みえるもの</h3>
      <ul>
        <li>盤の札は最後まで見えない．見えるのは<b>震えたれーんだけ</b>．</li>
        <li>
          いれかえは自分側が2つ，ひきなおしは自分側が1つ，
          すりかえは<b>自分側1つと相手側1つ</b>が震える．
        </li>
        <li>
          ぶらふの震えは本物とまったく同じ．
          すりかえの信号をk回出したなら，少なくともk−1回は嘘——
          けれど，どれが嘘かは分からない．
        </li>
      </ul>
    </section>

    <button class="primary" onclick={onBack}>とじる</button>
  </div>
</main>

<style>
  .howto {
    height: 100dvh;
    max-width: 480px;
    margin: 0 auto;
    padding: 18px 20px 0;
    display: flex;
    flex-direction: column;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding-bottom: 12px;
    flex: none;
  }
  h2 {
    font-family: var(--font-display);
    font-weight: 800;
    font-size: 1.15rem;
    letter-spacing: 0.3em;
    text-indent: 0.3em;
  }
  .exit {
    width: 34px;
    height: 34px;
    display: grid;
    place-items: center;
    color: var(--washi-dim);
  }
  .exit svg {
    width: 20px;
    height: 20px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding-bottom: 28px;
    /* 上端・下端で文が断ち切られているように見せない */
    mask-image: linear-gradient(
      to bottom,
      transparent 0,
      #000 18px,
      #000 calc(100% - 24px),
      transparent
    );
  }
  .lead {
    font-size: 0.9rem;
    line-height: 2;
    letter-spacing: 0.06em;
    padding: 14px 16px;
    border-radius: 8px;
    background: rgba(236, 229, 211, 0.06);
    border: 1px solid rgba(236, 229, 211, 0.12);
  }
  section { margin-top: 26px; }
  h3 {
    font-size: 0.72rem;
    font-weight: 700;
    letter-spacing: 0.34em;
    text-indent: 0.34em;
    color: var(--kin);
    padding-bottom: 10px;
    border-bottom: 1px solid rgba(201, 162, 39, 0.28);
  }
  ul {
    list-style: none;
    margin-top: 12px;
  }
  li {
    position: relative;
    padding-left: 16px;
    margin-top: 10px;
    font-size: 0.85rem;
    line-height: 1.95;
    letter-spacing: 0.04em;
    color: var(--washi-dim);
  }
  li::before {
    content: '';
    position: absolute;
    left: 2px;
    top: 0.82em;
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--ghost);
  }
  dl { margin-top: 14px; }
  dt {
    margin-top: 16px;
    font-size: 0.86rem;
    font-weight: 700;
    letter-spacing: 0.2em;
    color: var(--washi);
  }
  dd {
    margin-top: 4px;
    font-size: 0.85rem;
    line-height: 1.95;
    letter-spacing: 0.04em;
    color: var(--washi-dim);
  }
  b {
    color: var(--washi);
    font-weight: 700;
  }
  .note {
    margin-top: 10px;
    font-size: 0.74rem;
    line-height: 1.8;
    letter-spacing: 0.04em;
    color: rgba(236, 229, 211, 0.45);
  }
  .primary {
    display: block;
    width: 100%;
    max-width: 300px;
    margin: 32px auto 0;
    padding: 14px 22px;
    border-radius: 6px;
    background: var(--washi);
    color: var(--sumi);
    font-weight: 700;
    font-size: 0.95rem;
    letter-spacing: 0.2em;
  }
</style>
