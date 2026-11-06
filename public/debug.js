// Shows outgoing SDK batches when the page is opened with ?debug=1.
if (new URLSearchParams(location.search).has('debug')) {
  const out = document.getElementById('debug');
  out.hidden = false;
  window.addEventListener('proview:send', (e) => {
    const { body, beacon } = e.detail;
    const lines = body.items.flatMap((it) => it.events.map((ev) =>
      `${new Date(ev.ts).toLocaleTimeString('ru-RU')}  ${ev.type.padEnd(12)} seq=${ev.seq}${ev.duration_ms ? ` ${ev.duration_ms} мс` : ''}${beacon ? '  (beacon)' : ''}`));
    out.textContent = (lines.join('\n') + '\n' + out.textContent).slice(0, 4000);
  });
}
