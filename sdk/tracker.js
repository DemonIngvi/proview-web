// ImpressionTracker turns raw browser signals for one rendered banner into
// ProView events. It has no DOM dependencies so it can be unit-tested with a
// fake clock; proview.js feeds it IntersectionObserver / visibility / pointer
// signals.
//
// Event semantics (see proview-docs, "Metric definitions"):
//   impression  - creative rendered (image loaded)
//   viewable    - >= 50% of the creative in viewport for >= 1 s continuously (IAB/MRC display)
//   hover       - pointer left the creative; duration_ms = time the pointer was over it
//   click       - user clicked the creative
//   active_time - delta of time the creative was >= 50% visible while the tab was visible

export const VIEWABLE_RATIO = 0.5;
export const VIEWABLE_MS = 1000;
export const MIN_HOVER_MS = 100;
export const MAX_DURATION_MS = 3600 * 1000;

export class ImpressionTracker {
  /**
   * @param {{token: string, now?: () => number, emit: (token: string, ev: object) => void}} opts
   */
  constructor({ token, now = () => Date.now(), emit }) {
    this.token = token;
    this.now = now;
    this.emit = emit;
    this.seq = 0;
    this.rendered = false;
    this.viewableSent = false;
    this.inView = false;      // >= VIEWABLE_RATIO visible
    this.pageVisible = true;
    this.inViewSince = null;  // start of current continuous in-view period
    this.activeSince = null;  // start of current active (inView && pageVisible) period
    this.activeAccum = 0;     // active ms not yet reported
    this.hoverSince = null;
  }

  _send(type, durationMs = 0) {
    const ev = { type, ts: this.now(), seq: this.seq++ };
    if (durationMs > 0) ev.duration_ms = Math.min(Math.round(durationMs), MAX_DURATION_MS);
    this.emit(this.token, ev);
  }

  _active() {
    return this.rendered && this.inView && this.pageVisible;
  }

  _updateActive() {
    const t = this.now();
    if (this._active()) {
      if (this.activeSince === null) this.activeSince = t;
    } else if (this.activeSince !== null) {
      this.activeAccum += t - this.activeSince;
      this.activeSince = null;
    }
  }

  onRendered() {
    if (this.rendered) return;
    this.rendered = true;
    this._send('impression');
    this._updateActive();
    if (this.inView) this.inViewSince = this.now();
  }

  /** @param {number} ratio intersection ratio 0..1 */
  onIntersection(ratio) {
    const was = this.inView;
    this.inView = ratio >= VIEWABLE_RATIO;
    if (this.inView && !was) this.inViewSince = this.pageVisible ? this.now() : null;
    if (!this.inView) this.inViewSince = null;
    this._updateActive();
    this.tick();
  }

  /** @param {boolean} visible document.visibilityState === 'visible' */
  onPageVisibility(visible) {
    this.pageVisible = visible;
    if (!visible) this.inViewSince = null;
    else if (this.inView) this.inViewSince = this.now();
    if (!visible && this.hoverSince !== null) this.onHoverEnd();
    this._updateActive();
  }

  onHoverStart() {
    if (this.hoverSince === null) this.hoverSince = this.now();
  }

  onHoverEnd() {
    if (this.hoverSince === null) return;
    const d = this.now() - this.hoverSince;
    this.hoverSince = null;
    if (this.rendered && d >= MIN_HOVER_MS) this._send('hover', d);
  }

  onClick() {
    if (!this.rendered) return;
    if (this.hoverSince !== null) this.onHoverEnd();
    this._send('click');
  }

  /** Called periodically (e.g. every 250 ms) to detect the viewable threshold. */
  tick() {
    if (!this.viewableSent && this.rendered && this.inViewSince !== null && this.pageVisible &&
        this.now() - this.inViewSince >= VIEWABLE_MS) {
      this.viewableSent = true;
      this._send('viewable');
    }
  }

  /** Reports accumulated active time (heartbeat / page hide). */
  flushActive() {
    const t = this.now();
    let total = this.activeAccum;
    if (this.activeSince !== null) {
      total += t - this.activeSince;
      this.activeSince = t;
    }
    this.activeAccum = 0;
    if (total >= 1) this._send('active_time', total);
  }
}
