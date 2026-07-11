/** Self-contained dashboard page; data loaded from /api/snapshot */
export function dashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Oren — presence</title>
  <style>
    :root {
      --bg: #0f1218;
      --panel: #171b24;
      --border: #2a3140;
      --text: #e8ecf4;
      --muted: #8b95a8;
      --accent: #7eb8ff;
      --warm: #f0b27a;
      --cold: #7aa2c8;
      --danger: #e07a7a;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "IBM Plex Sans", "SF Pro Text", system-ui, sans-serif;
      background: radial-gradient(1200px 600px at 10% -10%, #1a2233 0%, var(--bg) 55%);
      color: var(--text);
      min-height: 100vh;
    }
    header {
      padding: 1.25rem 1.5rem;
      border-bottom: 1px solid var(--border);
      display: flex;
      flex-wrap: wrap;
      gap: 1rem;
      align-items: baseline;
      justify-content: space-between;
    }
    h1 { margin: 0; font-size: 1.25rem; font-weight: 560; letter-spacing: 0.02em; }
    h1 span { color: var(--accent); font-weight: 450; }
    .meta { color: var(--muted); font-size: 0.85rem; }
    .meta b { color: var(--text); font-weight: 500; }
    .actions { display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: center; }
    main {
      display: grid;
      grid-template-columns: 1.1fr 1fr;
      gap: 1rem;
      padding: 1rem 1.5rem 2rem;
    }
    @media (max-width: 960px) { main { grid-template-columns: 1fr; } }
    section {
      background: color-mix(in srgb, var(--panel) 92%, black);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 1rem 1.1rem;
      min-height: 120px;
    }
    section h2 {
      margin: 0 0 0.75rem;
      font-size: 0.78rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--muted);
      font-weight: 600;
    }
    .span2 { grid-column: 1 / -1; }
    .pill {
      display: inline-block;
      padding: 0.15rem 0.5rem;
      border-radius: 999px;
      border: 1px solid var(--border);
      font-size: 0.75rem;
      color: var(--muted);
      margin: 0 0.25rem 0.25rem 0;
    }
    .pill.warm { border-color: #5a4030; color: var(--warm); }
    .pill.cold { border-color: #2f4054; color: var(--cold); }
    .thread { border-top: 1px solid var(--border); padding: 0.7rem 0; }
    .thread:first-of-type { border-top: 0; }
    .thread .title { font-weight: 560; }
    .thread .sum { color: var(--muted); font-size: 0.9rem; margin-top: 0.25rem; line-height: 1.45; }
    .sal { color: var(--accent); font-variant-numeric: tabular-nums; font-size: 0.85rem; }
    .log {
      max-height: 280px;
      overflow: auto;
      font-family: "IBM Plex Mono", ui-monospace, monospace;
      font-size: 0.78rem;
      line-height: 1.45;
    }
    .log div { padding: 0.2rem 0; border-bottom: 1px solid #1f2530; }
    .log .t { color: var(--muted); margin-right: 0.5rem; }
    .log .type { color: var(--accent); }
    .chat-wrap { display: flex; flex-direction: column; gap: 0.75rem; }
    .chat {
      max-height: 360px;
      overflow: auto;
      padding-right: 0.25rem;
    }
    .chat .row { margin: 0.55rem 0; }
    .chat .who { font-size: 0.75rem; color: var(--muted); margin-bottom: 0.15rem; }
    .chat .bubble {
      display: inline-block;
      max-width: 95%;
      padding: 0.55rem 0.75rem;
      border-radius: 10px;
      background: #121722;
      border: 1px solid var(--border);
      line-height: 1.45;
      white-space: pre-wrap;
    }
    .chat .oren .bubble { border-color: #2a3a55; }
    .chat .share { margin-top: 0.35rem; font-size: 0.8rem; color: var(--warm); }
    .composer {
      display: flex;
      gap: 0.5rem;
      align-items: flex-end;
      border-top: 1px solid var(--border);
      padding-top: 0.75rem;
    }
    .composer textarea {
      flex: 1;
      min-height: 52px;
      max-height: 140px;
      resize: vertical;
      background: #10141c;
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 0.6rem 0.75rem;
      font: inherit;
      line-height: 1.4;
    }
    .composer textarea:focus { outline: none; border-color: var(--accent); }
    button, .btn {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--text);
      border-radius: 8px;
      padding: 0.45rem 0.75rem;
      cursor: pointer;
      font: inherit;
      font-size: 0.9rem;
    }
    button:hover, .btn:hover { border-color: var(--accent); color: var(--accent); }
    button.primary {
      background: #1b2a40;
      border-color: #355a88;
      color: var(--accent);
    }
    button:disabled { opacity: 0.5; cursor: wait; }
    .status-line {
      min-height: 1.2em;
      font-size: 0.8rem;
      color: var(--muted);
    }
    .status-line.err { color: var(--danger); }
    .empty { color: var(--muted); font-size: 0.9rem; }
    footer {
      padding: 0 1.5rem 1.5rem;
      color: var(--muted);
      font-size: 0.8rem;
    }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>Oren <span>presence</span></h1>
      <div class="meta" id="header-meta">loading…</div>
    </div>
    <div class="actions">
      <button type="button" id="btn-tick" title="Run one experience tick">Tick</button>
      <button type="button" id="btn-refresh">Refresh</button>
    </div>
  </header>
  <main>
    <section>
      <h2>Inner threads</h2>
      <div id="threads" class="empty">—</div>
    </section>
    <section>
      <h2>Relation</h2>
      <div id="relation" class="empty">—</div>
    </section>
    <section class="span2">
      <h2>Dialogue</h2>
      <div class="chat-wrap">
        <div id="dialogue" class="chat empty">—</div>
        <div class="composer">
          <textarea id="say-input" rows="2" placeholder="对 Oren 说点什么…（Enter 发送，Shift+Enter 换行）"></textarea>
          <button type="button" class="primary" id="btn-say">Say</button>
        </div>
        <div class="status-line" id="say-status"></div>
      </div>
    </section>
    <section>
      <h2>Consciousness stream</h2>
      <div id="stream" class="log empty">—</div>
    </section>
    <section>
      <h2>Recent modes</h2>
      <div id="modes"></div>
    </section>
  </main>
  <footer id="footer"></footer>
  <script>
    let busy = false;

    async function load() {
      const res = await fetch('/api/snapshot?_=' + Date.now());
      if (!res.ok) throw new Error('snapshot ' + res.status);
      const d = await res.json();
      render(d);
      return d;
    }

    function render(d) {
      document.getElementById('header-meta').innerHTML =
        'id <b>' + esc(d.meta.oren_id.slice(0,8)) + '</b> · ticks <b>' + d.meta.tick_count +
        '</b> · last <b>' + esc(d.meta.last_tick_at || 'never') +
        '</b> · model <b>' + esc(d.meta.model) +
        '</b> · corpus <b>' + d.corpus_docs + '</b>';

      const th = d.threads.active || [];
      document.getElementById('threads').innerHTML = th.length
        ? th.map(t => (
            '<div class="thread">' +
              '<div class="title">' + esc(t.title) +
              ' <span class="sal">salience ' + Number(t.salience).toFixed(2) +
              ' · engages ' + t.contemplation_count + '</span></div>' +
              '<div class="sum">' + esc(t.summary || '') + '</div>' +
              (t.open_questions && t.open_questions.length
                ? '<div class="sum">? ' + esc(t.open_questions.join(' · ')) + '</div>'
                : '') +
            '</div>'
          )).join('')
        : '<div class="empty">No active threads yet.</div>';

      const cold = (d.relation.cold_topics || []).map(t =>
        '<span class="pill cold">' + esc(t.key) + ' ×' + t.hits + '</span>').join('');
      const warm = (d.relation.warm_topics || []).map(t =>
        '<span class="pill warm">' + esc(t.key) + ' ×' + t.hits + '</span>').join('');
      document.getElementById('relation').innerHTML =
        '<div class="sum" style="margin-bottom:0.6rem">' + esc(d.relation_field) + '</div>' +
        '<div><span class="meta">warm</span><br>' + (warm || '<span class="empty">none</span>') + '</div>' +
        '<div style="margin-top:0.6rem"><span class="meta">cold</span><br>' + (cold || '<span class="empty">none</span>') + '</div>';

      const dlg = d.dialogue || [];
      const dlgEl = document.getElementById('dialogue');
      dlgEl.innerHTML = dlg.length
        ? dlg.map(t => {
            const who = t.role === 'user' ? 'you' : 'oren';
            const share = t.share && t.share.opened
              ? '<div class="share">share: ' + esc(t.share.snippet || '') + '</div>'
              : '';
            return '<div class="row ' + who + '"><div class="who">' + who +
              ' · ' + esc((t.ts || '').replace('T',' ').slice(0,19)) +
              '</div><div class="bubble">' + esc(t.text || '') + '</div>' + share + '</div>';
          }).join('')
        : '<div class="empty">No dialogue yet. Type below.</div>';
      dlgEl.scrollTop = dlgEl.scrollHeight;

      const st = d.stream || [];
      document.getElementById('stream').innerHTML = st.length
        ? st.slice().reverse().map(e =>
            '<div><span class="t">' + esc((e.ts||'').replace('T',' ').slice(11,19)) +
            '</span><span class="type">' + esc(e.type) + '</span></div>'
          ).join('')
        : '<div class="empty">empty stream</div>';

      document.getElementById('modes').innerHTML =
        (d.modes_recent || []).map(m => '<span class="pill">' + esc(m) + '</span>').join('') ||
        '<span class="empty">no modes yet</span>';

      document.getElementById('footer').textContent =
        'localhost only · generated ' + d.generated_at + ' · home ' + d.home;
    }

    function esc(s) {
      return String(s ?? '').replace(/[&<>"']/g, c => ({
        '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
      }[c]));
    }

    function setBusy(v, msg) {
      busy = v;
      document.getElementById('btn-say').disabled = v;
      document.getElementById('btn-tick').disabled = v;
      document.getElementById('say-input').disabled = v;
      const st = document.getElementById('say-status');
      st.className = 'status-line';
      st.textContent = msg || '';
    }

    function setErr(msg) {
      const st = document.getElementById('say-status');
      st.className = 'status-line err';
      st.textContent = msg;
    }

    async function say() {
      if (busy) return;
      const input = document.getElementById('say-input');
      const text = input.value.trim();
      if (!text) return;
      setBusy(true, 'Oren is thinking…');
      try {
        const res = await fetch('/api/say', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || ('say failed ' + res.status));
        input.value = '';
        await load();
        setBusy(false, data.share && data.share.opened ? 'shared a thread slice' : 'ok');
      } catch (e) {
        setBusy(false);
        setErr(String(e.message || e));
      }
    }

    async function tickOnce() {
      if (busy) return;
      setBusy(true, 'Running tick…');
      try {
        const res = await fetch('/api/tick', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || data.message || ('tick failed ' + res.status));
        await load();
        setBusy(false, data.message || ('tick ' + (data.mode || 'ok')));
      } catch (e) {
        setBusy(false);
        setErr(String(e.message || e));
      }
    }

    document.getElementById('btn-refresh').onclick = () => load().catch(e => setErr(String(e)));
    document.getElementById('btn-say').onclick = say;
    document.getElementById('btn-tick').onclick = tickOnce;
    document.getElementById('say-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        say();
      }
    });

    load().catch(err => {
      document.getElementById('header-meta').textContent = String(err);
    });
    setInterval(() => { if (!busy) load().catch(() => {}); }, 15000);
  </script>
</body>
</html>`;
}
