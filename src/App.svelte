<script lang="ts">
  import Game from './lib/Game.svelte';
  import Tutorial from './lib/Tutorial.svelte';
  import {
    CpuSession,
    NetSession,
    BroadcastTransport,
    WsTransport,
    type Session,
  } from './session.ts';

  let session = $state<Session | null>(null);
  let room = $state('');
  let err = $state('');
  let connecting = $state(false);
  let devLocal = $state(false);
  let howto = $state(false); // あそびかた（台本つきの一局）

  function startCpu() {
    const s = new CpuSession();
    session = s;
    queueMicrotask(() => s.start());
  }

  async function startOnline() {
    const id = room.trim();
    if (!id) {
      err = 'あいことばをいれる';
      return;
    }
    err = '';
    connecting = true;
    try {
      const t = new WsTransport(id);
      const role = await t.role; // 先着がhost
      const s = new NetSession(role, t);
      session = s;
      queueMicrotask(() => s.start());
    } catch {
      err = 'つながらない';
    } finally {
      connecting = false;
    }
  }

  function startLocal(role: 'host' | 'join') {
    const id = room.trim() || 'yoru';
    const s = new NetSession(role, new BroadcastTransport(id));
    session = s;
    queueMicrotask(() => s.start());
  }

  function exit() {
    session = null;
  }
</script>

{#if session}
  {#key session}
    <Game {session} onExit={exit} />
  {/key}
{:else if howto}
  <Tutorial onExit={() => (howto = false)} />
{:else}
  <main class="menu">
    <h1>すりかえ</h1>

    <div class="menu-block">
      <button class="primary" onclick={startCpu}>ひとり</button>
    </div>

    <div class="menu-block">
      <input
        id="room"
        bind:value={room}
        spellcheck="false"
        placeholder="あいことば"
      />
      <button class="primary" disabled={connecting} onclick={startOnline}
        >{connecting ? 'せつぞくちゅう' : 'ふたり'}</button
      >
      {#if err}<p class="err">{err}</p>{/if}
    </div>

    <button class="howtolink" onclick={() => (howto = true)}>あそびかた</button>

    <!-- 同一ブラウザの2タブで繋ぐ検証用．本番ビルドには出さない -->
    {#if import.meta.env.DEV}
      <button class="devlink" onclick={() => (devLocal = !devLocal)}
        >けんしょう</button
      >
      {#if devLocal}
        <div class="pair narrow">
          <button class="ghostbtn" onclick={() => startLocal('host')}
            >へやをつくる</button
          >
          <button class="ghostbtn" onclick={() => startLocal('join')}
            >へやにはいる</button
          >
        </div>
      {/if}
    {/if}
  </main>
{/if}

<style>
  .menu {
    height: 100dvh;
    max-width: 480px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 28px;
    padding: 24px;
  }
  h1 {
    font-family: var(--font-display);
    font-weight: 800;
    font-size: 2.4rem;
    letter-spacing: 0.34em;
    text-indent: 0.34em;
  }
  h1 span {
    font-size: 1.1rem;
    letter-spacing: 0.35em;
    color: var(--washi-dim);
  }
  .tagline {
    font-size: 0.8rem;
    letter-spacing: 0.3em;
    color: var(--washi-dim);
    margin-top: -16px;
  }
  .menu-block {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    width: 100%;
    max-width: 300px;
  }
  .primary {
    width: 100%;
    padding: 14px 22px;
    border-radius: 6px;
    background: var(--washi);
    color: var(--sumi);
    font-weight: 700;
    font-size: 0.95rem;
    letter-spacing: 0.2em;
  }
  .ghostbtn {
    flex: 1;
    padding: 12px 10px;
    border-radius: 6px;
    border: 1px solid var(--washi-dim);
    color: var(--washi);
    font-size: 0.9rem;
    letter-spacing: 0.15em;
  }
  .pair { display: flex; gap: 10px; width: 100%; }
  .pair.narrow { max-width: 300px; }
  .room-label {
    font-size: 0.72rem;
    letter-spacing: 0.3em;
    color: var(--washi-dim);
  }
  input {
    width: 100%;
    padding: 10px 12px;
    border-radius: 6px;
    border: 1px solid rgba(236, 229, 211, 0.35);
    background: rgba(236, 229, 211, 0.06);
    color: var(--washi);
    font-family: var(--font-body);
    font-size: 1rem;
    letter-spacing: 0.2em;
    text-align: center;
  }
  input::placeholder { color: rgba(236, 229, 211, 0.3); letter-spacing: 0.1em; }
  input:focus-visible {
    outline: 2px solid var(--kin);
    outline-offset: 1px;
  }
  .note, .err {
    font-size: 0.68rem;
    letter-spacing: 0.1em;
  }
  .note { color: rgba(236, 229, 211, 0.4); }
  .err { color: var(--shu); }
  .howtolink {
    font-size: 0.78rem;
    color: var(--washi-dim);
    letter-spacing: 0.22em;
    text-indent: 0.22em;
    padding: 4px 2px;
    border-bottom: 1px solid rgba(236, 229, 211, 0.25);
  }
  .devlink {
    font-size: 0.7rem;
    color: rgba(236, 229, 211, 0.35);
    letter-spacing: 0.15em;
    border-bottom: 1px dotted rgba(236, 229, 211, 0.25);
  }
  button:disabled { opacity: 0.4; }
</style>
