/**
 * Synap — AI Qualitative Research Interviewer
 * Phase 2: Real backend support with Supabase Edge Functions
 */

(function () {
  "use strict";

  // ── State ──────────────────────────────────────────────────
  let config = null;
  let session = null;
  let backendUrl = null; // Base URL for Edge Functions
  let detectedEnv = "public"; // "public" or "corporate"
  let participantProfile = null;

  // ── DOM refs ───────────────────────────────────────────────
  const $ = (sel) => document.querySelector(sel);
  const consentOverlay = $("#consent-overlay");
  const consentTitle = $("#consent-title");
  const consentText = $("#consent-text");
  const consentMeta = $("#consent-meta");
  const consentAccept = $("#consent-accept");
  const consentDecline = $("#consent-decline");
  const declinedScreen = $("#declined-screen");
  const chatContainer = $("#chat-container");
  const chatMessages = $("#chat-messages");
  const chatTopic = $("#chat-topic");
  const chatInput = $("#chat-input");
  const sendBtn = $("#send-btn");
  const inputHint = $("#input-hint");
  const endBtn = $("#end-interview");
  const completeScreen = $("#complete-screen");

  // ── Boot ───────────────────────────────────────────────────
  async function init() {
    const configPath = getConfigPath();
    try {
      const resp = await fetch(configPath);
      if (!resp.ok) throw new Error("Config not found: " + configPath);
      config = await resp.json();
    } catch (err) {
      document.body.innerHTML =
        '<div style="padding:40px;text-align:center;color:#666;">' +
        "<h2>Configuration Error</h2>" +
        "<p>" + escapeHtml(err.message) + "</p></div>";
      return;
    }

    // Resolve backend URL from config or query params
    backendUrl = resolveBackendUrl();

    // Detect environment and enrich identity if corporate
    if (window.SynapIdentity && config.identity) {
      try {
        detectedEnv = await window.SynapIdentity.detect(config.identity);
        if (detectedEnv === "corporate") {
          participantProfile = await window.SynapIdentity.getProfile(config.identity);
        }
      } catch (err) {
        console.warn("[Synap] Identity detection failed:", err);
      }
    }

    showConsent();
  }

  function getConfigPath() {
    const params = new URLSearchParams(window.location.search);
    return params.get("config") || "configs/sample.json";
  }

  function resolveBackendUrl() {
    const params = new URLSearchParams(window.location.search);

    // Priority: explicit endpoint > Azure Functions > Supabase > query params
    if (config.settings.endpoint) {
      return config.settings.endpoint.replace(/\/$/, "");
    }

    // Azure Functions URL
    const azureUrl = params.get("azure_functions_url") || config.settings.azure_functions_url;
    if (azureUrl) {
      return azureUrl.replace(/\/$/, "") + "/api";
    }

    // Supabase
    const supabaseUrl = params.get("supabase_url") || config.settings.supabase_url;
    if (supabaseUrl) {
      return supabaseUrl.replace(/\/$/, "") + "/functions/v1";
    }

    return null;
  }

  function isLiveMode() {
    return config.settings.ai_provider !== "mock" && backendUrl !== null;
  }

  // ── Consent Flow ───────────────────────────────────────────
  function showConsent() {
    consentTitle.textContent = config.title || "";
    consentText.textContent = config.irb.disclosure;

    let meta = "";
    if (config.irb.principal_investigator)
      meta += "PI: " + config.irb.principal_investigator + "<br>";
    if (config.irb.protocol_number)
      meta += "Protocol: " + config.irb.protocol_number + "<br>";
    if (config.irb.contact_email)
      meta += "Contact: " + config.irb.contact_email;
    consentMeta.innerHTML = meta;

    consentAccept.addEventListener("click", onAccept);
    consentDecline.addEventListener("click", onDecline);
  }

  async function onAccept() {
    session = createSession();
    session.events.push({
      type: "consent_accepted",
      timestamp: new Date().toISOString(),
    });

    consentOverlay.hidden = true;
    chatContainer.hidden = false;

    if (isLiveMode()) {
      // Register session with backend
      try {
        setInputEnabled(false);
        showTyping();
        const result = await callBackend("session-start", {
          session_id: session.id,
          interview_config: config,
          participant_profile: participantProfile || undefined,
        });
        hideTyping();
        appendMessage("ai", result.greeting);
        session.messages.push({ role: "ai", text: result.greeting, timestamp: now() });
      } catch (err) {
        hideTyping();
        console.error("[Synap] Failed to start session:", err);
        appendMessage("ai", config.persona.greeting);
        session.messages.push({ role: "ai", text: config.persona.greeting, timestamp: now() });
      }
      setInputEnabled(true);
    } else {
      startInterviewMock();
    }

    bindInputEvents();
    updateTopic();
    chatInput.focus();
  }

  function onDecline() {
    consentOverlay.hidden = true;
    declinedScreen.hidden = false;
  }

  // ── Session ────────────────────────────────────────────────
  function createSession() {
    return {
      id: generateId(),
      config_id: config.id,
      started_at: new Date().toISOString(),
      question_index: 0,
      turn_count: 0,
      messages: [],
      coded_themes: [],
      events: [],
      pending_branch: null,
      interview_ended: false,
    };
  }

  function generateId() {
    return "s_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
  }

  // ── Interview Logic ────────────────────────────────────────
  function startInterviewMock() {
    const greeting = config.persona.greeting;
    appendMessage("ai", greeting);
    session.messages.push({ role: "ai", text: greeting, timestamp: now() });
  }

  function bindInputEvents() {
    chatInput.addEventListener("input", onInputChange);
    chatInput.addEventListener("keydown", onInputKeydown);
    sendBtn.addEventListener("click", onSend);
    endBtn.addEventListener("click", onEndInterview);
  }

  function onInputChange() {
    chatInput.style.height = "auto";
    chatInput.style.height = chatInput.scrollHeight + "px";
    sendBtn.disabled = chatInput.value.trim().length === 0;
  }

  function onInputKeydown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (chatInput.value.trim()) onSend();
    }
  }

  async function onSend() {
    const text = chatInput.value.trim();
    if (!text || session.interview_ended) return;

    // Render user message
    appendMessage("user", text);
    session.messages.push({ role: "user", text: text, timestamp: now() });
    session.turn_count++;

    // Clear input
    chatInput.value = "";
    chatInput.style.height = "auto";
    sendBtn.disabled = true;

    // Check turn limit
    if (config.settings.max_turns && session.turn_count >= config.settings.max_turns) {
      await endInterview("max_turns_reached");
      return;
    }

    // Get AI response
    setInputEnabled(false);
    showTyping();
    try {
      const result = isLiveMode()
        ? await getLiveResponse(text)
        : await mockAIResponse(text);

      hideTyping();
      appendMessage("ai", result.reply);
      session.messages.push({ role: "ai", text: result.reply, timestamp: now() });

      if (result.coded_themes && result.coded_themes.length) {
        session.coded_themes.push({
          turn: session.turn_count,
          themes: result.coded_themes,
        });
      }

      // Handle question advancement
      if (result.next_question_hint === "closing" || result.next_question_hint === "end") {
        // AI signals interview is wrapping up
      } else if (result.advance) {
        advanceQuestion();
      }

      updateTopic();
    } catch (err) {
      hideTyping();
      console.error("[Synap] Response error:", err);
      appendMessage("ai", "I'm sorry, I encountered a technical issue. Could you repeat that?");
    }
    setInputEnabled(true);
    chatInput.focus();
  }

  // ── Live backend ───────────────────────────────────────────
  async function getLiveResponse(userMessage) {
    return callBackend("chat", {
      session_id: session.id,
      message: userMessage,
      interview_config_id: config.id,
    });
  }

  async function callBackend(fn, body) {
    const url = backendUrl + "/" + fn;
    const headers = { "Content-Type": "application/json" };

    // Add Supabase anon key if available
    const anonKey = config.settings.supabase_anon_key ||
      new URLSearchParams(window.location.search).get("supabase_anon_key");
    if (anonKey) {
      headers["Authorization"] = "Bearer " + anonKey;
      headers["apikey"] = anonKey;
    }

    const resp = await fetch(url, {
      method: "POST",
      headers: headers,
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error("Backend error " + resp.status + ": " + errText);
    }

    return resp.json();
  }

  // ── Mock mode (Phase 1 fallback) ──────────────────────────
  function mockAIResponse(userMessage) {
    return new Promise((resolve) => {
      const q = getCurrentQuestion();
      const questions = config.guide.questions;
      const isLast = session.question_index >= questions.length - 1 && !session.pending_branch;

      const detectedThemes = detectThemesMock(userMessage);

      let reply;
      if (isLast) {
        reply = "That's a really insightful perspective, thank you for sharing that. " + config.guide.closing;
        resolve({
          reply: reply,
          coded_themes: detectedThemes,
          next_question_hint: "end",
          advance: false,
        });
        session.interview_ended = true;
        session.events.push({ type: "interview_ended", reason: "guide_complete", timestamp: now() });
        return;
      }

      const openers = [
        "Thank you for sharing that.",
        "That's really helpful context.",
        "I appreciate you being so open about that.",
        "That makes a lot of sense.",
        "I hear you on that.",
      ];
      const opener = openers[session.turn_count % openers.length];

      const shouldProbe = Math.random() < 0.35 && q && q.probes && q.probes.length > 0;
      if (shouldProbe) {
        const probeIdx = Math.min(session.turn_count % q.probes.length, q.probes.length - 1);
        reply = opener + " " + q.probes[probeIdx];
        resolve({
          reply: reply,
          coded_themes: detectedThemes,
          next_question_hint: q.id,
          advance: false,
        });
      } else {
        const nextIdx = Math.min(session.question_index + 1, questions.length - 1);
        const nextQ = questions[nextIdx];
        reply = opener + " " + nextQ.text;
        resolve({
          reply: reply,
          coded_themes: detectedThemes,
          next_question_hint: nextQ.id,
          advance: true,
        });
      }
    });
  }

  function detectThemesMock(text) {
    if (!config.coding_schema || !config.coding_schema.themes) return [];
    const lower = text.toLowerCase();
    const detected = [];
    const keywords = {
      autonomy: ["autonomy", "freedom", "ownership", "independent", "my own"],
      collaboration: ["team", "together", "collaborate", "group", "we all"],
      conflict: ["conflict", "disagree", "argue", "tension", "clash", "friction"],
      dysfunction: ["broken", "waste", "bureaucracy", "frustrat", "slow", "inefficient"],
      growth: ["learn", "grow", "develop", "career", "mentor", "opportunity"],
      stagnation: ["stuck", "stagnant", "plateau", "ceiling", "nowhere", "dead end"],
      frustration: ["frustrat", "annoy", "hate", "terrible", "worst", "ugh"],
      pride: ["proud", "love", "meaningful", "purpose", "passion", "rewarding"],
      trust: ["trust", "transparent", "honest", "faith", "rely", "dependable"],
      tooling: ["tool", "software", "system", "platform", "app", "process"],
    };

    for (const theme of config.coding_schema.themes) {
      const kws = keywords[theme.code] || [];
      if (kws.some((kw) => lower.includes(kw))) {
        detected.push({ code: theme.code, label: theme.label });
      }
    }
    return detected;
  }

  // ── Question tracking ──────────────────────────────────────
  function advanceQuestion() {
    if (session.pending_branch) {
      session.pending_branch = null;
      return;
    }

    const questions = config.guide.questions;
    const currentQ = questions[session.question_index];

    if (config.guide.branching) {
      for (const rule of config.guide.branching) {
        if (rule.trigger.after === currentQ.id) {
          const lastThemes = session.coded_themes[session.coded_themes.length - 1];
          if (lastThemes) {
            const themeCodes = lastThemes.themes.map((t) => t.code || t);
            const match = rule.trigger.if_themes.some((t) => themeCodes.includes(t));
            if (match) {
              session.pending_branch = rule.follow_up;
              return;
            }
          }
        }
      }
    }

    if (session.question_index < questions.length - 1) {
      session.question_index++;
    }
  }

  function getCurrentQuestion() {
    if (session.pending_branch) return session.pending_branch;
    return config.guide.questions[session.question_index] || null;
  }

  function updateTopic() {
    const q = getCurrentQuestion();
    chatTopic.textContent = q ? q.topic : "";
  }

  // ── End interview ──────────────────────────────────────────
  async function onEndInterview() {
    await endInterview("participant_ended");
  }

  async function endInterview(reason) {
    session.interview_ended = true;
    session.events.push({ type: "interview_ended", reason: reason, timestamp: now() });

    const closing = config.guide.closing;
    appendMessage("ai", closing);
    session.messages.push({ role: "ai", text: closing, timestamp: now() });

    setInputEnabled(false);

    // Notify backend if live
    if (isLiveMode()) {
      try {
        await callBackend("session-end", {
          session_id: session.id,
          reason: reason,
        });
      } catch (err) {
        console.error("[Synap] Failed to end session on backend:", err);
      }
    }

    // Log session to console (useful for debugging in any mode)
    console.log("[Synap] Session complete:", JSON.stringify(session, null, 2));

    await delay(2000);
    chatContainer.hidden = true;
    completeScreen.hidden = false;
  }

  // ── UI Helpers ─────────────────────────────────────────────
  function appendMessage(role, text) {
    const msg = document.createElement("div");
    msg.className = "message message-" + role;

    const bubble = document.createElement("div");
    bubble.className = "message-bubble";
    bubble.textContent = text;

    const time = document.createElement("div");
    time.className = "message-time";
    time.textContent = formatTime(new Date());

    msg.appendChild(bubble);
    msg.appendChild(time);
    chatMessages.appendChild(msg);
    scrollToBottom();
  }

  function showTyping() {
    const el = document.createElement("div");
    el.className = "typing-indicator";
    el.id = "typing";
    el.innerHTML =
      '<div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div>';
    chatMessages.appendChild(el);
    scrollToBottom();
  }

  function hideTyping() {
    const el = document.getElementById("typing");
    if (el) el.remove();
  }

  function setInputEnabled(enabled) {
    chatInput.disabled = !enabled;
    sendBtn.disabled = !enabled;
    if (enabled) {
      inputHint.textContent = "Press Enter to send, Shift+Enter for new line";
    } else {
      inputHint.textContent = "Waiting for response...";
    }
  }

  function scrollToBottom() {
    requestAnimationFrame(() => {
      chatMessages.scrollTop = chatMessages.scrollHeight;
    });
  }

  function formatTime(date) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  function now() {
    return new Date().toISOString();
  }

  function delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  // ── Start ──────────────────────────────────────────────────
  document.addEventListener("DOMContentLoaded", init);
})();
