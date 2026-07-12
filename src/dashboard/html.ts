/** Self-contained dashboard page (Chinese UI); data from /api/snapshot */
export function dashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Oren — 在场</title>
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
      --mono: #c5d0e0;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei",
        "SF Pro Text", system-ui, sans-serif;
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
      font-size: 0.85rem;
      letter-spacing: 0.04em;
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
    .thread, .mono-card, .corp-row { border-top: 1px solid var(--border); padding: 0.7rem 0; }
    .thread:first-of-type, .mono-card:first-of-type, .corp-row:first-of-type { border-top: 0; }
    .thread .title, .mono-card .title { font-weight: 560; }
    .thread .sum, .mono-card .body { color: var(--muted); font-size: 0.9rem; margin-top: 0.25rem; line-height: 1.5; }
    .mono-card .body { color: var(--mono); white-space: pre-wrap; }
    .sal { color: var(--accent); font-variant-numeric: tabular-nums; font-size: 0.85rem; }
    .log {
      max-height: 240px;
      overflow: auto;
      font-family: "SF Mono", ui-monospace, monospace;
      font-size: 0.78rem;
      line-height: 1.45;
    }
    .log div { padding: 0.2rem 0; border-bottom: 1px solid #1f2530; }
    .log .t { color: var(--muted); margin-right: 0.5rem; }
    .log .type { color: var(--accent); }
    .scroll { max-height: 320px; overflow: auto; }
    .chat-wrap { display: flex; flex-direction: column; gap: 0.75rem; }
    .chat { max-height: 300px; overflow: auto; padding-right: 0.25rem; }
    .chat .row { margin: 0.55rem 0; }
    .chat .who { font-size: 0.75rem; color: var(--muted); margin-bottom: 0.15rem; }
    .chat .bubble {
      display: inline-block; max-width: 95%; padding: 0.55rem 0.75rem;
      border-radius: 10px; background: #121722; border: 1px solid var(--border);
      line-height: 1.45; white-space: pre-wrap;
    }
    .chat .oren .bubble { border-color: #2a3a55; }
    .chat .share { margin-top: 0.35rem; font-size: 0.8rem; color: var(--warm); }
    .chat .share .kind {
      display: inline-block;
      margin-right: 0.35rem;
      padding: 0.05rem 0.4rem;
      border-radius: 999px;
      font-size: 0.72rem;
      border: 1px solid color-mix(in srgb, var(--warm) 45%, transparent);
      color: var(--warm);
    }
    .composer, .corpus-form {
      display: flex; gap: 0.5rem; align-items: flex-end;
      border-top: 1px solid var(--border); padding-top: 0.75rem;
    }
    .corpus-form { flex-direction: column; align-items: stretch; }
    .corpus-form .row { display: flex; gap: 0.5rem; }
    textarea, input[type=text], select {
      background: #10141c; color: var(--text); border: 1px solid var(--border);
      border-radius: 10px; padding: 0.6rem 0.75rem; font: inherit; line-height: 1.4;
    }
    textarea { flex: 1; min-height: 52px; max-height: 140px; resize: vertical; }
    input[type=text] { width: 100%; }
    textarea:focus, input[type=text]:focus, select:focus { outline: none; border-color: var(--accent); }
    button {
      background: transparent; border: 1px solid var(--border); color: var(--text);
      border-radius: 8px; padding: 0.45rem 0.75rem; cursor: pointer; font: inherit; font-size: 0.9rem;
    }
    button:hover { border-color: var(--accent); color: var(--accent); }
    button.primary { background: #1b2a40; border-color: #355a88; color: var(--accent); }
    button:disabled { opacity: 0.5; cursor: wait; }
    .status-line { min-height: 1.2em; font-size: 0.8rem; color: var(--muted); }
    .status-line.err { color: var(--danger); }
    .empty { color: var(--muted); font-size: 0.9rem; }
    footer { padding: 0 1.5rem 1.5rem; color: var(--muted); font-size: 0.8rem; }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>Oren <span>在场</span></h1>
      <div class="meta" id="header-meta">加载中…</div>
    </div>
    <div class="actions">
      <button type="button" id="btn-tick" title="独处调度：规划或执行下一项">心跳一轮</button>
      <button type="button" id="btn-plan" title="制定/重写独处计划表">规划</button>
      <button type="button" id="btn-act" title="执行计划下一项">执行下一项</button>
      <button type="button" id="btn-contemplate" title="强制沉思（绕过计划）">沉思</button>
      <button type="button" id="btn-organize" title="强制整理（绕过计划）">整理</button>
      <button type="button" id="btn-refresh">刷新</button>
    </div>
  </header>
  <main>
    <section>
      <h2>内心线索</h2>
      <div id="threads" class="scroll empty">—</div>
    </section>
    <section>
      <h2>意志 · Will</h2>
      <div id="will" class="empty">—</div>
    </section>
    <section>
      <h2>独自计划</h2>
      <div id="agenda-note" class="empty" style="margin-bottom:0.5rem;font-size:0.85rem;">—</div>
      <div id="agenda" class="scroll empty">—</div>
    </section>
    <section>
      <h2>品味 · 关系</h2>
      <div id="taste" class="empty" style="margin-bottom:0.75rem">—</div>
      <div id="relation" class="empty">—</div>
    </section>
    <section class="span2">
      <h2>近期沉思
        <select id="mono-filter" style="margin-left:0.75rem;font-size:0.8rem;">
          <option value="">全部线索</option>
        </select>
      </h2>
      <div id="monologues" class="scroll empty">—</div>
    </section>
    <section class="span2">
      <h2>对话</h2>
      <div class="chat-wrap">
        <div id="dialogue" class="chat empty">—</div>
        <div class="composer">
          <textarea id="say-input" rows="2" placeholder="对 Oren 说点什么…（Enter 发送，Shift+Enter 换行）"></textarea>
          <button type="button" class="primary" id="btn-say">发送</button>
        </div>
        <div class="status-line" id="say-status"></div>
      </div>
    </section>
    <section>
      <h2>语料库</h2>
      <div id="corpus" class="scroll empty">—</div>
      <div class="corpus-form">
        <input type="text" id="corp-name" placeholder="文件名.md" />
        <textarea id="corp-content" rows="4" placeholder="粘贴希望 Oren 阅读的文本…"></textarea>
        <div class="row">
          <button type="button" class="primary" id="btn-corp">添加到语料</button>
        </div>
        <div class="status-line" id="corp-status"></div>
      </div>
    </section>
    <section>
      <h2>意识流</h2>
      <div id="stream" class="log empty">—</div>
      <h2 style="margin-top:1rem">近期模式</h2>
      <div id="modes"></div>
    </section>
  </main>
  <footer id="footer"></footer>
  <script>
    let busy = false;
    let lastSnap = null;
    let monoFilter = '';
    let previewOpen = null;

    const MODE_LABEL = {
      idle: '发呆',
      organize: '整理',
      contemplate: '沉思',
      plan: '规划',
      think_without_new_reading: '纯想（未新读）',
      read: '阅读',
      think: '所思',
      seek: '查询',
      pending: '待做',
      active: '进行中',
      done: '完成',
      blocked: '受阻',
      skipped: '跳过',
    };
    const EVENT_LABEL = {
      tick_started: '心跳开始',
      mode_chosen: '选择模式',
      corpus_read: '阅读语料',
      thought_written: '写下沉思',
      thread_created: '新建线索',
      thread_updated: '更新线索',
      presence_blank: '空白在场',
      tick_finished: '心跳结束',
      tick_failed: '心跳失败',
      warn_empty_corpus: '语料为空',
      user_visit: '用户到访',
      user_message: '用户发言',
      oren_reply: 'Oren 回复',
      inner_share: '内心分享',
    };

    function modeLabel(m) { return MODE_LABEL[m] || m; }
    function eventLabel(t) { return EVENT_LABEL[t] || t; }

    async function load() {
      const res = await fetch('/api/snapshot?_=' + Date.now());
      if (!res.ok) throw new Error('加载快照失败 ' + res.status);
      lastSnap = await res.json();
      render(lastSnap);
    }

    function render(d) {
      const product = d.product || { version: '0.2.0', tagline: '' };
      document.querySelector('h1').innerHTML = 'Oren <span>v' + esc(product.version) + '</span>';
      document.getElementById('header-meta').innerHTML =
        esc(product.tagline || '持续在场') +
        ' · 编号 <b>' + esc(d.meta.oren_id.slice(0,8)) + '</b> · 心跳 <b>' + d.meta.tick_count +
        '</b> 次 · 上次 <b>' + esc(fmtTime(d.meta.last_tick_at) || '从未') +
        '</b> · 模型 <b>' + esc(d.meta.model) +
        '</b> · 语料 <b>' + d.corpus_docs + '</b> 篇';

      const will = d.will;
      const postureZh = { engage: '主动', soft_check: '轻探', quiet: '安静', care: '关心' };
      const driveZh = { low: '低', mid: '中', high: '高' };
      document.getElementById('will').innerHTML = will
        ? '<div class="title">' + esc(will.focus_summary || '（无焦点）') + '</div>' +
          '<div class="sum" style="margin-top:0.4rem">' +
          '<span class="pill">' + esc(postureZh[will.posture] || will.posture) + '</span>' +
          '<span class="pill">分享 ' + esc(driveZh[will.share_drive] || will.share_drive) + '</span>' +
          '<span class="pill">提问 ' + esc(driveZh[will.ask_drive] || will.ask_drive) + '</span>' +
          '</div>' +
          ((will.queue_titles && will.queue_titles.length)
            ? '<div class="meta" style="margin-top:0.55rem">队列</div>' +
              will.queue_titles.slice(0, 6).map((t, i) =>
                '<div class="sum">' + (i + 1) + '. ' + esc(t) + '</div>'
              ).join('')
            : '<div class="meta" style="margin-top:0.55rem">队列为空</div>')
        : '<div class="empty">尚无意志状态 — 下一心跳会合成。</div>';

      const ag = d.agenda;
      const kindZh = { read: '阅读', think: '所思', organize: '整理', seek: '查询', idle: '发呆', say: '主动聊' };
      const stZh = { pending: '待做', active: '进行中', done: '完成', blocked: '受阻', skipped: '跳过' };
      document.getElementById('agenda-note').textContent =
        ag && ag.planning_note ? ag.planning_note : (ag ? '（尚无规划说明）' : '尚无计划表 — 点「规划」或「心跳」');
      const queueHtml = ag && ag.items && ag.items.length
        ? ag.items.map((it, idx) => (
            '<div class="thread"><div class="title">' + (idx+1) + '. ' +
            '<span class="pill">' + esc(kindZh[it.kind] || it.kind) + '</span> ' +
            esc(it.title) +
            ' <span class="sal">' + esc(stZh[it.status] || it.status) +
            (it.blocked_reason ? ' · ' + esc(it.blocked_reason) : '') +
            '</span></div></div>'
          )).join('')
        : '<div class="empty">待办队列为空。</div>';
      const def = (ag && ag.deferred) || [];
      const defHtml = def.length
        ? '<div class="meta" style="margin:0.75rem 0 0.35rem">未到期 · 日历关心</div>' +
          def.map(it => (
            '<div class="thread"><div class="title"><span class="pill warm">日历</span> ' +
            esc(it.title) +
            '</div><div class="sum">' +
            esc((it.due_start||'').slice(0,10)) + ' ～ ' + esc((it.due_end||'').slice(0,10)) +
            (it.source_text ? ' · 原话「' + esc(it.source_text.slice(0,40)) + '」' : '') +
            '</div></div>'
          )).join('')
        : '<div class="meta" style="margin-top:0.75rem">未到期日历关心：无</div>';
      document.getElementById('agenda').innerHTML =
        queueHtml + defHtml +
        (ag ? '<div class="meta" style="margin-top:0.5rem">自上次规划已执行 ' + (ag.actions_since_plan||0) + ' 项</div>' : '');

      const taste = d.taste || { values: [], aesthetics: [] };
      document.getElementById('taste').innerHTML =
        '<div class="meta" style="margin-bottom:0.35rem">价值</div>' +
        (taste.values || []).map(v => '<span class="pill">' + esc(v.statement) + '</span>').join('') +
        '<div class="meta" style="margin:0.5rem 0 0.35rem">审美</div>' +
        (taste.aesthetics || []).map(a => '<span class="pill warm">' + esc(a.statement) + '</span>').join('') +
        (taste.notes ? '<div class="sum" style="margin-top:0.5rem">' + esc(taste.notes) + '</div>' : '');

      const th = d.threads.active || [];
      document.getElementById('threads').innerHTML = th.length
        ? th.map(t => (
            '<div class="thread"><div class="title">' + esc(t.title) +
            ' <span class="sal">显著度 ' + Number(t.salience).toFixed(2) +
            ' · 沉思 ' + t.contemplation_count + ' 次</span></div>' +
            '<div class="sum">' + esc(t.summary || '') + '</div>' +
            (t.open_questions && t.open_questions.length
              ? '<div class="sum">未解：' + esc(t.open_questions.join(' · ')) + '</div>' : '') +
            '</div>'
          )).join('')
        : '<div class="empty">还没有活跃线索。</div>';

      const cold = (d.relation.cold_topics || []).map(t =>
        '<span class="pill cold">' + esc(t.key) + ' ×' + t.hits + '</span>').join('');
      const warm = (d.relation.warm_topics || []).map(t =>
        '<span class="pill warm">' + esc(t.key) + ' ×' + t.hits + '</span>').join('');
      document.getElementById('relation').innerHTML =
        '<div class="sum" style="margin-bottom:0.6rem">' + esc(d.relation_field) + '</div>' +
        '<div><span class="meta">偏热话题</span><br>' + (warm || '<span class="empty">无</span>') + '</div>' +
        '<div style="margin-top:0.6rem"><span class="meta">偏冷话题</span><br>' + (cold || '<span class="empty">无</span>') + '</div>';

      const filterEl = document.getElementById('mono-filter');
      const threadOpts = {};
      (d.threads.active || []).forEach(t => { threadOpts[t.id] = t.title; });
      (d.monologues || []).forEach(m => (m.thread_ids || []).forEach(id => {
        if (!threadOpts[id]) threadOpts[id] = id;
      }));
      const prev = monoFilter || filterEl.value;
      filterEl.innerHTML = '<option value="">全部线索</option>' +
        Object.keys(threadOpts).map(id =>
          '<option value="' + esc(id) + '">' + esc(threadOpts[id]) + '</option>'
        ).join('');
      filterEl.value = prev;
      monoFilter = filterEl.value;

      let monos = d.monologues || [];
      if (monoFilter) {
        monos = monos.filter(m => (m.thread_ids || []).includes(monoFilter));
      }
      document.getElementById('monologues').innerHTML = monos.length
        ? monos.map(m => (
            '<div class="mono-card">' +
              '<div class="title">' + esc(fmtTime(m.at)) +
              ' <span class="sal">' + esc(modeLabel(m.mode)) +
              (m.thread_ids && m.thread_ids.length ? ' · 线索 ' + esc(m.thread_ids.join(',')) : '') +
              (m.reading && m.reading[0] ? ' · 阅读 ' + esc(m.reading.map(r=>r.path).join(', ')) : '') +
              '</span></div>' +
              '<div class="body">' + esc(m.monologue) + '</div>' +
              (m.refined_summary ? '<div class="sum" style="margin-top:0.4rem">→ ' + esc(m.refined_summary) + '</div>' : '') +
            '</div>'
          )).join('')
        : '<div class="empty">暂无沉思' + (monoFilter ? '（该线索）' : '') + '。可点「沉思」或等待心跳。</div>';

      const dlg = d.dialogue || [];
      const dlgEl = document.getElementById('dialogue');
      dlgEl.innerHTML = dlg.length
        ? dlg.map(t => {
            const who = t.role === 'user' ? '你' : 'Oren';
            const share = t.share && t.share.opened
              ? (() => {
                  const kindMap = { read: '阅读', think: '所思', write: '自写' };
                  const kind = t.share.kind && kindMap[t.share.kind] ? kindMap[t.share.kind] : '分享';
                  const path = t.share.source_path ? ' · ' + esc(t.share.source_path) : '';
                  return '<div class="share"><span class="kind">' + kind + path + '</span>' +
                    esc(t.share.snippet || '') + '</div>';
                })() : '';
            const proactive = t.proactive && t.role === 'oren'
              ? ' <span class="sal">主动</span>'
              : '';
            return '<div class="row ' + (t.role === 'user' ? 'you' : 'oren') + '"><div class="who">' + who +
              ' · ' + esc(fmtTime(t.ts)) + proactive +
              '</div><div class="bubble">' + esc(t.text || '') + '</div>' + share + '</div>';
          }).join('')
        : '<div class="empty">还没有对话。在下方输入即可。</div>';
      dlgEl.scrollTop = dlgEl.scrollHeight;

      const corp = d.corpus || [];
      document.getElementById('corpus').innerHTML = corp.length
        ? corp.map(c =>
            '<div class="corp-row">' +
              '<div><b>' + esc(c.path) + '</b> <span class="sal">' + c.bytes + ' 字节</span></div>' +
              (c.preview ? '<div class="sum">' + esc(c.preview) + '</div>' : '') +
              '<div style="margin-top:0.35rem">' +
                '<button type="button" data-preview="' + esc(c.path) + '">预览</button> ' +
                '<button type="button" data-del="' + esc(c.path) + '">删除</button>' +
              '</div>' +
              (previewOpen === c.path
                ? '<pre class="body" id="corp-preview-body" style="margin-top:0.5rem;white-space:pre-wrap;color:var(--mono);font-size:0.85rem">加载中…</pre>'
                : '') +
            '</div>'
          ).join('')
        : '<div class="empty">语料为空 — 在下方添加 .md 文件。</div>';
      document.querySelectorAll('[data-preview]').forEach(btn => {
        btn.onclick = () => previewCorpus(btn.getAttribute('data-preview'));
      });
      document.querySelectorAll('[data-del]').forEach(btn => {
        btn.onclick = () => deleteCorpus(btn.getAttribute('data-del'));
      });
      if (previewOpen) {
        fetch('/api/corpus?name=' + encodeURIComponent(previewOpen))
          .then(r => r.json())
          .then(data => {
            const el = document.getElementById('corp-preview-body');
            if (el) el.textContent = (data.file && data.file.content) || data.error || '';
          })
          .catch(e => {
            const el = document.getElementById('corp-preview-body');
            if (el) el.textContent = String(e);
          });
      }

      const st = d.stream || [];
      document.getElementById('stream').innerHTML = st.length
        ? st.slice().reverse().map((e, idx) =>
            '<div class="stream-row" data-idx="' + idx + '" style="cursor:pointer" title="点击展开">' +
            '<span class="t">' + esc(fmtClock(e.ts)) +
            '</span><span class="type">' + esc(eventLabel(e.type)) + '</span>' +
            '<pre class="stream-payload" style="display:none;margin:0.25rem 0 0;white-space:pre-wrap;color:var(--mono);font-size:0.72rem"></pre>' +
            '</div>'
          ).join('')
        : '<div class="empty">意识流为空</div>';
      const rev = st.slice().reverse();
      document.querySelectorAll('.stream-row').forEach(row => {
        row.onclick = () => {
          const pre = row.querySelector('.stream-payload');
          if (!pre) return;
          const i = Number(row.getAttribute('data-idx'));
          const open = pre.style.display !== 'none';
          pre.style.display = open ? 'none' : 'block';
          if (!open) pre.textContent = JSON.stringify(rev[i] && rev[i].payload, null, 2);
        };
      });

      document.getElementById('modes').innerHTML =
        (d.modes_recent || []).map(m => '<span class="pill">' + esc(modeLabel(m)) + '</span>').join('') ||
        '<span class="empty">暂无模式记录</span>';

      document.getElementById('footer').textContent =
        '仅本机访问 · 生成于 ' + fmtTime(d.generated_at) + ' · 数据目录 ' + d.home;
    }

    function fmtTime(s) {
      if (!s) return '';
      return String(s).replace('T', ' ').slice(0, 19);
    }
    function fmtClock(s) {
      if (!s) return '';
      return String(s).replace('T', ' ').slice(11, 19);
    }

    function esc(s) {
      return String(s ?? '').replace(/[&<>"']/g, c => ({
        '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
      }[c]));
    }

    function setBusy(v, msg, el) {
      busy = v;
      document.getElementById('btn-say').disabled = v;
      ['btn-tick','btn-organize','btn-contemplate','btn-plan','btn-act'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.disabled = v;
      });
      document.getElementById('btn-corp').disabled = v;
      document.getElementById('say-input').disabled = v;
      const st = document.getElementById(el || 'say-status');
      st.className = 'status-line';
      st.textContent = msg || '';
    }
    function setErr(msg, el) {
      const st = document.getElementById(el || 'say-status');
      st.className = 'status-line err';
      st.textContent = msg;
    }

    async function say() {
      if (busy) return;
      const input = document.getElementById('say-input');
      const text = input.value.trim();
      if (!text) return;
      setBusy(true, 'Oren 正在思考…');
      try {
        const res = await fetch('/api/say', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || ('发送失败 ' + res.status));
        input.value = '';
        await load();
        const n = (data.oren_turns && data.oren_turns.length) || 1;
        const stanceZh = { follow: '顺着聊', weave: '接住并带一点', lead: '自己起头' }[data.stance] || '';
        const shareBit = data.share && data.share.opened
          ? (' · 分享' + ({ read: '阅读', think: '所思', write: '自写' }[data.share.kind] || '内心'))
          : '';
        setBusy(false,
          (n > 1 ? ('连说 ' + n + ' 句') : '已发送') +
          (stanceZh ? ' · ' + stanceZh : '') + shareBit);
      } catch (e) {
        setBusy(false); setErr(String(e.message || e));
      }
    }

    async function tickOnce(forceMode) {
      if (busy) return;
      setBusy(true,
        forceMode === 'contemplate' ? '正在沉思…'
          : forceMode === 'organize' ? '正在整理…'
            : forceMode === 'plan' ? '正在规划…'
              : forceMode === 'act' ? '执行下一项…'
                : '正在心跳…');
      try {
        const res = await fetch('/api/tick', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(forceMode ? { forceMode } : {}),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || data.message || ('心跳失败 ' + res.status));
        await load();
        const mode = modeLabel(data.mode || '');
        setBusy(false, data.message ? data.message : ('完成：' + mode));
      } catch (e) {
        setBusy(false); setErr(String(e.message || e));
      }
    }

    async function addCorpus() {
      if (busy) return;
      const name = document.getElementById('corp-name').value.trim();
      const content = document.getElementById('corp-content').value;
      if (!name || !content.trim()) {
        setErr('请填写文件名和内容', 'corp-status');
        return;
      }
      setBusy(true, '正在写入语料…', 'corp-status');
      try {
        const res = await fetch('/api/corpus', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name, content }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || ('添加失败 ' + res.status));
        document.getElementById('corp-name').value = '';
        document.getElementById('corp-content').value = '';
        await load();
        setBusy(false, '已添加 ' + (data.file && data.file.path), 'corp-status');
      } catch (e) {
        setBusy(false); setErr(String(e.message || e), 'corp-status');
      }
    }

    async function deleteCorpus(name) {
      if (busy || !name) return;
      if (!confirm('确定删除语料「' + name + '」？')) return;
      setBusy(true, '正在删除…', 'corp-status');
      try {
        const res = await fetch('/api/corpus?name=' + encodeURIComponent(name), { method: 'DELETE' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || ('删除失败 ' + res.status));
        if (previewOpen === name) previewOpen = null;
        await load();
        setBusy(false, '已删除 ' + name, 'corp-status');
      } catch (e) {
        setBusy(false); setErr(String(e.message || e), 'corp-status');
      }
    }

    function previewCorpus(name) {
      previewOpen = previewOpen === name ? null : name;
      if (lastSnap) render(lastSnap);
    }

    document.getElementById('btn-refresh').onclick = () => load().catch(e => setErr(String(e)));
    document.getElementById('btn-say').onclick = say;
    document.getElementById('btn-tick').onclick = () => tickOnce();
    document.getElementById('btn-plan').onclick = () => tickOnce('plan');
    document.getElementById('btn-act').onclick = () => tickOnce('act');
    document.getElementById('btn-contemplate').onclick = () => tickOnce('contemplate');
    document.getElementById('btn-organize').onclick = () => tickOnce('organize');
    document.getElementById('btn-corp').onclick = addCorpus;
    document.getElementById('mono-filter').onchange = (e) => {
      monoFilter = e.target.value;
      if (lastSnap) render(lastSnap);
    };
    document.getElementById('say-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); say(); }
    });

    load().catch(err => { document.getElementById('header-meta').textContent = String(err); });
    setInterval(() => { if (!busy) load().catch(() => {}); }, 15000);
  </script>
</body>
</html>`;
}
