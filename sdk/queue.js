// EventQueue batches events per impression token and delivers them to the
// collector. Delivery is at-least-once: a 503/429/network failure keeps the
// events (same seq, so the same event_id) for a retry with backoff.

export const MAX_ITEMS = 20;          // collector limit per request
export const MAX_EVENTS_PER_ITEM = 50;
export const MAX_QUEUED = 500;        // drop oldest beyond this to bound memory

export class EventQueue {
  /**
   * @param {{
   *   send: (body: object, opts: {beacon: boolean}) => Promise<number>,
   *   visitorId: string, pageUrl: string,
   *   flushMs?: number, maxBatch?: number,
   *   setTimer?: (fn: () => void, ms: number) => any, clearTimer?: (id: any) => void,
   * }} opts
   */
  constructor({ send, visitorId, pageUrl, flushMs = 2000, maxBatch = 30, setTimer = setTimeout, clearTimer = clearTimeout }) {
    this.send = send;
    this.visitorId = visitorId;
    this.pageUrl = pageUrl;
    this.flushMs = flushMs;
    this.maxBatch = maxBatch;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.pending = [];        // [{token, event}]
    this.timer = null;
    this.inflight = false;
    this.backoffMs = 1000;
    this.dropped = 0;
  }

  push(token, event) {
    this.pending.push({ token, event });
    if (this.pending.length > MAX_QUEUED) {
      this.dropped += this.pending.length - MAX_QUEUED;
      this.pending.splice(0, this.pending.length - MAX_QUEUED);
    }
    if (this.pending.length >= this.maxBatch) this.flush();
    else this._schedule(this.flushMs);
  }

  _schedule(ms) {
    if (this.timer !== null) return;
    this.timer = this.setTimer(() => { this.timer = null; this.flush(); }, ms);
  }

  /** Builds the request body from up to MAX_ITEMS tokens. */
  static buildBody(entries, visitorId, pageUrl) {
    const items = [];
    const byToken = new Map();
    const taken = [];
    for (const e of entries) {
      let item = byToken.get(e.token);
      if (!item) {
        if (items.length >= MAX_ITEMS) continue;
        item = { token: e.token, events: [] };
        byToken.set(e.token, item);
        items.push(item);
      }
      if (item.events.length >= MAX_EVENTS_PER_ITEM) continue;
      item.events.push(e.event);
      taken.push(e);
    }
    return { body: { visitor_id: visitorId, page_url: pageUrl, items }, taken };
  }

  /**
   * Sends pending events. With beacon=true (page hide) the transport must use
   * navigator.sendBeacon, which cannot report the status: events are dropped
   * from the queue optimistically.
   */
  async flush({ beacon = false } = {}) {
    if (this.timer !== null) { this.clearTimer(this.timer); this.timer = null; }
    if (!this.pending.length || (this.inflight && !beacon)) return;
    const { body, taken } = EventQueue.buildBody(this.pending, this.visitorId, this.pageUrl);
    const takenSet = new Set(taken);
    this.pending = this.pending.filter((e) => !takenSet.has(e));
    if (beacon) {
      await this.send(body, { beacon: true });
      return;
    }
    this.inflight = true;
    let status = 0;
    try {
      status = await this.send(body, { beacon: false });
    } catch {
      status = 0;
    }
    this.inflight = false;
    if (status === 0 || status === 429 || status >= 500) {
      // Retry later: put the events back in front, keep their seq.
      this.pending = taken.concat(this.pending);
      this._schedule(this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, 30000);
      return;
    }
    this.backoffMs = 1000; // 2xx, or 4xx (invalid: retrying would not help)
    if (this.pending.length) this._schedule(0);
  }
}
