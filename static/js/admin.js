/**
 * Synap Admin — Researcher Dashboard
 * Auth via Supabase Auth (public) or MSAL/Okta (corporate).
 * Study-scoped queries via RLS.
 */

(function () {
  "use strict";

  // ── State ──────────────────────────────────────────────────
  let adminConfig = null;     // from admin-config.json
  let sbUrl = "";
  let sbAnonKey = "";
  let authToken = "";         // JWT from Supabase Auth
  let currentUser = null;     // { id, email, display_name, role }
  let accessibleStudies = []; // [{ config_id, access_level }]
  let selectedStudy = "";     // config_id or "" for all
  let currentView = "sessions";

  // ── DOM refs ───────────────────────────────────────────────
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const loginScreen = $("#login-screen");
  const loginForm = $("#login-form");
  const loginError = $("#login-error");
  const loginEmail = $("#login-email");
  const loginPassword = $("#login-password");
  const ssoSection = $("#sso-section");
  const ssoBtn = $("#sso-btn");
  const studyPicker = $("#study-picker");
  const pickerStudies = $("#picker-studies");
  const pickerEmpty = $("#picker-empty");
  const pickerUserName = $("#picker-user-name");
  const pickerLogout = $("#picker-logout");
  const pickerAllBtn = $("#picker-all-studies");
  const dashboard = $("#dashboard");
  const studySwitcher = $("#study-switcher");
  const sidebarUser = $("#sidebar-user");
  const logoutBtn = $("#logout-btn");

  // ── Boot ───────────────────────────────────────────────────
  async function init() {
    // Load admin config
    try {
      const resp = await fetch("admin-config.json");
      if (resp.ok) {
        adminConfig = await resp.json();
        sbUrl = adminConfig.supabase_url || "";
        sbAnonKey = adminConfig.supabase_anon_key || "";
      }
    } catch {
      // No admin config — show login with URL fields? For now, fail gracefully.
    }

    if (!sbUrl || !sbAnonKey) {
      showError("admin-config.json is missing or incomplete. Set supabase_url and supabase_anon_key.");
      return;
    }

    // Check for corporate SSO option
    if (adminConfig?.corporate?.enabled) {
      ssoSection.hidden = false;
      ssoBtn.addEventListener("click", onSSOLogin);
    }

    // Check for existing session
    const savedSession = localStorage.getItem("synap_admin_session");
    if (savedSession) {
      try {
        const parsed = JSON.parse(savedSession);
        // Refresh the token
        const refreshResult = await refreshSession(parsed.refresh_token);
        if (refreshResult) {
          authToken = refreshResult.access_token;
          currentUser = refreshResult.user;
          await loadAccessAndShowPicker();
          return;
        }
      } catch {
        localStorage.removeItem("synap_admin_session");
      }
    }

    // Wire up events
    loginForm.addEventListener("submit", onLogin);
    pickerLogout.addEventListener("click", onLogout);
    pickerAllBtn.addEventListener("click", () => enterDashboard(""));
    logoutBtn.addEventListener("click", onLogout);

    // Nav links
    $$(".nav-link").forEach((link) => {
      link.addEventListener("click", (e) => {
        e.preventDefault();
        switchView(link.dataset.view);
      });
    });

    // Study switcher
    studySwitcher.addEventListener("change", () => {
      selectedStudy = studySwitcher.value;
      refreshCurrentView();
    });

    // Back button in transcript
    $("#back-to-sessions").addEventListener("click", () => {
      $("#view-transcript").hidden = true;
      $("#view-sessions").hidden = false;
    });

    // Refresh buttons
    $("#refresh-sessions").addEventListener("click", loadSessions);
    $("#refresh-themes").addEventListener("click", loadThemes);
    $("#refresh-users").addEventListener("click", loadUsers);

    // User management
    $("#invite-user-btn").addEventListener("click", () => { $("#invite-modal").hidden = false; });
    $("#invite-cancel").addEventListener("click", () => { $("#invite-modal").hidden = true; $("#invite-error").hidden = true; $("#invite-success").hidden = true; });
    $("#invite-send").addEventListener("click", onInviteUser);
    $("#access-close").addEventListener("click", () => { $("#access-panel").hidden = true; });
    $("#access-grant").addEventListener("click", onGrantAccess);

    // Filters
    $("#filter-status").addEventListener("change", loadSessions);

    // Export buttons
    $$("[data-export]").forEach((btn) => {
      btn.addEventListener("click", () => exportData(btn.dataset.export, btn.dataset.format));
    });

    // Builder
    initBuilder();
  }

  // ── Auth: Supabase ─────────────────────────────────────────
  async function onLogin(e) {
    e.preventDefault();
    loginError.hidden = true;

    const email = loginEmail.value.trim();
    const password = loginPassword.value;

    try {
      const resp = await fetch(sbUrl + "/auth/v1/token?grant_type=password", {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: sbAnonKey },
        body: JSON.stringify({ email, password }),
      });

      if (!resp.ok) {
        const err = await resp.json();
        throw new Error(err.error_description || err.msg || "Login failed");
      }

      const data = await resp.json();
      authToken = data.access_token;
      currentUser = {
        id: data.user.id,
        email: data.user.email,
        display_name: data.user.user_metadata?.display_name || data.user.email,
      };

      // Save refresh token
      localStorage.setItem("synap_admin_session", JSON.stringify({
        refresh_token: data.refresh_token,
      }));

      await loadAccessAndShowPicker();
    } catch (err) {
      loginError.textContent = err.message;
      loginError.hidden = false;
    }
  }

  async function refreshSession(refreshToken) {
    try {
      const resp = await fetch(sbUrl + "/auth/v1/token?grant_type=refresh_token", {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: sbAnonKey },
        body: JSON.stringify({ refresh_token: refreshToken }),
      });
      if (!resp.ok) return null;
      const data = await resp.json();

      localStorage.setItem("synap_admin_session", JSON.stringify({
        refresh_token: data.refresh_token,
      }));

      return {
        access_token: data.access_token,
        user: {
          id: data.user.id,
          email: data.user.email,
          display_name: data.user.user_metadata?.display_name || data.user.email,
        },
      };
    } catch {
      return null;
    }
  }

  // ── Auth: Corporate SSO ────────────────────────────────────
  async function onSSOLogin() {
    // TODO: Implement MSAL popup login, exchange token for Supabase session
    // For now, show a message
    loginError.textContent = "Corporate SSO is configured but not yet connected. Contact your admin.";
    loginError.hidden = false;
  }

  function onLogout() {
    localStorage.removeItem("synap_admin_session");
    authToken = "";
    currentUser = null;
    accessibleStudies = [];
    selectedStudy = "";
    dashboard.hidden = true;
    studyPicker.hidden = true;
    loginScreen.hidden = false;
    loginEmail.value = "";
    loginPassword.value = "";
  }

  // ── Study Access ───────────────────────────────────────────
  async function loadAccessAndShowPicker() {
    // Load researcher profile
    try {
      const { data: researchers } = await query("researchers", { select: "id,role,display_name" });
      console.log("[Admin] Researcher profile:", researchers);
      if (researchers && researchers.length > 0) {
        currentUser.role = researchers[0].role;
        currentUser.display_name = researchers[0].display_name || currentUser.email;
      }
    } catch (err) {
      console.warn("[Admin] Failed to load researcher profile:", err);
    }

    console.log("[Admin] Current user role:", currentUser.role);

    // Load accessible studies from study_access
    try {
      const { data: access } = await query("study_access", { select: "config_id,access_level" });
      console.log("[Admin] Study access:", access);
      accessibleStudies = access || [];
    } catch (err) {
      console.warn("[Admin] Failed to load study access:", err);
      accessibleStudies = [];
    }

    // If admin, also get all unique config_ids from sessions
    if (currentUser.role === "admin") {
      try {
        const { data: sessions } = await query("sessions", { select: "config_id" });
        console.log("[Admin] Admin sessions query:", sessions);
        const allConfigs = [...new Set((sessions || []).map((s) => s.config_id))];
        for (const cid of allConfigs) {
          if (!accessibleStudies.find((a) => a.config_id === cid)) {
            accessibleStudies.push({ config_id: cid, access_level: "admin" });
          }
        }
      } catch (err) {
        console.warn("[Admin] Failed to load sessions for admin:", err);
      }
    }

    console.log("[Admin] Final accessible studies:", accessibleStudies);

    showStudyPicker();
  }

  function showStudyPicker() {
    loginScreen.hidden = true;
    studyPicker.hidden = false;
    pickerUserName.textContent = currentUser.display_name || currentUser.email;

    pickerStudies.innerHTML = "";
    pickerEmpty.hidden = true;

    if (accessibleStudies.length === 0) {
      pickerEmpty.hidden = false;
      pickerAllBtn.hidden = true;
      return;
    }

    pickerAllBtn.hidden = accessibleStudies.length <= 1;

    accessibleStudies.forEach((study) => {
      const div = document.createElement("div");
      div.className = "picker-study";
      div.innerHTML =
        '<div><div class="picker-study-name">' + esc(study.config_id) + '</div></div>' +
        '<div class="picker-study-access">' + esc(study.access_level) + '</div>';
      div.addEventListener("click", () => enterDashboard(study.config_id));
      pickerStudies.appendChild(div);
    });
  }

  function enterDashboard(configId) {
    selectedStudy = configId;
    studyPicker.hidden = true;
    dashboard.hidden = false;

    // Populate study switcher
    studySwitcher.innerHTML = '<option value="">All My Studies</option>';
    accessibleStudies.forEach((s) => {
      const opt = document.createElement("option");
      opt.value = s.config_id;
      opt.textContent = s.config_id;
      studySwitcher.appendChild(opt);
    });
    studySwitcher.value = selectedStudy;

    sidebarUser.textContent = currentUser.display_name || currentUser.email;

    // Show Users nav for admins
    if (currentUser.role === "admin") {
      $("#nav-users").hidden = false;
    }

    loadSessions();
  }

  // ── Supabase REST helper ───────────────────────────────────
  async function query(table, params) {
    const qs = new URLSearchParams(params || {});
    const resp = await fetch(sbUrl + "/rest/v1/" + table + "?" + qs.toString(), {
      headers: {
        apikey: sbAnonKey,
        Authorization: "Bearer " + authToken,
        Prefer: "count=exact",
      },
    });
    if (!resp.ok) throw new Error("Query failed: " + resp.status);
    const data = await resp.json();
    return { data };
  }

  // ── Navigation ─────────────────────────────────────────────
  function switchView(view) {
    currentView = view;
    $$(".nav-link").forEach((l) => l.classList.toggle("active", l.dataset.view === view));
    $$(".view").forEach((v) => (v.hidden = true));
    $("#view-" + view).hidden = false;

    if (view === "sessions") loadSessions();
    if (view === "themes") loadThemes();
    if (view === "users") loadUsers();
  }

  function refreshCurrentView() {
    if (currentView === "sessions") loadSessions();
    if (currentView === "themes") loadThemes();
  }

  // ── Sessions View ──────────────────────────────────────────
  async function loadSessions() {
    const body = $("#sessions-body");
    const empty = $("#sessions-empty");
    body.innerHTML = "";
    empty.hidden = true;

    try {
      const params = {
        select: "id,config_id,status,turn_count,started_at,ended_at,config_snapshot",
        order: "started_at.desc",
        limit: "100",
      };

      if (selectedStudy) params["config_id"] = "eq." + selectedStudy;
      const statusFilter = $("#filter-status").value;
      if (statusFilter) params["status"] = "eq." + statusFilter;

      const { data } = await query("sessions", params);

      if (data.length === 0) {
        empty.hidden = false;
        return;
      }

      data.forEach((s) => {
        // Extract participant info from config_snapshot if available
        const snapshot = s.config_snapshot || {};
        const participantInfo = getParticipantSummary(snapshot);

        const tr = document.createElement("tr");
        tr.innerHTML =
          "<td><code>" + truncate(s.id, 20) + "</code></td>" +
          '<td><span class="badge badge-' + s.status + '">' + s.status + "</span></td>" +
          "<td>" + esc(participantInfo) + "</td>" +
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

  function getParticipantSummary(snapshot) {
    // Try to find participant_profile in the session
    // This would be stored at session level, not config_snapshot
    return "—";
  }

  // ── Transcript View ────────────────────────────────────────
  async function openTranscript(sessionId, sessionMeta) {
    $("#view-sessions").hidden = true;
    const view = $("#view-transcript");
    view.hidden = false;

    $("#transcript-title").textContent = "Session: " + truncate(sessionId, 24);

    const meta = $("#transcript-meta");
    meta.innerHTML =
      "<div><strong>Study:</strong> " + esc(sessionMeta.config_id) + "</div>" +
      "<div><strong>Status:</strong> " + sessionMeta.status + "</div>" +
      "<div><strong>Turns:</strong> " + sessionMeta.turn_count + "</div>" +
      "<div><strong>Started:</strong> " + formatDate(sessionMeta.started_at) + "</div>" +
      "<div><strong>Duration:</strong> " + formatDuration(sessionMeta.started_at, sessionMeta.ended_at) + "</div>";

    // Check for participant profile
    const profilePanel = $("#transcript-profile");
    const profileData = $("#transcript-profile-data");
    profilePanel.hidden = true;

    // Load full session to get participant_profile
    try {
      const { data: fullSessions } = await query("sessions", {
        select: "participant_profile",
        id: "eq." + sessionId,
      });
      // participant_profile is not in our current schema as a column but could be in metadata
      // For now, check config_snapshot for any profile data
    } catch { /* ignore */ }

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
        const counts = {};
        themes.forEach((t) => {
          if (!counts[t.theme_code]) counts[t.theme_code] = { label: t.theme_label || t.theme_code, count: 0 };
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
      const params = { select: "theme_code,theme_label,confidence,session_id" };

      if (selectedStudy) {
        const { data: sessions } = await query("sessions", { select: "id", config_id: "eq." + selectedStudy });
        const ids = sessions.map((s) => s.id);
        if (ids.length === 0) { empty.hidden = false; return; }
        params["session_id"] = "in.(" + ids.join(",") + ")";
      }

      const { data: themes } = await query("coded_themes", params);

      if (themes.length === 0) { empty.hidden = false; return; }

      const agg = {};
      themes.forEach((t) => {
        if (!agg[t.theme_code]) agg[t.theme_code] = { label: t.theme_label || t.theme_code, count: 0, sessions: new Set(), totalConf: 0, confCount: 0 };
        agg[t.theme_code].count++;
        agg[t.theme_code].sessions.add(t.session_id);
        if (t.confidence != null) { agg[t.theme_code].totalConf += t.confidence; agg[t.theme_code].confCount++; }
      });

      const uniqueThemes = Object.keys(agg).length;
      const totalOccurrences = themes.length;
      const uniqueSessions = new Set(themes.map((t) => t.session_id)).size;
      summary.innerHTML =
        '<div class="theme-stat"><div class="theme-stat-value">' + uniqueThemes + '</div><div class="theme-stat-label">Unique Themes</div></div>' +
        '<div class="theme-stat"><div class="theme-stat-value">' + totalOccurrences + '</div><div class="theme-stat-label">Total Occurrences</div></div>' +
        '<div class="theme-stat"><div class="theme-stat-value">' + uniqueSessions + '</div><div class="theme-stat-label">Sessions</div></div>';

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

      if (selectedStudy) {
        if (table === "sessions") {
          params["config_id"] = "eq." + selectedStudy;
        } else {
          const { data: sessions } = await query("sessions", { select: "id", config_id: "eq." + selectedStudy });
          const ids = sessions.map((s) => s.id);
          if (ids.length === 0) { alert("No data found for this study."); return; }
          params["session_id"] = "in.(" + ids.join(",") + ")";
        }
      }

      const { data } = await query(table, params);
      if (data.length === 0) { alert("No data to export."); return; }

      let content, mime, ext;
      if (format === "json") {
        content = JSON.stringify(data, null, 2); mime = "application/json"; ext = "json";
      } else {
        content = toCSV(data); mime = "text/csv"; ext = "csv";
      }

      const filename = "synap_" + table + (selectedStudy ? "_" + selectedStudy : "") + "." + ext;
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

  // ── User Management ─────────────────────────────────────────
  let managingUserId = null;

  async function loadUsers() {
    const body = $("#users-body");
    const empty = $("#users-empty");
    body.innerHTML = "";
    empty.hidden = true;

    try {
      // Admins can read all researchers via RLS policy
      const { data: researchers } = await query("researchers", {
        select: "id,email,display_name,role,created_at",
        order: "created_at.desc",
      });

      if (!researchers || researchers.length === 0) {
        empty.hidden = false;
        return;
      }

      // Load all study_access to count per researcher
      const { data: allAccess } = await query("study_access", { select: "researcher_id,config_id,access_level" });
      const accessMap = {};
      (allAccess || []).forEach((a) => {
        if (!accessMap[a.researcher_id]) accessMap[a.researcher_id] = [];
        accessMap[a.researcher_id].push(a);
      });

      researchers.forEach((r) => {
        const studyCount = (accessMap[r.id] || []).length;
        const tr = document.createElement("tr");
        tr.innerHTML =
          "<td>" + esc(r.display_name || "—") + "</td>" +
          "<td><code>" + esc(r.email) + "</code></td>" +
          '<td><span class="badge badge-' + (r.role === "admin" ? "active" : "completed") + '">' + r.role + "</span></td>" +
          "<td>" + studyCount + " " + (studyCount === 1 ? "study" : "studies") + "</td>" +
          "<td>" + formatDate(r.created_at) + "</td>" +
          '<td><div style="display:flex;gap:4px;"><button class="btn btn-small btn-secondary manage-access-btn">Access</button><button class="btn btn-small btn-secondary toggle-role-btn">' + (r.role === "admin" ? "Make Researcher" : "Make Admin") + "</button></div></td>";

        tr.querySelector(".manage-access-btn").addEventListener("click", () => openAccessPanel(r, accessMap[r.id] || []));
        tr.querySelector(".toggle-role-btn").addEventListener("click", () => toggleRole(r));
        body.appendChild(tr);
      });
    } catch (err) {
      empty.textContent = "Error loading users: " + err.message;
      empty.hidden = false;
    }
  }

  async function onInviteUser() {
    const email = $("#invite-email").value.trim();
    const displayName = $("#invite-name").value.trim();
    const role = $("#invite-role").value;
    const errorEl = $("#invite-error");
    const successEl = $("#invite-success");
    errorEl.hidden = true;
    successEl.hidden = true;

    if (!email) { errorEl.textContent = "Email is required"; errorEl.hidden = false; return; }

    try {
      const resp = await fetch(sbUrl + "/functions/v1/invite-user", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: sbAnonKey,
          Authorization: "Bearer " + authToken,
        },
        body: JSON.stringify({ email, display_name: displayName, role }),
      });

      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || "Invite failed");

      successEl.textContent = data.message || "Invite sent!";
      successEl.hidden = false;
      $("#invite-email").value = "";
      $("#invite-name").value = "";

      // Refresh the list
      loadUsers();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    }
  }

  async function toggleRole(researcher) {
    const newRole = researcher.role === "admin" ? "researcher" : "admin";
    try {
      // Use PostgREST PATCH
      const resp = await fetch(sbUrl + "/rest/v1/researchers?id=eq." + researcher.id, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          apikey: sbAnonKey,
          Authorization: "Bearer " + authToken,
          Prefer: "return=minimal",
        },
        body: JSON.stringify({ role: newRole }),
      });
      if (!resp.ok) throw new Error("Failed to update role");
      loadUsers();
    } catch (err) {
      alert("Error: " + err.message);
    }
  }

  function openAccessPanel(researcher, currentAccess) {
    managingUserId = researcher.id;
    const panel = $("#access-panel");
    panel.hidden = false;
    $("#access-user-name").textContent = researcher.display_name || researcher.email;

    const list = $("#access-list");
    list.innerHTML = "";

    if (currentAccess.length === 0) {
      list.innerHTML = '<div class="empty-state" style="padding:12px;">No study access granted.</div>';
    } else {
      currentAccess.forEach((a) => {
        const row = document.createElement("div");
        row.className = "access-row";
        row.innerHTML =
          '<div class="access-row-info"><span class="access-row-study">' + esc(a.config_id) + '</span><span class="access-row-level">' + a.access_level + '</span></div>' +
          '<button class="btn btn-small btn-secondary revoke-btn">Revoke</button>';
        row.querySelector(".revoke-btn").addEventListener("click", () => revokeAccess(a.researcher_id, a.config_id));
        list.appendChild(row);
      });
    }
  }

  async function onGrantAccess() {
    if (!managingUserId) return;
    const configId = $("#access-config-id").value.trim();
    const level = $("#access-level").value;
    if (!configId) { alert("Study ID is required"); return; }

    try {
      const resp = await fetch(sbUrl + "/rest/v1/study_access", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: sbAnonKey,
          Authorization: "Bearer " + authToken,
          Prefer: "return=minimal",
        },
        body: JSON.stringify({ researcher_id: managingUserId, config_id: configId, access_level: level }),
      });
      if (!resp.ok) {
        const err = await resp.text();
        throw new Error(err);
      }
      $("#access-config-id").value = "";
      // Reload both users and access panel
      loadUsers();
      // Re-fetch access for this user
      const { data: updatedAccess } = await query("study_access", {
        select: "researcher_id,config_id,access_level",
        researcher_id: "eq." + managingUserId,
      });
      openAccessPanel(
        { id: managingUserId, display_name: $("#access-user-name").textContent },
        updatedAccess || []
      );
    } catch (err) {
      alert("Error granting access: " + err.message);
    }
  }

  async function revokeAccess(researcherId, configId) {
    try {
      const resp = await fetch(
        sbUrl + "/rest/v1/study_access?researcher_id=eq." + researcherId + "&config_id=eq." + encodeURIComponent(configId),
        {
          method: "DELETE",
          headers: {
            apikey: sbAnonKey,
            Authorization: "Bearer " + authToken,
          },
        }
      );
      if (!resp.ok) throw new Error("Failed to revoke access");
      loadUsers();
      // Refresh access panel
      const { data: updatedAccess } = await query("study_access", {
        select: "researcher_id,config_id,access_level",
        researcher_id: "eq." + researcherId,
      });
      openAccessPanel(
        { id: researcherId, display_name: $("#access-user-name").textContent },
        updatedAccess || []
      );
    } catch (err) {
      alert("Error: " + err.message);
    }
  }

  // ── Config Builder ─────────────────────────────────────────
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

  function addQuestion(data) {
    questionCounter++;
    const idx = questionCounter;
    const list = $("#b-questions-list");

    const item = document.createElement("div");
    item.className = "builder-item";
    item.dataset.qIdx = idx;
    item.innerHTML =
      '<div class="builder-item-header"><span class="item-label">Question ' + idx + '</span><div class="item-actions"><button class="btn-icon" title="Move up" data-action="move-up">&uarr;</button><button class="btn-icon" title="Move down" data-action="move-down">&darr;</button><button class="btn-icon btn-icon-danger" title="Remove" data-action="remove">&times;</button></div></div>' +
      '<div class="field-row"><div class="field"><label>ID</label><input type="text" class="q-id" placeholder="q' + idx + '" value="' + esc(data?.id || "q" + idx) + '"></div><div class="field"><label>Topic</label><input type="text" class="q-topic" placeholder="Topic name" value="' + esc(data?.topic || "") + '"></div></div>' +
      '<div class="field"><label>Question Text</label><textarea class="q-text" rows="2" placeholder="The main question to ask...">' + esc(data?.text || "") + '</textarea></div>' +
      '<div class="field"><label>Probes</label><div class="probes-list"></div><button class="btn btn-small btn-secondary add-probe-btn" type="button">+ Add Probe</button></div>';

    list.appendChild(item);
    item.querySelector('[data-action="remove"]').addEventListener("click", () => { item.remove(); renumberQuestions(); });
    item.querySelector('[data-action="move-up"]').addEventListener("click", () => { const prev = item.previousElementSibling; if (prev) { list.insertBefore(item, prev); renumberQuestions(); } });
    item.querySelector('[data-action="move-down"]').addEventListener("click", () => { const next = item.nextElementSibling; if (next) { list.insertBefore(next, item); renumberQuestions(); } });
    item.querySelector(".add-probe-btn").addEventListener("click", () => addProbe(item.querySelector(".probes-list"), ""));
    if (data?.probes) data.probes.forEach((p) => addProbe(item.querySelector(".probes-list"), p));
    return item;
  }

  function addProbe(container, value) {
    const row = document.createElement("div");
    row.className = "probe-row";
    row.innerHTML = '<input type="text" class="probe-input" placeholder="Follow-up probe..." value="' + esc(value) + '"><button class="btn-icon btn-icon-danger" title="Remove">&times;</button>';
    row.querySelector(".btn-icon").addEventListener("click", () => row.remove());
    container.appendChild(row);
  }

  function renumberQuestions() {
    $$("#b-questions-list .builder-item").forEach((item, i) => {
      item.querySelector(".item-label").textContent = "Question " + (i + 1);
    });
  }

  function addBranch(data) {
    branchCounter++;
    const list = $("#b-branching-list");
    const item = document.createElement("div");
    item.className = "builder-item";
    item.innerHTML =
      '<div class="builder-item-header"><span class="item-label">Rule ' + branchCounter + '</span><div class="item-actions"><button class="btn-icon btn-icon-danger" title="Remove" data-action="remove">&times;</button></div></div>' +
      '<div class="field-row"><div class="field"><label>After Question ID</label><input type="text" class="br-after" placeholder="q2" value="' + esc(data?.trigger?.after || "") + '"></div><div class="field"><label>If Themes (comma-separated)</label><input type="text" class="br-themes" placeholder="conflict, dysfunction" value="' + esc(data?.trigger?.if_themes?.join(", ") || "") + '"></div></div>' +
      '<div class="field-row"><div class="field"><label>Follow-up ID</label><input type="text" class="br-fu-id" placeholder="q2a" value="' + esc(data?.follow_up?.id || "") + '"></div><div class="field"><label>Follow-up Topic</label><input type="text" class="br-fu-topic" placeholder="Conflict Resolution" value="' + esc(data?.follow_up?.topic || "") + '"></div></div>' +
      '<div class="field"><label>Follow-up Question</label><textarea class="br-fu-text" rows="2" placeholder="Follow-up question text...">' + esc(data?.follow_up?.text || "") + '</textarea></div>' +
      '<div class="field"><label>Follow-up Probes (comma-separated)</label><input type="text" class="br-fu-probes" placeholder="Who steps in?, How do you feel?" value="' + esc(data?.follow_up?.probes?.join(", ") || "") + '"></div>';
    list.appendChild(item);
    item.querySelector('[data-action="remove"]').addEventListener("click", () => item.remove());
  }

  function addTheme(data) {
    themeCounter++;
    const list = $("#b-themes-list");
    const item = document.createElement("div");
    item.className = "builder-item";
    item.innerHTML =
      '<div class="builder-item-header"><span class="item-label">Theme ' + themeCounter + '</span><div class="item-actions"><button class="btn-icon btn-icon-danger" title="Remove" data-action="remove">&times;</button></div></div>' +
      '<div class="field-row"><div class="field"><label>Code</label><input type="text" class="th-code" placeholder="autonomy" value="' + esc(data?.code || "") + '"></div><div class="field"><label>Label</label><input type="text" class="th-label" placeholder="Autonomy & Ownership" value="' + esc(data?.label || "") + '"></div></div>' +
      '<div class="field"><label>Description</label><input type="text" class="th-desc" placeholder="What this theme captures..." value="' + esc(data?.description || "") + '"></div>';
    list.appendChild(item);
    item.querySelector('[data-action="remove"]').addEventListener("click", () => item.remove());
  }

  function buildConfig() {
    const questions = [];
    $$("#b-questions-list .builder-item").forEach((item) => {
      const probes = [];
      item.querySelectorAll(".probe-input").forEach((inp) => { const v = inp.value.trim(); if (v) probes.push(v); });
      questions.push({ id: item.querySelector(".q-id").value.trim() || "q" + (questions.length + 1), topic: item.querySelector(".q-topic").value.trim(), text: item.querySelector(".q-text").value.trim(), probes: probes.length > 0 ? probes : undefined });
    });

    const branching = [];
    $$("#b-branching-list .builder-item").forEach((item) => {
      const themesStr = item.querySelector(".br-themes").value.trim();
      const probesStr = item.querySelector(".br-fu-probes").value.trim();
      branching.push({ trigger: { after: item.querySelector(".br-after").value.trim(), if_themes: themesStr ? themesStr.split(",").map((s) => s.trim()).filter(Boolean) : [] }, follow_up: { id: item.querySelector(".br-fu-id").value.trim(), topic: item.querySelector(".br-fu-topic").value.trim(), text: item.querySelector(".br-fu-text").value.trim(), probes: probesStr ? probesStr.split(",").map((s) => s.trim()).filter(Boolean) : undefined } });
    });

    const themes = [];
    $$("#b-themes-list .builder-item").forEach((item) => {
      themes.push({ code: item.querySelector(".th-code").value.trim(), label: item.querySelector(".th-label").value.trim(), description: item.querySelector(".th-desc").value.trim() });
    });

    const identityFields = $("#b-identity-fields").value.trim();
    const config = {
      id: $("#b-id").value.trim() || "untitled-study",
      title: $("#b-title").value.trim(),
      version: $("#b-version").value.trim() || "1.0",
      description: $("#b-description").value.trim() || undefined,
      irb: { disclosure: $("#b-irb-disclosure").value.trim(), principal_investigator: $("#b-irb-pi").value.trim() || undefined, protocol_number: $("#b-irb-protocol").value.trim() || undefined, contact_email: $("#b-irb-email").value.trim() || undefined, institution: $("#b-irb-institution").value.trim() || undefined },
      persona: { name: $("#b-persona-name").value.trim() || "Synap", system_prompt: $("#b-persona-prompt").value.trim(), greeting: $("#b-persona-greeting").value.trim() },
      guide: { questions, branching: branching.length > 0 ? branching : undefined, closing: $("#b-closing").value.trim() },
      coding_schema: { themes },
      identity: {
        environment: $("#b-identity-env").value,
        enrich_profile: $("#b-identity-enrich").value === "true",
        profile_fields: identityFields ? identityFields.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
        anonymize: $("#b-identity-anon").value === "true",
        msal_client_id: $("#b-identity-client").value.trim() || undefined,
        msal_authority: $("#b-identity-authority").value.trim() || undefined,
      },
      storage: {
        provider: $("#b-storage-provider").value,
        base_dir: $("#b-storage-basedir").value.trim() || undefined,
      },
      settings: {
        ai_provider: $("#b-provider").value,
        ai_model: $("#b-model").value.trim() || undefined,
        temperature: parseFloat($("#b-temperature").value) || 0.7,
        max_tokens: parseInt($("#b-max-tokens").value) || 1024,
        max_turns: parseInt($("#b-max-turns").value) || 30,
        supabase_url: $("#b-supabase-url").value.trim() || undefined,
        supabase_anon_key: $("#b-supabase-key").value.trim() || undefined,
        azure_functions_url: $("#b-azure-url").value.trim() || undefined,
        endpoint: null,
      },
    };
    return JSON.parse(JSON.stringify(config));
  }

  function loadConfigFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function (ev) {
      try { populateForm(JSON.parse(ev.target.result)); } catch (err) { alert("Invalid JSON: " + err.message); }
    };
    reader.readAsText(file);
    e.target.value = "";
  }

  function populateForm(config) {
    $("#b-id").value = config.id || "";
    $("#b-title").value = config.title || "";
    $("#b-version").value = config.version || "1.0";
    $("#b-description").value = config.description || "";
    $("#b-irb-disclosure").value = config.irb?.disclosure || "";
    $("#b-irb-pi").value = config.irb?.principal_investigator || "";
    $("#b-irb-protocol").value = config.irb?.protocol_number || "";
    $("#b-irb-email").value = config.irb?.contact_email || "";
    $("#b-irb-institution").value = config.irb?.institution || "";
    $("#b-persona-name").value = config.persona?.name || "Synap";
    $("#b-persona-prompt").value = config.persona?.system_prompt || "";
    $("#b-persona-greeting").value = config.persona?.greeting || "";

    $("#b-questions-list").innerHTML = ""; questionCounter = 0;
    if (config.guide?.questions) config.guide.questions.forEach((q) => addQuestion(q));
    $("#b-closing").value = config.guide?.closing || "";

    $("#b-branching-list").innerHTML = ""; branchCounter = 0;
    if (config.guide?.branching) config.guide.branching.forEach((b) => addBranch(b));

    $("#b-themes-list").innerHTML = ""; themeCounter = 0;
    if (config.coding_schema?.themes) config.coding_schema.themes.forEach((t) => addTheme(t));

    // Identity
    $("#b-identity-env").value = config.identity?.environment || "auto";
    $("#b-identity-enrich").value = config.identity?.enrich_profile !== false ? "true" : "false";
    $("#b-identity-anon").value = config.identity?.anonymize ? "true" : "false";
    $("#b-identity-fields").value = (config.identity?.profile_fields || []).join(", ");
    $("#b-identity-client").value = config.identity?.msal_client_id || "";
    $("#b-identity-authority").value = config.identity?.msal_authority || "";

    // Storage
    $("#b-storage-provider").value = config.storage?.provider || "supabase";
    $("#b-storage-basedir").value = config.storage?.base_dir || "./data";

    // Settings
    $("#b-provider").value = config.settings?.ai_provider || "mock";
    $("#b-model").value = config.settings?.ai_model || "";
    $("#b-temperature").value = config.settings?.temperature ?? 0.7;
    $("#b-max-tokens").value = config.settings?.max_tokens || 1024;
    $("#b-max-turns").value = config.settings?.max_turns || 30;
    $("#b-supabase-url").value = config.settings?.supabase_url || "";
    $("#b-supabase-key").value = config.settings?.supabase_anon_key || "";
    $("#b-azure-url").value = config.settings?.azure_functions_url || "";
  }

  function togglePreview() {
    const panel = $("#builder-preview-panel");
    if (panel.hidden) {
      $("#builder-json-output").textContent = JSON.stringify(buildConfig(), null, 2);
      panel.hidden = false;
    } else { panel.hidden = true; }
  }

  function downloadConfig() {
    const config = buildConfig();
    download(JSON.stringify(config, null, 2), (config.id || "config") + ".json", "application/json");
  }

  // ── Helpers ────────────────────────────────────────────────
  function showError(msg) {
    document.body.innerHTML = '<div style="padding:40px;text-align:center;color:#666;"><h2>Configuration Error</h2><p>' + esc(msg) + '</p></div>';
  }

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
