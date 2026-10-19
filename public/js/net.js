// Multiplayer connection: one WebSocket to the server, reconnecting with backoff.
//
// Text frames are JSON events; binary frames are the compact position/lotus updates
// defined in shared/protocol.js, decoded here so the game only ever sees objects.
const PROTO = window.PROTO;
const PARTS = window.RULES.PARTS.length;

export class Net {
  constructor(onMessage, onStatus) {
    this.onMessage = onMessage; this.onStatus = onStatus;
    this.ws = null; this.backoff = 500; this.stopped = false;
    this.bytesIn = 0;                       // for the debug overlay / testing
  }

  connect() {
    if (this.stopped) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = this.ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => { this.backoff = 500; this.onStatus('open'); };
    ws.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) {
        this.bytesIn += e.data.byteLength;
        const m = PROTO.decode(e.data, PARTS);
        if (m) this.onMessage({ t: 'bin', ...m });
        return;
      }
      this.bytesIn += e.data.length;
      let m; try { m = JSON.parse(e.data); } catch { return; }
      this.onMessage(m);
    };
    ws.onclose = (e) => {
      // 4001 = kicked for being idle; 1008 = rate limited. Don't hammer the server: wait for the player.
      if (e.code === 4001 || e.code === 1008) { this.stopped = true; this.onStatus('stopped', e.code); return; }
      this.onStatus('closed');
      setTimeout(() => this.connect(), this.backoff + Math.random() * 500);
      this.backoff = Math.min(10000, this.backoff * 1.7);
    };
  }

  /** Restart after an idle kick. */
  resume() { this.stopped = false; this.backoff = 500; this.connect(); }

  get open() { return this.ws && this.ws.readyState === 1; }
  send(obj) { if (this.open) this.ws.send(JSON.stringify(obj)); }
}
