/**
 * Synap Admin — Researcher Dashboard
 * Queries Supabase REST API (PostgREST) directly from the browser.
 */

(function () {
  "use strict";

  // ── State ──────────────────────────────────────────────────
  let sbUrl = "";
  let sbKey = "";
  let currentView = "sessions";

  // ── DOM refs ───────────────────────────────────────────────
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const connectScreen = $("#connect-screen");
  const connectForm = $("#connect-form");
  const connectError = $("#connect-error");
  const sbUrlInput = $("#sb-url");
  const sbKeyInput = $("#sb-key");
  const dashboard = $("#dashboard");
  const disconnectBtn = $("#disconnect-btn");

  // ── Boot ───────────────────────────────────────────────────
  function init() {
    // Check for saved connection
    const saved = sessionStorage.getItem("synap_admin");
    if (saved) {
      const parsed = JSON.parse(saved);
      sbUrl = parsed.url;
      sbKey = parsed.key;
      showDashboard();
    }

    connectForm.addEventListener("submit", onConnect);
    disconnectBtn.addEventListener("click", onDisconnect);

    // Nav links
    $$(".nav-link").forEach((link) => {
      link.addEventListener("click", (e) => {
        e.preventDefault();
        switchView(link.dataset.view);
      });
    });

    // Back button in transcript
    $("#back-to-sessions").addEventListener("click", () => {
      $("#view-transcript").hidden = true;
      $("#view-sessions").hidden = false;
    });

    // Refresh buttons
    $("#refresh-sessions").addEventListener("click", loadSessions);
    $("#refresh-themes").addEventListener("click", loadThemes);

    // Filters
    $("#filter-config").addEventListener("change", loadSessions);
    $("#filter-status").addEventListener("change", loadSessions);
    $("#theme-config-filter").addEventListener("change", loadThemes);

    // Export buttons
    $$("[data-export]").forEach((btn) => {
      btn.addEventListener("click", () => {
        exportData(btn.dataset.export, btn.dataset.format);
      });
    });
  }

  // ── Connection ─────────────────────────────────────────────
  async function onConnect(e) {
    e.preventDefault();
    const url = sbUrlInput.value.trim().replace(/\/$/, "");
    const key = sbKeyInput.value.trim();

    // Test connection
    try {
      connectError.hidden = true;
      const resp = await fetch(url + "/rest/v1/sessions?select=id&limit=1", {
        headers: {
          apikey: key,
          Authorization: "Bearer " + key,
        },
      });
      if (!resp.ok) throw new Error("Connection failed: " + resp.status);

      sbUrl = url;
      sbKey = key;
      sessionStorage.setItem("synap_admin", JSON.stringify({ url, key }));
      showDashboard();
    } catch (err) {
      connectError.textContent = err.message;
      connectError.hidden = false;
    }
  }

  function onDisconnect() {
    sessionStorage.removeItem("synap_admin");
    sbUrl = "";
    sbKey = "";
    dashboard.hidden = true;
    connectScreen.hidden = false;
    sbUrlInput.value = "";
    sbKeyInput.value = "";
  }

  function showDashboard() {
    connectScreen.hidden = true;
    dashboard.hidden = false;
    loadConfigFilters();
    loadSessions();
  }

  // ── Supabase REST helper ───────────────────────────────────
  async function query(table, params) {
    const qs = new URLSearchParams(params || {});
    const resp = await fetch(sbUrl + "/rest/v1/" + table + "?" + qs.toString(), {
      headers: {
        apikey: sbKey,
        Authorization: "Bearer " + sbKey,
        Prefer: "count=exact",
      },
    });
    if (!resp.ok) throw new Error("Query failed: " + resp.status);
    const count = resp.headers.get("content-range");
    const data = await resp.json();
    return { data, count };
  }

  // ── Navigation ─────────────────────────────────────────────
  function switchView(view) {
    currentView = view;
    $$(".nav-link").forEach((l) => l.classList.toggle("active", l.dataset.view === view));
    $$(".view").forEach((v) => (v.hidden = true));
    $("#view-" + view).hidden = false;

    if (view === "sessions") loadSessions();
    if (view === "themes") loadThemes();
  }

  // ── Config Filters ─────────────────────────────────────────
  async function loadConfigFilters() {
    try {
      const { data } = await query("sessions", { select: "config_id", order: "config_id" });
      const configs = [...new Set(data.map((s) => s.config_id))];

      ["filter-config", "theme-config-filter", "export-config-filter"].forEach((id) => {
        const sel = $("#" + id);
        const existing = sel.value;
        // Keep the "All" option, clear the rest
        while (sel.options.length > 1) sel.remove(1);
        configs.forEach((c) => {
          const opt = document.createElement("option");
          opt.value = c;
          opt.textContent = c;
          sel.appendChild(opt);
        });
        sel.value = existing || "";
      });
    } catch (err) {
      console.error("[Admin] Failed to load config filters:", err);
    }
  }

  // ── Sessions View ──────────────────────────────────────────
  async function loadSessions() {
    const body = $("#sessions-body");
    const empty = $("#sessions-empty");
    body.innerHTML = "";
    empty.hidden = true;

    try {
      const params = {
        select: "id,config_id,status,turn_count,started_at,ended_at",
        order: "started_at.desc",
        limit: "100",
      };

      const configFilter = $("#filter-config").value;
      const statusFilter = $("#filter-status").value;
      if (configFilter) params["config_id"] = "eq." + configFilter;
      if (statusFilter) params["status"] = "eq." + statusFilter;

      const { data } = await query("sessions", params);

      if (data.length === 0) {
        empty.hidden = false;
        return;
      }

      data.forEach((s) => {
        const tr = document.createElement("tr");
        tr.innerHTML =
          "<td><code>" + truncate(s.id, 20) + "</code></td>" +
          "<td>" + esc(s.config_id) + "</td>" +
          '<td><span class="badge badge-' + s.status + '">' + s.status + "</span></td>" +
          "<td>" + s.turn_count + "</td>" +
          "<td>" + formatDate(s.started_at) + "</td>" +
          "<td>" + formatDuration(s.started_at, s.ended_at) + "</td>" +
          '<td><button class="btn btn-small btn-secondary view-transcript-btn">View</button></td>';

        tr.querySelector(".view-transcript-btn").addEventListener("click", () => {
          openTranscript(s.id, s);
        });

        body.appendChild(tr);
      });
    } catch (err) {
      empty.textContent = "Error loading sessions: " + err.message;
      empty.hidden = false;
    }
  }

  // ── Transcript View ────────────────────────────────────────
  async function openTranscript(sessionId, sessionMeta) {
    $("#view-sessions").hidden = true;
    const view = $("#view-transcript");
    view.hidden = false;

    $("#transcript-title").textContent = "Session: " + truncate(sessionId, 24);

    // Meta
    const meta = $("#transcript-meta");
    meta.innerHTML =
      "<div><strong>Study:</strong> " + esc(sessionMeta.config_id) + "</div>" +
      "<div><strong>Status:</strong> " + sessionMeta.status + "</div>" +
      "<div><strong>Turns:</strong> " + sessionMeta.turn_count + "</div>" +
      "<div><strong>Started:</strong> " + formatDate(sessionMeta.started_at) + "</div>" +
      "<div><strong>Duration:</strong> " + formatDuration(sessionMeta.started_at, sessionMeta.ended_at) + "</div>";

    // Load messages
    const msgContainer = $("#transcript-messages");
    msgContainer.innerHTML = '<div class="empty-state">Loading...</div>';

    try {
      const { data: messages } = await query("messages", {
        select: "role,content,turn_number,question_id,created_at",
        session_id: "eq." + sessionId,
        order: "turn_number.asc,created_at.asc",
      });

      msgContainer.innerHTML = "";
      messages.forEach((m) => {
        const div = document.createElement("div");
        div.className = "transcript-msg";
        div.innerHTML =
          '<div class="transcript-role transcript-role-' + m.role + '">' +
            m.role.toUpperCase() +
            (m.question_id ? " &middot; " + m.question_id : "") +
          "</div>" +
          '<div class="transcript-text">' + esc(m.content) + "</div>" +
          '<div class="transcript-turn">Turn ' + m.turn_number + " &middot; " + formatTime(m.created_at) + "</div>";
        msgContainer.appendChild(div);
      });

      if (messages.length === 0) {
        msgContainer.innerHTML = '<div class="empty-state">No messages found.</div>';
      }

      // Load themes
      const { data: themes } = await query("coded_themes", {
        select: "theme_code,theme_label,confidence,turn_number",
        session_id: "eq." + sessionId,
        order: "turn_number.asc",
      });

      const tagsContainer = $("#transcript-theme-tags");
      tagsContainer.innerHTML = "";

      if (themes.length === 0) {
        tagsContainer.innerHTML = '<span class="empty-state">No themes detected.</span>';
      } else {
        // Aggregate by theme
        const counts = {};
        themes.forEach((t) => {
          if (!counts[t.theme_code]) {
            counts[t.theme_code] = { label: t.theme_label || t.theme_code, count: 0 };
          }
          counts[t.theme_code].count++;
        });

        Object.entries(counts)
          .sort((a, b) => b[1].count - a[1].count)
          .forEach(([code, info]) => {
            const tag = document.createElement("span");
            tag.className = "theme-tag";
            tag.innerHTML = esc(info.label) + ' <span class="theme-count">(' + info.count + ")</span>";
            tagsContainer.appendChild(tag);
          });
      }
    } catch (err) {
      msgContainer.innerHTML = '<div class="empty-state">Error: ' + esc(err.message) + "</div>";
    }
  }

  // ── Themes View ────────────────────────────────────────────
  async function loadThemes() {
    const body = $("#themes-body");
    const empty = $("#themes-empty");
    const summary = $("#themes-summary");
    body.innerHTML = "";
    empty.hidden = true;
    summary.innerHTML = "";

    try {
      // Get all themes, optionally filtered by study
      const params = {
        select: "theme_code,theme_label,confidence,session_id",
      };

      const configFilter = $("#theme-config-filter").value;
      if (configFilter) {
        // Need to join through sessions to filter by config_id
        // PostgREST doesn't support joins directly, so we first get session IDs
        const { data: sessions } = await query("sessions", {
          select: "id",
          config_id: "eq." + configFilter,
        });
        const ids = sessions.map((s) => s.id);
        if (ids.length === 0) {
          empty.hidden = false;
          return;
        }
        params["session_id"] = "in.(" + ids.join(",") + ")";
      }

      const { data: themes } = await query("coded_themes", params);

      if (themes.length === 0) {
        empty.hidden = false;
        return;
      }

      // Aggregate
      const agg = {};
      themes.forEach((t) => {
        if (!agg[t.theme_code]) {
          agg[t.theme_code] = {
            label: t.theme_label || t.theme_code,
            count: 0,
            sessions: new Set(),
            totalConf: 0,
            confCount: 0,
          };
        }
        agg[t.theme_code].count++;
        agg[t.theme_code].sessions.add(t.session_id);
        if (t.confidence != null) {
          agg[t.theme_code].totalConf += t.confidence;
          agg[t.theme_code].confCount++;
        }
      });

      // Summary stats
      const uniqueThemes = Object.keys(agg).length;
      const totalOccurrences = themes.length;
      const uniqueSessions = new Set(themes.map((t) => t.session_id)).size;
      summary.innerHTML =
        '<div class="theme-stat"><div class="theme-stat-value">' + uniqueThemes + '</div><div class="theme-stat-label">Unique Themes</div></div>' +
        '<div class="theme-stat"><div class="theme-stat-value">' + totalOccurrences + '</div><div class="theme-stat-label">Total Occurrences</div></div>' +
        '<div class="theme-stat"><div class="theme-stat-value">' + uniqueSessions + '</div><div class="theme-stat-label">Sessions</div></div>';

      // Table rows
      Object.entries(agg)
        .sort((a, b) => b[1].count - a[1].count)
        .forEach(([code, info]) => {
          const avgConf = info.confCount > 0 ? (info.totalConf / info.confCount) : null;
          const tr = document.createElement("tr");
          tr.innerHTML =
            "<td><strong>" + esc(info.label) + "</strong><br><code>" + esc(code) + "</code></td>" +
            "<td>" + info.count + "</td>" +
            "<td>" + info.sessions.size + "</td>" +
            "<td>" + (avgConf != null
              ? '<span class="confidence-bar"><span class="confidence-fill" style="width:' + Math.round(avgConf * 100) + '%"></span></span>' + Math.round(avgConf * 100) + "%"
              : "—") + "</td>";
          body.appendChild(tr);
        });
    } catch (err) {
      empty.textContent = "Error loading themes: " + err.message;
      empty.hidden = false;
    }
  }

  // ── Export ─────────────────────────────────────────────────
  async function exportData(table, format) {
    try {
      const params = { select: "*", order: "created_at.desc", limit: "10000" };

      const configFilter = $("#export-config-filter").value;
      if (configFilter) {
        if (table === "sessions") {
          params["config_id"] = "eq." + configFilter;
        } else {
          // Get session IDs for this config
          const { data: sessions } = await query("sessions", {
            select: "id",
            config_id: "eq." + configFilter,
          });
          const ids = sessions.map((s) => s.id);
          if (ids.length === 0) {
            alert("No data found for this study.");
            return;
          }
          params["session_id"] = "in.(" + ids.join(",") + ")";
        }
      }

      const { data } = await query(table, params);

      if (data.length === 0) {
        alert("No data to export.");
        return;
      }

      let content, mime, ext;

      if (format === "json") {
        content = JSON.stringify(data, null, 2);
        mime = "application/json";
        ext = "json";
      } else {
        content = toCSV(data);
        mime = "text/csv";
        ext = "csv";
      }

      const filename = "synap_" + table + (configFilter ? "_" + configFilter : "") + "." + ext;
      download(content, filename, mime);
    } catch (err) {
      alert("Export failed: " + err.message);
    }
  }

  function toCSV(data) {
    if (data.length === 0) return "";
    const headers = Object.keys(data[0]);
    const rows = data.map((row) =>
      headers.map((h) => {
        let val = row[h];
        if (val == null) return "";
        if (typeof val === "object") val = JSON.stringify(val);
        val = String(val).replace(/"/g, '""');
        return '"' + val + '"';
      }).join(",")
    );
    return headers.join(",") + "\n" + rows.join("\n");
  }

  function download(content, filename, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ── Helpers ────────────────────────────────────────────────
  function esc(str) {
    if (!str) return "";
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  function truncate(str, len) {
    if (!str) return "";
    return str.length > len ? str.slice(0, len) + "..." : str;
  }

  function formatDate(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    return d.toLocaleDateString() + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function formatTime(iso) {
    if (!iso) return "";
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  function formatDuration(start, end) {
    if (!start || !end) return "—";
    const ms = new Date(end) - new Date(start);
    const mins = Math.floor(ms / 60000);
    const secs = Math.floor((ms % 60000) / 1000);
    if (mins > 0) return mins + "m " + secs + "s";
    return secs + "s";
  }

  // ── Start ──────────────────────────────────────────────────
  document.addEventListener("DOMContentLoaded", init);
})();
