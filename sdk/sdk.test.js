import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ImpressionTracker, VIEWABLE_MS, MIN_HOVER_MS, MAX_DURATION_MS } from './tracker.js';
import { EventQueue, MAX_ITEMS, MAX_EVENTS_PER_ITEM, MAX_QUEUED } from './queue.js';

function setup() {
  let t = 1_000_000;
  const events = [];
  const tr = new ImpressionTracker({ token: 'tok', now: () => t, emit: (tok, ev) => events.push({ tok, ...ev }) });
  return { tr, events, advance: (ms) => { t += ms; }, types: () => events.map((e) => e.type) };
}

test('impression is sent once with seq 0', () => {
  const { tr, events } = setup();
  tr.onRendered();
  tr.onRendered();
  assert.equal(events.length, 1);
  assert.deepEqual([events[0].type, events[0].seq, events[0].tok], ['impression', 0, 'tok']);
});

test('viewable needs 50% for 1s continuously', () => {
  const { tr, advance, types } = setup();
  tr.onRendered();
  tr.onIntersection(0.6);
  advance(VIEWABLE_MS - 1);
  tr.tick();
  assert.deepEqual(types(), ['impression']);
  tr.onIntersection(0.3); // interrupted
  tr.onIntersection(0.7);
  advance(VIEWABLE_MS - 1);
  tr.tick();
  assert.deepEqual(types(), ['impression']);
  advance(1);
  tr.tick();
  tr.tick();
  assert.deepEqual(types(), ['impression', 'viewable'], 'viewable exactly once');
});

test('viewable does not count while the tab is hidden', () => {
  const { tr, advance, types } = setup();
  tr.onRendered();
  tr.onIntersection(1);
  tr.onPageVisibility(false);
  advance(5000);
  tr.tick();
  assert.deepEqual(types(), ['impression']);
  tr.onPageVisibility(true);
  advance(VIEWABLE_MS);
  tr.tick();
  assert.deepEqual(types(), ['impression', 'viewable']);
});

test('active time accumulates only while in view and tab visible', () => {
  const { tr, advance, events } = setup();
  tr.onRendered();
  tr.onIntersection(1);
  advance(3000);
  tr.onPageVisibility(false);
  advance(10000);           // hidden: not counted
  tr.onPageVisibility(true);
  advance(2000);
  tr.onIntersection(0.1);   // scrolled away: not counted
  advance(4000);
  tr.flushActive();
  const active = events.filter((e) => e.type === 'active_time');
  assert.equal(active.length, 1);
  assert.equal(active[0].duration_ms, 5000);
  tr.flushActive();
  assert.equal(events.filter((e) => e.type === 'active_time').length, 1, 'no empty heartbeat');
});

test('active heartbeat reports deltas', () => {
  const { tr, advance, events } = setup();
  tr.onRendered();
  tr.onIntersection(1);
  advance(5000);
  tr.flushActive();
  advance(5000);
  tr.flushActive();
  assert.deepEqual(events.filter((e) => e.type === 'active_time').map((e) => e.duration_ms), [5000, 5000]);
});

test('hover duration, minimum and cap', () => {
  const { tr, advance, events } = setup();
  tr.onRendered();
  tr.onHoverStart();
  advance(MIN_HOVER_MS - 1);
  tr.onHoverEnd();
  assert.equal(events.filter((e) => e.type === 'hover').length, 0, 'too short');
  tr.onHoverStart();
  advance(750);
  tr.onHoverEnd();
  tr.onHoverStart();
  advance(MAX_DURATION_MS * 2);
  tr.onHoverEnd();
  assert.deepEqual(events.filter((e) => e.type === 'hover').map((e) => e.duration_ms), [750, MAX_DURATION_MS]);
});

test('click closes an open hover and seq increases', () => {
  const { tr, advance, events } = setup();
  tr.onClick(); // before render: ignored
  tr.onRendered();
  tr.onHoverStart();
  advance(400);
  tr.onClick();
  assert.deepEqual(events.map((e) => [e.type, e.seq]), [['impression', 0], ['hover', 1], ['click', 2]]);
});

function fakeTimers() {
  const timers = [];
  return {
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length - 1; },
    clearTimer: (id) => { if (timers[id]) timers[id].fn = null; },
    run: async () => { const list = timers.splice(0); for (const t of list) if (t.fn) await t.fn(); },
    timers,
  };
}

test('queue groups events by token and flushes on size', async () => {
  const sent = [];
  const q = new EventQueue({ send: async (b) => { sent.push(b); return 202; }, visitorId: 'v', pageUrl: 'https://x', maxBatch: 3, ...fakeTimers() });
  q.push('a', { type: 'impression', seq: 0 });
  q.push('b', { type: 'impression', seq: 0 });
  q.push('a', { type: 'click', seq: 1 });
  await new Promise((r) => setImmediate(r));
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].items.map((i) => [i.token, i.events.length]), [['a', 2], ['b', 1]]);
  assert.equal(sent[0].visitor_id, 'v');
  assert.equal(q.pending.length, 0);
});

test('queue retries on 503 keeping order and seq, drops on 400', async () => {
  const statuses = [503, 202];
  const sent = [];
  const timers = fakeTimers();
  const q = new EventQueue({ send: async (b) => { sent.push(b); return statuses.shift(); }, visitorId: 'v', pageUrl: 'p', ...timers });
  q.push('a', { type: 'impression', seq: 0 });
  await q.flush();
  assert.equal(q.pending.length, 1, 'kept for retry');
  assert.equal(timers.timers.at(-1).ms, 1000, 'backoff scheduled');
  await q.flush();
  assert.equal(q.pending.length, 0);
  assert.deepEqual(sent[1].items[0].events[0], { type: 'impression', seq: 0 });

  const q2 = new EventQueue({ send: async () => 400, visitorId: 'v', pageUrl: 'p', ...fakeTimers() });
  q2.push('a', { type: 'bogus', seq: 0 });
  await q2.flush();
  assert.equal(q2.pending.length, 0, 'client errors are not retried');
});

test('queue network error is retried; beacon empties optimistically', async () => {
  const q = new EventQueue({ send: async (_b, { beacon }) => { if (!beacon) throw new Error('offline'); return 202; }, visitorId: 'v', pageUrl: 'p', ...fakeTimers() });
  q.push('a', { type: 'impression', seq: 0 });
  await q.flush();
  assert.equal(q.pending.length, 1);
  await q.flush({ beacon: true });
  assert.equal(q.pending.length, 0);
});

test('request body respects collector limits; queue is bounded', () => {
  const entries = [];
  for (let i = 0; i < MAX_ITEMS + 5; i++) entries.push({ token: `t${i}`, event: { seq: 0 } });
  for (let i = 0; i < MAX_EVENTS_PER_ITEM + 5; i++) entries.push({ token: 't0', event: { seq: i + 1 } });
  const { body, taken } = EventQueue.buildBody(entries, 'v', 'p');
  assert.equal(body.items.length, MAX_ITEMS);
  assert.equal(body.items[0].events.length, MAX_EVENTS_PER_ITEM);
  assert.equal(taken.length, MAX_ITEMS + MAX_EVENTS_PER_ITEM - 1);

  const q = new EventQueue({ send: async () => 202, visitorId: 'v', pageUrl: 'p', maxBatch: 1e9, ...fakeTimers() });
  for (let i = 0; i < MAX_QUEUED + 10; i++) q.push('a', { seq: i });
  assert.equal(q.pending.length, MAX_QUEUED);
  assert.equal(q.dropped, 10);
});
