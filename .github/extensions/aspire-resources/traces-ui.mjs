import { escapeHtml } from "./branding.mjs";

const TRACES_HTML_TEMPLATE = `<!doctype html>
<html><head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>__APP_TITLE__ Traces</title>
  <style>
    :root {
      --kg-bg: var(--background-color-default, #fff);
      --kg-fg: var(--text-color-default, #1f2328);
      --kg-muted: var(--text-color-muted, #656d76);
      --kg-border: var(--border-color-default, #d0d7de);
      --kg-border-muted: color-mix(in srgb, var(--kg-border) 65%, transparent);
      --kg-panel: color-mix(in srgb, var(--kg-fg) 6%, var(--kg-bg));
      --kg-hover: var(--background-color-hover, color-mix(in srgb, var(--kg-fg) 9%, var(--kg-bg)));
      --kg-accent: var(--color-accent-emphasis, var(--kg-fg));
      --kg-danger-fg: var(--color-danger-fg, var(--true-color-red, #d1242f));
      --kg-focus: var(--color-focus-outline, #0969da);
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; height: 100%; background: var(--kg-bg); color: var(--kg-fg); font: var(--text-body-medium, 14px)/var(--leading-body-medium, 20px) var(--font-sans, sans-serif); }
    .header {
      display: flex; align-items: center; gap: 10px;
      padding: 10px 12px; border-bottom: 1px solid var(--kg-border);
      position: sticky; top: 0; background: var(--kg-bg); z-index: 10;
    }
    .header-title { font-weight: var(--font-weight-semibold, 600); }
    .grow { flex: 1; }
    .row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .btn, .select {
      border: 1px solid var(--kg-border); border-radius: 6px;
      padding: 6px 10px; background: var(--kg-bg); color: var(--kg-fg);
      font: inherit;
    }
    .btn { text-decoration: none; cursor: pointer; }
    .btn:hover { background: var(--kg-hover); }
    .btn:focus-visible, .select:focus-visible {
      outline: 2px solid var(--kg-focus); outline-offset: 1px;
    }
    .btn[aria-disabled="true"] { opacity: 0.45; pointer-events: none; }
    .toolbar {
      display: grid; gap: 10px; padding: 10px 12px;
      border-bottom: 1px solid var(--kg-border); background: var(--background-color-subtle, var(--kg-panel));
    }
    .muted { color: var(--kg-muted); font-size: 12px; }
    #statusText.err { color: var(--kg-danger-fg); }
    #contentWrap { height: calc(100vh - 186px); min-height: 360px; overflow: auto; }
    #empty {
      display: grid; place-items: center; min-height: 200px;
      color: var(--kg-muted); text-align: center; padding: 20px;
    }
    .table-wrap { padding: 8px 12px 14px; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th, td { text-align: left; padding: 7px 8px; border-bottom: 1px solid var(--kg-border-muted); vertical-align: top; }
    th { color: var(--kg-muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; position: sticky; top: 0; background: var(--kg-bg); }
    tr:hover td { background: var(--kg-hover); }
    .trace-title { font-weight: var(--font-weight-semibold, 600); }
    tbody tr:hover td { background: var(--kg-hover); }
    .mono { font-family: var(--font-mono, monospace); font-size: 11px; }
    .badge {
      display: inline-flex; align-items: center; gap: 6px;
      border: 1px solid var(--kg-border); border-radius: 999px;
      padding: 2px 8px; font-size: 11px;
    }
    .badge.ok { color: var(--kg-muted); }
    .badge.err {
      color: var(--kg-danger-fg);
      border-color: color-mix(in srgb, var(--kg-danger-fg) 40%, var(--kg-border));
      background: color-mix(in srgb, var(--kg-danger-fg) 12%, transparent);
    }
    .log-snapshot { margin: 0 12px 12px; border: 1px solid var(--kg-border); border-radius: 8px; }
    .log-snapshot summary { cursor: pointer; padding: 8px 10px; color: var(--kg-muted); font-size: 12px; }
    .log-snapshot pre {
      margin: 0; border-top: 1px solid var(--kg-border-muted); padding: 10px;
      font-size: 11px; max-height: 220px; overflow: auto; white-space: pre-wrap;
      font-family: var(--font-mono, monospace);
      background: var(--background-color-subtle, var(--kg-panel));
    }
    #detail {
      position: fixed; bottom: 0; left: 0; right: 0;
      background: var(--kg-bg);
      border-top: 1px solid var(--kg-border);
      box-shadow: 0 -4px 16px color-mix(in srgb, var(--kg-fg) 10%, transparent);
      z-index: 20; max-height: 50vh; display: flex; flex-direction: column;
    }
    .detail-grip {
      height: 9px; flex-shrink: 0; cursor: ns-resize;
      display: flex; align-items: center; justify-content: center;
      background: var(--background-color-subtle, var(--kg-panel));
      border-bottom: 1px solid var(--kg-border-muted);
      touch-action: none;
    }
    .detail-grip::before {
      content: ''; width: 36px; height: 3px; border-radius: 2px;
      background: var(--kg-border);
    }
    .detail-grip:hover::before { background: var(--kg-muted); }
    .detail-hdr {
      display: flex; align-items: center; gap: 8px; padding: 8px 12px;
      border-bottom: 1px solid var(--kg-border-muted); flex-shrink: 0;
    }
    .detail-title { flex: 1; font-weight: var(--font-weight-semibold, 600); font-size: 13px; }
    .detail-meta { font-size: 11px; color: var(--kg-muted); }
    .detail-body { overflow: auto; flex: 1; }
    .detail-body table { width: 100%; border-collapse: collapse; font-size: 12px; }
    .detail-body th {
      text-align: left; font-size: 10px; font-weight: 600; letter-spacing: .04em;
      text-transform: uppercase; color: var(--kg-muted);
      padding: 6px 10px; border-bottom: 1px solid var(--kg-border);
      position: sticky; top: 0; background: var(--kg-bg);
    }
    .detail-body td { padding: 5px 10px; border-bottom: 1px solid var(--kg-border-muted); }
    .detail-body tr:hover td { background: var(--kg-hover); }
    .span-err td { color: var(--kg-danger-fg); }
  </style>
</head><body>
  <div class="header">
    <span>__APP_EMOJI__</span>
    <span class="header-title">__APP_TITLE__ Traces</span>
    <span class="grow"></span>
    <button class="btn" id="refreshBtn">↻ Refresh</button>
  </div>
  <div class="toolbar">
    <div class="row">
      <label for="apphostSelect" class="muted">AppHost:</label>
      <select class="select" id="apphostSelect"></select>
      <button class="btn" id="useApphostBtn">Use selected</button>
      <span class="muted" id="statusText">Loading…</span>
    </div>
    <div class="row">
      <label class="muted" for="resourceFilter">Resource:</label>
      <input class="select" id="resourceFilter" placeholder="all resources" />
      <label class="muted" for="searchFilter">Search:</label>
      <input class="select" id="searchFilter" placeholder="http.method:GET, error, trace id..." />
      <label class="muted" for="limitSelect">Limit:</label>
      <select class="select" id="limitSelect">
        <option value="20">20</option>
        <option value="50" selected>50</option>
        <option value="100">100</option>
      </select>
      <label class="muted"><input type="checkbox" id="errOnly" /> Errors only</label>
      <button class="btn" id="fetchLogsBtn">Get logs snapshot</button>
      <button class="btn" id="openTracesBtn" aria-disabled="true" onclick="openBtnUrl(this)">Open traces in dashboard</button>
      <button class="btn" id="openLogsBtn" aria-disabled="true" onclick="openBtnUrl(this)">Open logs in dashboard</button>
    </div>
  </div>
  <div id="contentWrap">
    <div id="empty">No traces yet. Click refresh after your app receives traffic.</div>
    <div class="table-wrap" id="tableWrap" style="display:none">
      <table>
        <thead>
          <tr>
            <th>Title</th>
            <th>Trace ID</th>
            <th>Duration</th>
            <th>Time</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody id="tracesBody"></tbody>
      </table>
    </div>
    <details class="log-snapshot" id="logSnapshotWrap" style="display:none">
      <summary>Latest logs snapshot</summary>
      <pre id="logSnapshot"></pre>
    </details>
  </div>
  <div id="detail" style="display:none"></div>
  <script src="/traces.js"></script>
</body></html>`;

function renderTracesHtml(branding) {
    const safeTitle = escapeHtml(branding?.appName || "App");
    const safeEmoji = escapeHtml(branding?.emoji || "🌱");
    return TRACES_HTML_TEMPLATE
        .replaceAll("__APP_TITLE__", safeTitle)
        .replaceAll("__APP_EMOJI__", safeEmoji);
}

const TRACES_APP_JS = `
(function() {
  var current = null;
  var currentLogs = [];
  var allTraces = [];

  function setStatus(msg, isError) {
    var el = document.getElementById('statusText');
    if (!el) return;
    el.textContent = msg || '';
    el.className = isError ? 'err' : '';
  }

  function renderApphosts(items, selected) {
    var select = document.getElementById('apphostSelect');
    if (!select) return;
    var hosts = Array.isArray(items) ? items : [];
    if (!hosts.length) {
      select.innerHTML = '<option value="">No running AppHosts</option>';
      return;
    }
    select.innerHTML = hosts.map(function(host) {
      var path = host.apphostPath || '';
      var label = host.label || path || 'AppHost';
      var scope = host.fromWorkspace ? ' (workspace)' : ' (other)';
      var isSelected = selected && selected === path ? ' selected' : '';
      return '<option value="' + attr(path) + '"' + isSelected + '>' + attr(label + scope) + '</option>';
    }).join('');
  }

  function attr(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  }

  function text(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function openUrl(url) {
    if (!url) return;
    fetch('/api/open-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: url }),
    }).catch(function() {});
  }
  window.openUrl = openUrl;

  window.openBtnUrl = function(btn) {
    if (!btn || btn.getAttribute('aria-disabled') === 'true') return;
    openUrl(btn.dataset.url || '');
  };

  var detailHeight = 0; // remembered across reopens once the user resizes

  function wireDetailResize() {
    var grip = document.getElementById('detailGrip');
    var panel = document.getElementById('detail');
    if (!grip || !panel) return;
    grip.addEventListener('pointerdown', function(e) {
      e.preventDefault();
      var startY = e.clientY;
      var startH = panel.getBoundingClientRect().height;
      try { grip.setPointerCapture(e.pointerId); } catch (ex) {}
      function onMove(ev) {
        var dy = startY - ev.clientY; // drag up => taller
        var max = window.innerHeight * 0.85;
        var h = Math.min(max, Math.max(120, startH + dy));
        panel.style.height = h + 'px';
        panel.style.maxHeight = 'none';
        detailHeight = h;
      }
      function onUp(ev) {
        grip.removeEventListener('pointermove', onMove);
        grip.removeEventListener('pointerup', onUp);
        try { grip.releasePointerCapture(ev.pointerId); } catch (ex) {}
      }
      grip.addEventListener('pointermove', onMove);
      grip.addEventListener('pointerup', onUp);
    });
  }

  window.showDetail = function(traceId) {
    var trace = allTraces.find(function(t) { return t.traceId === traceId; });
    var panel = document.getElementById('detail');
    if (!panel || !trace) return;
    var spans = Array.isArray(trace.spans) ? trace.spans : [];
    var dur = trace.durationMs != null ? trace.durationMs + 'ms' : '';
    var ts = trace.timestamp ? new Date(trace.timestamp).toLocaleTimeString() : '';
    var dashUrl = trace.dashboardUrl || '';
    var rows = spans.map(function(s) {
      var sc = Number(s.attributes && s.attributes['http.status_code']);
      var isErr = s.hasError || (sc >= 400);
      var statusCell = s.attributes && s.attributes['http.status_code']
        ? text(String(s.attributes['http.status_code']))
        : (isErr ? '<span style="color:var(--kg-danger-fg)">err</span>' : '—');
      return '<tr' + (isErr ? ' class="span-err"' : '') + '>' +
        '<td>' + text(s.source || '') + '</td>' +
        '<td>' + text(s.name || '') + '</td>' +
        '<td class="muted">' + text(s.kind || '') + '</td>' +
        '<td>' + text(s.durationMs != null ? s.durationMs + 'ms' : '—') + '</td>' +
        '<td>' + statusCell + '</td>' +
      '</tr>';
    }).join('');
    var openBtn = dashUrl
      ? '<button class="btn" data-url="' + attr(dashUrl) + '" onclick="openBtnUrl(this)">⎋ Open in dashboard</button>'
      : '';
    panel.innerHTML =
      '<div class="detail-grip" id="detailGrip" title="Drag to resize"></div>' +
      '<div class="detail-hdr">' +
        '<span class="detail-title">' + text(trace.title || trace.traceId) + '</span>' +
        '<span class="detail-meta">' + text(dur) + (ts ? ' · ' + text(ts) : '') + '</span>' +
        openBtn +
        '<button class="btn" onclick="window.closeDetail()">✕</button>' +
      '</div>' +
      '<div class="detail-body">' +
        '<table><thead><tr>' +
          '<th>Service</th><th>Operation</th><th>Kind</th><th>Duration</th><th>Status</th>' +
        '</tr></thead>' +
        '<tbody>' + (rows || '<tr><td colspan="5" class="muted" style="padding:10px">No span data.</td></tr>') + '</tbody>' +
        '</table>' +
      '</div>';
    panel.style.display = 'flex';
    if (detailHeight) {
      panel.style.height = detailHeight + 'px';
      panel.style.maxHeight = 'none';
    }
    wireDetailResize();
  };

  window.closeDetail = function() {
    var panel = document.getElementById('detail');
    if (panel) panel.style.display = 'none';
  };

  function setButtonLink(id, href) {
    var el = document.getElementById(id);
    if (!el) return;
    if (href) {
      el.dataset.url = href;
      el.setAttribute('aria-disabled', 'false');
    } else {
      delete el.dataset.url;
      el.setAttribute('aria-disabled', 'true');
    }
  }

  function setEmpty(message) {
    var tableWrap = document.getElementById('tableWrap');
    var body = document.getElementById('tracesBody');
    var empty = document.getElementById('empty');
    if (body) body.innerHTML = '';
    if (tableWrap) tableWrap.style.display = 'none';
    if (empty) { empty.textContent = message || 'No traces found.'; empty.style.display = 'grid'; }
  }

  function fmtDuration(ms) {
    var n = Number(ms || 0);
    if (!isFinite(n)) return '—';
    if (n >= 1000) return (n / 1000).toFixed(2) + 's';
    return n.toFixed(0) + 'ms';
  }

  function fmtTime(ts) {
    if (!ts) return '—';
    var d = new Date(ts);
    if (!isFinite(d.getTime())) return String(ts);
    return d.toLocaleTimeString();
  }

  function firstSource(trace) {
    var spans = Array.isArray(trace && trace.spans) ? trace.spans : [];
    var s = spans.find(function(x) { return x && x.source; });
    return (s && s.source) ? String(s.source) : '';
  }

  function renderTraces(traces) {
    var rows = Array.isArray(traces) ? traces : [];
    allTraces = rows;
    var body = document.getElementById('tracesBody');
    var tableWrap = document.getElementById('tableWrap');
    var empty = document.getElementById('empty');
    if (!body || !tableWrap || !empty) return;
    if (!rows.length) {
      setEmpty('No traces found for the current filters.');
      return;
    }
    body.innerHTML = rows.map(function(t) {
      var traceId = t && t.traceId ? String(t.traceId) : '';
      var title = t && t.title ? String(t.title) : '(untitled trace)';
      var status = t && t.hasError ? '<span class="badge err">Error</span>' : '<span class="badge ok">OK</span>';
      var source = firstSource(t);
      return '<tr style="cursor:pointer" data-traceid="' + attr(traceId) + '" onclick="window.showDetail(this.dataset.traceid)">' +
        '<td><div class="trace-title">' + text(title) + '</div><div class="muted mono">' + text(source) + '</div></td>' +
        '<td class="mono">' + text(traceId) + '</td>' +
        '<td>' + text(fmtDuration(t && t.durationMs)) + '</td>' +
        '<td>' + text(fmtTime(t && t.timestamp)) + '</td>' +
        '<td>' + status + '</td>' +
      '</tr>';
    }).join('');
    empty.style.display = 'none';
    tableWrap.style.display = 'block';
  }

  function renderLinks(data) {
    current = data || null;
    setButtonLink('openTracesBtn', data && data.tracesUrl ? data.tracesUrl : '');
    setButtonLink('openLogsBtn', data && data.logsUrl ? data.logsUrl : '');
  }

  function tracesQuery() {
    var params = new URLSearchParams();
    var resource = document.getElementById('resourceFilter');
    var search = document.getElementById('searchFilter');
    var limit = document.getElementById('limitSelect');
    var errOnly = document.getElementById('errOnly');
    if (resource && resource.value.trim()) params.set('resource', resource.value.trim());
    if (search && search.value.trim()) params.set('search', search.value.trim());
    if (limit && limit.value) params.set('limit', limit.value);
    if (errOnly && errOnly.checked) params.set('hasError', 'true');
    return params.toString();
  }

  function refresh() {
    setStatus('Refreshing traces…');
    var qs = tracesQuery();
    fetch('/api/traces' + (qs ? ('?' + qs) : ''))
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data && data.ok) {
          renderLinks(data);
          renderTraces(data.traces || []);
          setStatus('Loaded ' + ((data.traces && data.traces.length) || 0) + ' traces from ' + (data.apphostPath || 'AppHost'));
        } else if (data && data.code === 'no_apphost') {
          renderLinks(null);
          setEmpty('No running AppHost found.');
          setStatus('No running AppHost found', true);
        } else {
          renderLinks(null);
          setEmpty((data && data.message) || 'Failed to refresh traces.');
          setStatus((data && data.message) || 'Failed to refresh traces', true);
        }
      })
      .catch(function() {
        renderLinks(null);
        setEmpty('Failed to refresh traces.');
        setStatus('Failed to refresh traces', true);
      });
  }

  function fetchLogsSnapshot() {
    setStatus('Fetching logs snapshot…');
    var params = new URLSearchParams();
    var resource = document.getElementById('resourceFilter');
    var search = document.getElementById('searchFilter');
    if (resource && resource.value.trim()) params.set('resource', resource.value.trim());
    if (search && search.value.trim()) params.set('search', search.value.trim());
    params.set('limit', '50');
    fetch('/api/logs?' + params.toString())
      .then(function(r) { return r.json(); })
      .then(function(data) {
        var wrap = document.getElementById('logSnapshotWrap');
        var pre = document.getElementById('logSnapshot');
        if (!wrap || !pre) return;
        if (data && data.ok) {
          currentLogs = Array.isArray(data.logs) ? data.logs : [];
          pre.textContent = currentLogs.map(function(log) {
            var sev = log && log.severity ? '[' + log.severity + '] ' : '';
            var res = log && log.resourceName ? log.resourceName + ': ' : '';
            var msg = log && (log.message || (log.attributes && log.attributes['log.message'])) ? (log.message || log.attributes['log.message']) : '(empty)';
            return sev + res + msg;
          }).join('\\n');
          wrap.style.display = 'block';
          wrap.open = true;
          if (!current || !current.logsUrl) setButtonLink('openLogsBtn', data.logsUrl || '');
          setStatus('Fetched ' + currentLogs.length + ' logs');
        } else {
          setStatus((data && data.message) || 'Failed to fetch logs snapshot', true);
        }
      })
      .catch(function() {
        setStatus('Failed to fetch logs snapshot', true);
      });
  }

  function loadApphosts() {
    fetch('/api/apphosts')
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (!data || !data.ok) {
          renderApphosts([], '');
          return;
        }
        renderApphosts(data.apphosts || [], data.selectedApphost || '');
      })
      .catch(function() {
        renderApphosts([], '');
      });
  }

  function useSelectedApphost() {
    var select = document.getElementById('apphostSelect');
    var apphost = select && select.value ? select.value : '';
    setStatus('Updating AppHost…');
    fetch('/api/select-apphost', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apphost: apphost })
    })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data && data.ok) {
          loadApphosts();
          refresh();
        } else {
          setStatus((data && data.message) || 'Failed to set AppHost', true);
        }
      })
      .catch(function() {
        setStatus('Failed to set AppHost', true);
      });
  }

  document.getElementById('refreshBtn').addEventListener('click', refresh);
  document.getElementById('useApphostBtn').addEventListener('click', useSelectedApphost);
  document.getElementById('fetchLogsBtn').addEventListener('click', fetchLogsSnapshot);
  document.getElementById('resourceFilter').addEventListener('keydown', function(evt) { if (evt.key === 'Enter') refresh(); });
  document.getElementById('searchFilter').addEventListener('keydown', function(evt) { if (evt.key === 'Enter') refresh(); });
  document.getElementById('limitSelect').addEventListener('change', refresh);
  document.getElementById('errOnly').addEventListener('change', refresh);
  document.addEventListener('keydown', function(evt) { if (evt.key === 'Escape') window.closeDetail(); });

  loadApphosts();
  refresh();
})();
`;

export { renderTracesHtml, TRACES_APP_JS };
