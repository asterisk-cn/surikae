<script lang="ts">
  // あそびかた：本物の盤で，台本どおりの一局を自分で打つ．
  // ここは台本セッションと盤をつなぐだけ．押す札とボタンは盤の上で光らせ，
  // 一行には手の名前と一言しか置かない．
  import Game from './Game.svelte';
  import { TutorialSession, type Guide } from '../tutorial.ts';

  let { onExit }: { onExit: () => void } = $props();

  const session = new TutorialSession();
  let guide = $state<Guide | null>(null);
  let peek = $state<{ mine: number[]; theirs: number[] } | null>(null);

  const offGuide = session.onGuide((g) => (guide = g));
  const offPeek = session.onPeek((v) => (peek = v));
  $effect(() => {
    queueMicrotask(() => session.start());
    return () => {
      offGuide();
      offPeek();
    };
  });

  // 一行は台本に書いたとおりに出す．書いていなければ手の名前だけ
  let hint = $derived.by(() =>
    guide
      ? {
          lead: guide.lead ?? guide.press ?? '',
          note: guide.note,
          who: guide.who,
        }
      : null,
  );

  // 光らせるのは自分の手番だけ．相手の番は震えがそれを言う
  let cue = $derived(
    guide && guide.who === 'me' && guide.press
      ? {
          mine: guide.mine ?? [],
          theirs: guide.theirs ?? [],
          press: guide.press,
        }
      : null,
  );
</script>

<Game
  {session}
  {onExit}
  {hint}
  {cue}
  onReady={() => session.ready()}
  {peek}
  onceOnly
  onTap={() => session.tap()}
/>
