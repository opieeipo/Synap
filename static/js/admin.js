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

  // ── Config Builder ───────────────────────────────────────────
  let questionCounter = 0;
  let branchCounter = 0;
  let themeCounter = 0;

  function initBuilder() {
    $("#b-add-question").addEventListener("click", () => addQuestion());
    $("#b-add-branch").addEventListener("click", () => addBranch());
    $("#b-add-theme").addEventListener("click", () => addTheme());
    $("#builder-download").addEventListener("click", downloadConfig);
    $("#builder-preview").addEventListener("click", togglePreview);
    $("#builder-close-preview").addEventListener("click", togglePreview);
    $("#builder-load").addEventListener("change", loadConfigFile);
  }

  // ── Question management ────────────────────────────────────
  function addQuestion(data) {
    questionCounter++;
    const idx = questionCounter;
    const list = $("#b-questions-list");

    const item = document.createElement("div");
    item.className = "builder-item";
    item.dataset.qIdx = idx;
    item.innerHTML =
      '<div class="builder-item-header">' +
        '<span class="item-label">Question ' + idx + '</span>' +
        '<div class="item-actions">' +
          '<button class="btn-icon" title="Move up" data-action="move-up">&uarr;</button>' +
          '<button class="btn-icon" title="Move down" data-action="move-down">&darr;</button>' +
          '<button class="btn-icon btn-icon-danger" title="Remove" data-action="remove">&times;</button>' +
        '</div>' +
      '</div>' +
      '<div class="field-row">' +
        '<div class="field"><label>ID</label><input type="text" class="q-id" placeholder="q' + idx + '" value="' + esc(data?.id || "q" + idx) + '"></div>' +
        '<div class="field"><label>Topic</label><input type="text" class="q-topic" placeholder="Topic name" value="' + esc(data?.topic || "") + '"></div>' +
      '</div>' +
      '<div class="field"><label>Question Text</label><textarea class="q-text" rows="2" placeholder="The main question to ask...">' + esc(data?.text || "") + '</textarea></div>' +
      '<div class="field"><label>Probes</label><div class="probes-list"></div>' +
        '<button class="btn btn-small btn-secondary add-probe-btn" type="button">+ Add Probe</button>' +
      '</div>';

    list.appendChild(item);

    // Wire up actions
    item.querySelector('[data-action="remove"]').addEventListener("click", () => {
      item.remove();
      renumberQuestions();
    });
    item.querySelector('[data-action="move-up"]').addEventListener("click", () => {
      const prev = item.previousElementSibling;
      if (prev) { list.insertBefore(item, prev); renumberQuestions(); }
    });
    item.querySelector('[data-action="move-down"]').addEventListener("click", () => {
      const next = item.nextElementSibling;
      if (next) { list.insertBefore(next, item); renumberQuestions(); }
    });
    item.querySelector(".add-probe-btn").addEventListener("click", () => {
      addProbe(item.querySelector(".probes-list"), "");
    });

    // Add existing probes
    if (data?.probes) {
      data.probes.forEach((p) => addProbe(item.querySelector(".probes-list"), p));
    }

    return item;
  }

  function addProbe(container, value) {
    const row = document.createElement("div");
    row.className = "probe-row";
    row.innerHTML =
      '<input type="text" class="probe-input" placeholder="Follow-up probe..." value="' + esc(value) + '">' +
      '<button class="btn-icon btn-icon-danger" title="Remove">&times;</button>';
    row.querySelector(".btn-icon").addEventListener("click", () => row.remove());
    container.appendChild(row);
  }

  function renumberQuestions() {
    const items = $$("#b-questions-list .builder-item");
    items.forEach((item, i) => {
      item.querySelector(".item-label").textContent = "Question " + (i + 1);
    });
  }

  // ── Branching management ───────────────────────────────────
  function addBranch(data) {
    branchCounter++;
    const list = $("#b-branching-list");

    const item = document.createElement("div");
    item.className = "builder-item";
    item.innerHTML =
      '<div class="builder-item-header">' +
        '<span class="item-label">Rule ' + branchCounter + '</span>' +
        '<div class="item-actions">' +
          '<button class="btn-icon btn-icon-danger" title="Remove" data-action="remove">&times;</button>' +
        '</div>' +
      '</div>' +
      '<div class="field-row">' +
        '<div class="field"><label>After Question ID</label><input type="text" class="br-after" placeholder="q2" value="' + esc(data?.trigger?.after || "") + '"></div>' +
        '<div class="field"><label>If Themes (comma-separated)</label><input type="text" class="br-themes" placeholder="conflict, dysfunction" value="' + esc(data?.trigger?.if_themes?.join(", ") || "") + '"></div>' +
      '</div>' +
      '<div class="field-row">' +
        '<div class="field"><label>Follow-up ID</label><input type="text" class="br-fu-id" placeholder="q2a" value="' + esc(data?.follow_up?.id || "") + '"></div>' +
        '<div class="field"><label>Follow-up Topic</label><input type="text" class="br-fu-topic" placeholder="Conflict Resolution" value="' + esc(data?.follow_up?.topic || "") + '"></div>' +
      '</div>' +
      '<div class="field"><label>Follow-up Question</label><textarea class="br-fu-text" rows="2" placeholder="Follow-up question text...">' + esc(data?.follow_up?.text || "") + '</textarea></div>' +
      '<div class="field"><label>Follow-up Probes (comma-separated)</label><input type="text" class="br-fu-probes" placeholder="Who steps in?, How do you feel?" value="' + esc(data?.follow_up?.probes?.join(", ") || "") + '"></div>';

    list.appendChild(item);
    item.querySelector('[data-action="remove"]').addEventListener("click", () => item.remove());
  }

  // ── Theme management ───────────────────────────────────────
  function addTheme(data) {
    themeCounter++;
    const list = $("#b-themes-list");

    const item = document.createElement("div");
    item.className = "builder-item";
    item.innerHTML =
      '<div class="builder-item-header">' +
        '<span class="item-label">Theme ' + themeCounter + '</span>' +
        '<div class="item-actions">' +
          '<button class="btn-icon btn-icon-danger" title="Remove" data-action="remove">&times;</button>' +
        '</div>' +
      '</div>' +
      '<div class="field-row">' +
        '<div class="field"><label>Code</label><input type="text" class="th-code" placeholder="autonomy" value="' + esc(data?.code || "") + '"></div>' +
        '<div class="field"><label>Label</label><input type="text" class="th-label" placeholder="Autonomy & Ownership" value="' + esc(data?.label || "") + '"></div>' +
      '</div>' +
      '<div class="field"><label>Description</label><input type="text" class="th-desc" placeholder="What this theme captures..." value="' + esc(data?.description || "") + '"></div>';

    list.appendChild(item);
    item.querySelector('[data-action="remove"]').addEventListener("click", () => item.remove());
  }

  // ── Build JSON from form ───────────────────────────────────
  function buildConfig() {
    // Questions
    const questions = [];
    $$("#b-questions-list .builder-item").forEach((item) => {
      const probes = [];
      item.querySelectorAll(".probe-input").forEach((inp) => {
        const v = inp.value.trim();
        if (v) probes.push(v);
      });
      questions.push({
        id: item.querySelector(".q-id").value.trim() || "q" + (questions.length + 1),
        topic: item.querySelector(".q-topic").value.trim(),
        text: item.querySelector(".q-text").value.trim(),
        probes: probes.length > 0 ? probes : undefined,
      });
    });

    // Branching
    const branching = [];
    $$("#b-branching-list .builder-item").forEach((item) => {
      const themesStr = item.querySelector(".br-themes").value.trim();
      const probesStr = item.querySelector(".br-fu-probes").value.trim();
      branching.push({
        trigger: {
          after: item.querySelector(".br-after").value.trim(),
          if_themes: themesStr ? themesStr.split(",").map((s) => s.trim()).filter(Boolean) : [],
        },
        follow_up: {
          id: item.querySelector(".br-fu-id").value.trim(),
          topic: item.querySelector(".br-fu-topic").value.trim(),
          text: item.querySelector(".br-fu-text").value.trim(),
          probes: probesStr ? probesStr.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
        },
      });
    });

    // Themes
    const themes = [];
    $$("#b-themes-list .builder-item").forEach((item) => {
      themes.push({
        code: item.querySelector(".th-code").value.trim(),
        label: item.querySelector(".th-label").value.trim(),
        description: item.querySelector(".th-desc").value.trim(),
      });
    });

    const config = {
      id: $("#b-id").value.trim() || "untitled-study",
      title: $("#b-title").value.trim(),
      version: $("#b-version").value.trim() || "1.0",
      description: $("#b-description").value.trim() || undefined,
      irb: {
        disclosure: $("#b-irb-disclosure").value.trim(),
        principal_investigator: $("#b-irb-pi").value.trim() || undefined,
        protocol_number: $("#b-irb-protocol").value.trim() || undefined,
        contact_email: $("#b-irb-email").value.trim() || undefined,
        institution: $("#b-irb-institution").value.trim() || undefined,
      },
      persona: {
        name: $("#b-persona-name").value.trim() || "Synap",
        system_prompt: $("#b-persona-prompt").value.trim(),
        greeting: $("#b-persona-greeting").value.trim(),
      },
      guide: {
        questions: questions,
        branching: branching.length > 0 ? branching : undefined,
        closing: $("#b-closing").value.trim(),
      },
      coding_schema: {
        themes: themes,
      },
      settings: {
        ai_provider: $("#b-provider").value,
        ai_model: $("#b-model").value.trim() || undefined,
        temperature: parseFloat($("#b-temperature").value) || 0.7,
        max_tokens: parseInt($("#b-max-tokens").value) || 1024,
        max_turns: parseInt($("#b-max-turns").value) || 30,
        supabase_url: $("#b-supabase-url").value.trim() || undefined,
        supabase_anon_key: $("#b-supabase-key").value.trim() || undefined,
        endpoint: null,
      },
    };

    // Clean undefined values
    return JSON.parse(JSON.stringify(config));
  }

  // ── Load config file ───────────────────────────────────────
  function loadConfigFile(e) {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function (ev) {
      try {
        const config = JSON.parse(ev.target.result);
        populateForm(config);
      } catch (err) {
        alert("Invalid JSON file: " + err.message);
      }
    };
    reader.readAsText(file);
    // Reset so same file can be loaded again
    e.target.value = "";
  }

  function populateForm(config) {
    // Study info
    $("#b-id").value = config.id || "";
    $("#b-title").value = config.title || "";
    $("#b-version").value = config.version || "1.0";
    $("#b-description").value = config.description || "";

    // IRB
    $("#b-irb-disclosure").value = config.irb?.disclosure || "";
    $("#b-irb-pi").value = config.irb?.principal_investigator || "";
    $("#b-irb-protocol").value = config.irb?.protocol_number || "";
    $("#b-irb-email").value = config.irb?.contact_email || "";
    $("#b-irb-institution").value = config.irb?.institution || "";

    // Persona
    $("#b-persona-name").value = config.persona?.name || "Synap";
    $("#b-persona-prompt").value = config.persona?.system_prompt || "";
    $("#b-persona-greeting").value = config.persona?.greeting || "";

    // Clear and rebuild questions
    $("#b-questions-list").innerHTML = "";
    questionCounter = 0;
    if (config.guide?.questions) {
      config.guide.questions.forEach((q) => addQuestion(q));
    }

    // Closing
    $("#b-closing").value = config.guide?.closing || "";

    // Clear and rebuild branching
    $("#b-branching-list").innerHTML = "";
    branchCounter = 0;
    if (config.guide?.branching) {
      config.guide.branching.forEach((b) => addBranch(b));
    }

    // Clear and rebuild themes
    $("#b-themes-list").innerHTML = "";
    themeCounter = 0;
    if (config.coding_schema?.themes) {
      config.coding_schema.themes.forEach((t) => addTheme(t));
    }

    // Settings
    $("#b-provider").value = config.settings?.ai_provider || "mock";
    $("#b-model").value = config.settings?.ai_model || "";
    $("#b-temperature").value = config.settings?.temperature ?? 0.7;
    $("#b-max-tokens").value = config.settings?.max_tokens || 1024;
    $("#b-max-turns").value = config.settings?.max_turns || 30;
    $("#b-supabase-url").value = config.settings?.supabase_url || "";
    $("#b-supabase-key").value = config.settings?.supabase_anon_key || "";
  }

  // ── Preview / Download ─────────────────────────────────────
  function togglePreview() {
    const panel = $("#builder-preview-panel");
    if (panel.hidden) {
      const config = buildConfig();
      $("#builder-json-output").textContent = JSON.stringify(config, null, 2);
      panel.hidden = false;
    } else {
      panel.hidden = true;
    }
  }

  function downloadConfig() {
    const config = buildConfig();
    const filename = (config.id || "config") + ".json";
    const content = JSON.stringify(config, null, 2);
    download(content, filename, "application/json");
  }

  // ── Start ──────────────────────────────────────────────────
  document.addEventListener("DOMContentLoaded", () => {
    init();
    initBuilder();
  });
})();
