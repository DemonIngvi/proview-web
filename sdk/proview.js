// ProView browser SDK.
//
// Usage:
//   <div data-proview-placement="home_top"></div>
//   <script src="/config.js"></script>
//   <script type="module" src="/sdk/proview.js"></script>
//
// window.PROVIEW_CONFIG = { bannerEndpoint: '', collectorEndpoint: '', debug: false }
// Empty endpoints mean "same origin" (the demo nginx proxies /v1/*).

import { ImpressionTracker } from './tracker.js';
import { EventQueue } from './queue.js';

const HEARTBEAT_MS = 5000;
const TICK_MS = 250;

function visitorId() {
  const key = 'proview_vid';
  try {
    let id = localStorage.getItem(key);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(key, id);
    }
    return id;
  } catch {
    return ''; // storage blocked: uniques are not counted for this visitor
  }
}

function makeTransport(url, debug) {
  return async (body, { beacon }) => {
    const json = JSON.stringify(body);
    if (debug) debug(body, beacon);
    // text/plain avoids a CORS preflight; the collector accepts it.
    if (beacon && navigator.sendBeacon) {
      navigator.sendBeacon(url, new Blob([json], { type: 'text/plain;charset=UTF-8' }));
      return 202;
    }
    const res = await fetch(url, {
      method: 'POST', body: json, keepalive: true, credentials: 'omit',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
    });
    return res.status;
  };
}

function render(slot, data) {
  const { banner } = data;
  const a = document.createElement('a');
  a.href = banner.click_url;
  a.target = '_blank';
  a.rel = 'noopener sponsored';
  a.className = 'proview-banner';
  a.dataset.bannerId = String(banner.id);
  const img = document.createElement('img');
  img.src = banner.image_url;
  img.alt = banner.alt || 'Реклама';
  img.width = banner.width;
  img.height = banner.height;
  img.decoding = 'async';
  a.append(img);
  slot.replaceChildren(a);
  return { a, img };
}

async function mountSlot(slot, cfg, queue) {
  const placement = slot.dataset.proviewPlacement;
  const res = await fetch(`${cfg.bannerEndpoint}/v1/banner?placement=${encodeURIComponent(placement)}`, { credentials: 'omit' });
  if (res.status === 204) { slot.dataset.proviewState = 'empty'; return null; }
  if (!res.ok) throw new Error(`banner ${placement}: HTTP ${res.status}`);
  const data = await res.json();
  const { a, img } = render(slot, data);
  slot.dataset.proviewState = 'rendered';

  const tracker = new ImpressionTracker({ token: data.token, emit: (t, ev) => queue.push(t, ev) });
  img.addEventListener('load', () => tracker.onRendered(), { once: true });
  if (img.complete && img.naturalWidth) tracker.onRendered();

  const io = new IntersectionObserver((entries) => {
    for (const e of entries) tracker.onIntersection(e.intersectionRatio);
  }, { threshold: [0, 0.25, 0.5, 0.75, 1] });
  io.observe(a);
  a.addEventListener('pointerenter', () => tracker.onHoverStart());
  a.addEventListener('pointerleave', () => tracker.onHoverEnd());
  a.addEventListener('click', () => { tracker.onClick(); queue.flush({ beacon: true }); });
  return tracker;
}

export async function init(cfg = window.PROVIEW_CONFIG || {}) {
  const config = { bannerEndpoint: '', collectorEndpoint: '', ...cfg };
  const debug = config.debug ? (body, beacon) => window.dispatchEvent(new CustomEvent('proview:send', { detail: { body, beacon } })) : null;
  const queue = new EventQueue({
    send: makeTransport(`${config.collectorEndpoint}/v1/events`, debug),
    visitorId: visitorId(),
    pageUrl: location.href,
  });
  const slots = [...document.querySelectorAll('[data-proview-placement]')];
  const results = await Promise.allSettled(slots.map((s) => mountSlot(s, config, queue)));
  const trackers = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled' && r.value) trackers.push(r.value);
    if (r.status === 'rejected') { slots[i].dataset.proviewState = 'error'; console.warn('[proview]', r.reason); }
  });

  const visible = () => document.visibilityState === 'visible';
  document.addEventListener('visibilitychange', () => {
    for (const t of trackers) t.onPageVisibility(visible());
    if (!visible()) {
      for (const t of trackers) t.flushActive();
      queue.flush({ beacon: true });
    }
  });
  window.addEventListener('pagehide', () => {
    for (const t of trackers) t.flushActive();
    queue.flush({ beacon: true });
  });
  setInterval(() => { for (const t of trackers) t.tick(); }, TICK_MS);
  setInterval(() => { for (const t of trackers) t.flushActive(); }, HEARTBEAT_MS);
  return { trackers, queue };
}

if (!window.PROVIEW_CONFIG?.manual) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => init());
  else init();
}
