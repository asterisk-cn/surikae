// 部屋ごとに1つのDurable Object．
// 役割は3つだけ：役の割当（先着=host）／メッセージの中継／ログ保持（再接続用）．
// ゲームの判定は一切持たない．

import { DurableObject } from 'cloudflare:workers';

type Env = {
  ROOM: DurableObjectNamespace;
};

export class Room extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('WebSocket接続が必要', { status: 426 });
    }
    const existing = this.ctx.getWebSockets().length;
    if (existing >= 2) {
      return new Response('満室', { status: 409 });
    }
    if (existing === 0) {
      // 新しい対局：前の部屋の残骸を消す
      await this.ctx.storage.deleteAll();
    }

    const pair = new WebSocketPair();
    const role = existing === 0 ? 'host' : 'join';
    // Hibernation API：待ち時間に課金が発生しない
    this.ctx.acceptWebSocket(pair[1], [role]);
    pair[1].send(JSON.stringify({ t: 'role', role }));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== 'string' || message.length > 4096) return;
    // 再接続時の再送用にログを積む（ステップ5で配信に使う）
    const n = ((await this.ctx.storage.get<number>('n')) ?? 0) as number;
    await this.ctx.storage.put({
      [`log:${String(n).padStart(5, '0')}`]: message,
      n: n + 1,
    });
    for (const peer of this.ctx.getWebSockets()) {
      if (peer !== ws) peer.send(message);
    }
  }

  async webSocketClose(ws: WebSocket) {
    const remain = this.ctx.getWebSockets().filter((p) => p !== ws);
    if (remain.length === 0) {
      await this.ctx.storage.deleteAll();
    } else {
      for (const peer of remain) {
        peer.send(JSON.stringify({ t: 'peer-left' }));
      }
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const m = url.pathname.match(/^\/ws\/([\w\-ぁ-んァ-ヶ一-龠]{1,64})$/u);
    if (m) {
      const id = env.ROOM.idFromName(m[1]);
      return env.ROOM.get(id).fetch(request);
    }
    return new Response('not found', { status: 404 });
  },
};
