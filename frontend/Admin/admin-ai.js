(function () {
  "use strict";

  const AI_API_BASE = "/api/admin/ai";
  const CHAT_STORAGE_KEY = "cbs_admin_ai_chat_messages";
  const REQUEST_COUNT_KEY = "cbs_admin_ai_request_count";

  const QUICK_ACTION_PROMPTS = {
    income: "Summarise today's income, successful payments, pending payments, failed payments, and any risk areas.",
    "failed-payments": "Analyse failed payments and explain possible causes, affected users, and recommended admin actions.",
    "open-tickets": "Summarise all open support tickets by category, urgency, and next action.",
    "booking-issue": "Analyse current booking issues and explain what admins should check first.",
    "low-stations": "List low availability stations and suggest redistribution or maintenance actions.",
    "bike-repairs": "Summarise current bike repair issues and priority maintenance tasks.",
    "refund-review": "Review pending refunds and recommend which ones need approval, rejection, or investigation.",
    "daily-summary": "Create a short daily admin summary covering revenue, bookings, payments, stations, bikes, maintenance, and support tickets.",
  };

  const EMPTY_PROMPTS = {
    income: "What is today's income?",
    tickets: "Which support tickets need attention?",
    booking: "Why might a booking not show after payment?",
  };

  const state = {
    conversationId: null,
    messages: [],
    tickets: [],
    selectedTicket: null,
    totalRequests: 0,
    loading: false,
    openaiConnected: false,
    model: "gpt-4.1-mini",
    statusLabel: "Local Preview",
  };

  function $(selector, root) {
    return (root || document).querySelector(selector);
  }

  function $$(selector, root) {
    return Array.from((root || document).querySelectorAll(selector));
  }

  function getAdminAuthToken() {
    try {
      return (
        localStorage.getItem("cbs_token") ||
        localStorage.getItem("token") ||
        localStorage.getItem("authToken") ||
        localStorage.getItem("adminToken") ||
        localStorage.getItem("jwt") ||
        ""
      );
    } catch (_) {
      return "";
    }
  }

  function getAdminUser() {
    try {
      const raw = localStorage.getItem("cbs_user") || localStorage.getItem("adminUser") || localStorage.getItem("user");
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  }

  function buildHeaders(extra) {
    const headers = Object.assign({ "Content-Type": "application/json" }, extra || {});
    const token = getAdminAuthToken();
    if (token) headers.Authorization = "Bearer " + token;
    return headers;
  }

  async function apiFetch(path, options) {
    const request = Object.assign({ credentials: "include" }, options || {});
    request.headers = buildHeaders(request.headers);

    const response = await fetch(path, request);
    let data = null;
    try {
      data = await response.json();
    } catch (_) {
      data = null;
    }

    if (!response.ok) {
      throw new Error((data && (data.error || data.message)) || "Request failed");
    }

    return data || {};
  }

  function hydrateIcons(root) {
    if (typeof window.__hydrateAdminIcons !== "function") return;
    try {
      window.__hydrateAdminIcons(root || document);
    } catch (_) {}
  }

  function initials(name) {
    const parts = String(name || "Admin User").trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return "AU";
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  function formatTime(value) {
    try {
      const date = value ? new Date(value) : new Date();
      return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    } catch (_) {
      return "";
    }
  }

  function formatDateTime(value) {
    try {
      if (!value) return "Recently";
      return new Date(value).toLocaleString([], {
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch (_) {
      return "Recently";
    }
  }

  function saveChatHistory() {
    try {
      localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(state.messages.slice(-80)));
      localStorage.setItem(REQUEST_COUNT_KEY, String(state.totalRequests));
    } catch (_) {}
  }

  function loadChatHistory() {
    try {
      const rawMessages = localStorage.getItem(CHAT_STORAGE_KEY);
      const rawCount = localStorage.getItem(REQUEST_COUNT_KEY);
      state.messages = rawMessages ? JSON.parse(rawMessages) : [];
      state.totalRequests = Number(rawCount || 0) || 0;
    } catch (_) {
      state.messages = [];
      state.totalRequests = 0;
    }
  }

  function renderEmptyChat() {
    const body = $("#aai-chat-body");
    if (!body) return;

    body.innerHTML = `
      <div class="aai-empty-chat">
        <div>
          <span class="aai-empty-icon" data-icon="sparkles"></span>
          <strong>How can I help with admin work today?</strong>
          <p>Ask a natural question, or start with one of these common admin checks.</p>
          <div class="aai-empty-chips">
            <button type="button" class="aai-empty-chip" data-empty-prompt="income">Today's income</button>
            <button type="button" class="aai-empty-chip" data-empty-prompt="tickets">Open tickets</button>
            <button type="button" class="aai-empty-chip" data-empty-prompt="booking">Booking issue after payment</button>
          </div>
        </div>
      </div>
    `;
    hydrateIcons(body);
  }

  function renderChatHistory() {
    const body = $("#aai-chat-body");
    if (!body) return;
    body.innerHTML = "";

    if (!state.messages.length) {
      renderEmptyChat();
      return;
    }

    state.messages.forEach((entry) => {
      renderMessage(entry.sender, entry.message, entry.timestamp, entry.source, false);
    });
    scrollChatToBottom(false);
  }

  function sourceLabel(source) {
    if (source === "openai") return "OpenAI";
    if (source === "fallback" || source === "local") return "Local Preview";
    return "";
  }

  function renderMessage(sender, message, timestamp, source, persist) {
    const body = $("#aai-chat-body");
    if (!body) return;

    const empty = body.querySelector(".aai-empty-chat");
    if (empty) empty.remove();

    const user = getAdminUser();
    const row = document.createElement("div");
    row.className = `aai-message ${sender === "admin" ? "admin" : "ai"}`;

    const avatar = document.createElement("div");
    avatar.className = "aai-avatar";
    avatar.textContent = sender === "admin" ? initials(user?.full_name || user?.name || user?.email || "Admin User") : "AI";

    const bubble = document.createElement("div");
    bubble.className = "aai-bubble";

    const text = document.createElement("div");
    text.className = "aai-message-text";
    text.textContent = String(message || "");

    bubble.appendChild(text);

    if (sender !== "admin") {
      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "aai-copy-btn";
      copy.textContent = "Copy";
      copy.dataset.copyMessage = String(message || "");
      bubble.appendChild(copy);
    }

    const meta = document.createElement("div");
    meta.className = "aai-message-meta";

    const time = document.createElement("span");
    time.textContent = formatTime(timestamp);
    meta.appendChild(time);

    const label = sourceLabel(source);
    if (label) {
      const sourceEl = document.createElement("span");
      sourceEl.className = "aai-source-label";
      sourceEl.textContent = label;
      meta.appendChild(sourceEl);
    }

    bubble.appendChild(meta);
    row.appendChild(avatar);
    row.appendChild(bubble);
    body.appendChild(row);

    if (persist !== false) {
      state.messages.push({
        sender,
        message: String(message || ""),
        timestamp: timestamp || new Date().toISOString(),
        source: source || "",
      });
      saveChatHistory();
    }

    scrollChatToBottom(true);
  }

  function scrollChatToBottom(smooth) {
    const body = $("#aai-chat-body");
    if (!body) return;
    requestAnimationFrame(() => {
      body.scrollTo({ top: body.scrollHeight, behavior: smooth === false ? "auto" : "smooth" });
    });
  }

  function showTypingIndicator() {
    const el = $("#aai-typing");
    if (el) el.hidden = false;
    scrollChatToBottom(true);
  }

  function hideTypingIndicator() {
    const el = $("#aai-typing");
    if (el) el.hidden = true;
  }

  function setLoadingState(isLoading) {
    state.loading = Boolean(isLoading);
    const send = $("#aai-send");
    const textarea = $("#aai-chat-text");

    if (send) send.disabled = state.loading;
    if (textarea) textarea.disabled = state.loading;
    $$(".aai-action").forEach((button) => {
      button.disabled = state.loading;
    });
  }

  function showToast(message, type) {
    const toast = $("#admin-toast");
    if (!toast) return;
    toast.textContent = message;
    toast.dataset.type = type || "success";
    toast.hidden = false;
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => {
      toast.hidden = true;
    }, 3200);
  }

  async function checkAIHealth() {
    try {
      const data = await apiFetch(`${AI_API_BASE}/health`, { method: "GET" });
      state.openaiConnected = Boolean(data.openaiConfigured || data.configured || data.mode === "openai");
      state.model = data.model || state.model;
      state.statusLabel = state.openaiConnected ? "OpenAI Connected" : "Local Preview";
      updateAIStatusUI(false);
      return data;
    } catch (error) {
      state.openaiConnected = false;
      state.statusLabel = "AI Status Error";
      updateAIStatusUI(true);
      showToast("Could not check AI status.", "warning");
      return null;
    }
  }

  function updateAIStatusUI(isError) {
    const pill = $("#aai-status-pill");
    const dot = $("#aai-live-dot");
    const insight = $("#aai-insight-status");
    const mode = $("#aai-insight-mode");
    const chatMode = $("#aai-chat-mode");
    const chatModel = $("#aai-chat-model");

    [pill, chatMode].forEach((el) => {
      if (!el) return;
      el.classList.toggle("connected", state.openaiConnected && !isError);
      el.classList.toggle("error", Boolean(isError));
      if (el === pill) {
        el.innerHTML = `<span class="aai-status-dot"></span>${escapeHtml(state.statusLabel)}`;
      } else {
        el.textContent = state.statusLabel;
      }
    });

    if (dot) {
      dot.classList.toggle("connected", state.openaiConnected && !isError);
      dot.classList.toggle("error", Boolean(isError));
    }
    if (insight) insight.textContent = state.statusLabel;
    if (mode) mode.textContent = "Admin Assistant";
    if (chatModel) chatModel.textContent = state.model;
  }

  function updateAIInsights(question, response, type) {
    if (question || response) state.totalRequests += 1;
    saveChatHistory();

    const total = $("#aai-insight-total");
    const lastTopic = $("#aai-insight-last-topic");
    const next = $("#aai-insight-next");

    if (total) total.textContent = String(state.totalRequests);
    if (lastTopic) lastTopic.textContent = inferTopic(question || response || type || "");
    if (next) next.textContent = inferNextAction(question || "", response || "", type || "");
  }

  function inferTopic(text) {
    const value = String(text || "").toLowerCase();
    if (value.includes("refund") || value.includes("income") || value.includes("payment") || value.includes("stripe") || value.includes("charged")) return "Payments";
    if (value.includes("ticket") || value.includes("support") || value.includes("student complaint")) return "Support";
    if (value.includes("booking") || value.includes("ride") || value.includes("reservation")) return "Bookings";
    if (value.includes("station") || value.includes("availability")) return "Stations";
    if (value.includes("bike") || value.includes("maintenance") || value.includes("repair")) return "Maintenance";
    if (value.includes("report") || value.includes("summary")) return "Reports";
    return "Chat";
  }

  function inferNextAction(question, response, type) {
    const text = `${question} ${response}`.toLowerCase();
    if (type === "Ticket") return "Review checks before replying.";
    if (text.includes("refund") || text.includes("charged")) return "Verify payment and booking records.";
    if (text.includes("failed") || text.includes("stripe")) return "Check Stripe session and payment status.";
    if (text.includes("maintenance") || text.includes("repair")) return "Prioritise urgent maintenance tasks.";
    if (text.includes("station") || text.includes("availability")) return "Review station redistribution.";
    if (text.includes("booking")) return "Compare booking and payment status.";
    return "Ask a follow-up question.";
  }

  async function getAIResponse(message) {
    const conversationHistory = (state.messages || []).slice(-8).map((entry) => ({
      sender: entry.sender,
      message: String(entry.message || "").slice(0, 2000),
    }));

    const data = await apiFetch(`${AI_API_BASE}/chat`, {
      method: "POST",
      body: JSON.stringify({
        message,
        context: "admin-ai-assistant",
        conversationId: state.conversationId,
        conversationHistory,
        includeDataContext: true,
      }),
    });

    if (data && data.success === false) {
      throw new Error(data.message || data.error || "AI request failed");
    }

    state.conversationId = data.conversationId || state.conversationId;
    return {
      reply: data.reply || data.answer || "I could not generate a response.",
      source: data.source || (data.mode === "openai" ? "openai" : "fallback"),
      model: data.model || state.model,
      platformContextAvailable: Boolean(data.platformContextAvailable),
    };
  }

  async function sendAIMessage(message) {
    const clean = String(message || "").trim();
    if (!clean || state.loading) return;

    renderMessage("admin", clean, new Date().toISOString(), "");
    setLoadingState(true);
    showTypingIndicator();

    try {
      const result = await getAIResponse(clean);
      hideTypingIndicator();
      renderMessage("ai", result.reply, new Date().toISOString(), result.source);
      updateAIInsights(clean, result.reply, "Chat");
      if (result.source === "fallback") {
        showToast("AI used local platform context for this answer.", "warning");
      }
    } catch (error) {
      hideTypingIndicator();
      const fallback = "I could not reach the AI route. Check that the backend is running and the OpenAI key is configured in backend/.env.";
      renderMessage("ai", fallback, new Date().toISOString(), "fallback");
      updateAIInsights(clean, fallback, "Chat");
      showToast(error.message || "AI request failed.", "error");
    } finally {
      setLoadingState(false);
      const textarea = $("#aai-chat-text");
      if (textarea) {
        textarea.value = "";
        autoResizeTextarea(textarea);
        textarea.focus();
      }
    }
  }

  function handleQuickAction(action) {
    const prompt = QUICK_ACTION_PROMPTS[action] || action;
    focusChat();
    sendAIMessage(prompt);
  }

  function handleQuickPrompt(prompt) {
    sendAIMessage(prompt);
  }

  async function loadTicketQueue() {
    const queue = $("#aai-ticket-queue");
    if (queue) queue.innerHTML = '<div class="aai-mini-empty">Loading tickets...</div>';

    try {
      const data = await apiFetch(`${AI_API_BASE}/tickets`, { method: "GET" });
      state.tickets = Array.isArray(data.tickets) ? data.tickets : [];
      renderTicketQueue(state.tickets);
    } catch (error) {
      state.tickets = [];
      renderTicketQueue([]);
      showToast("Could not load support ticket queue.", "warning");
    }
  }

  function renderTicketQueue(tickets) {
    const queue = $("#aai-ticket-queue");
    if (!queue) return;

    if (!tickets.length) {
      queue.innerHTML = '<div class="aai-mini-empty">No open tickets found.</div>';
      return;
    }

    queue.innerHTML = tickets.slice(0, 4).map((ticket) => {
      const id = escapeAttribute(ticket.id || "");
      const subject = escapeHtml(ticket.subject || "Support request");
      const tooltip = escapeAttribute(`${ticket.subject || "Support request"}${ticket.description ? " - " + ticket.description : ""}`);
      const categoryClass = cleanBadgeClass(ticket.category);
      const priorityClass = cleanBadgeClass(ticket.priority);
      const statusClass = cleanBadgeClass(ticket.status);

      return `
        <button type="button" class="aai-ticket-row" data-ticket-id="${id}" data-tooltip="${tooltip}" title="${subject}">
          <div class="aai-ticket-main">
            <strong><span>${escapeHtml(ticket.id || "TK")}</span><em>${subject}</em></strong>
            <div class="aai-ticket-meta">
              <span class="${categoryClass}">${escapeHtml(ticket.category || "General")}</span>
              <span class="${priorityClass}">${escapeHtml(ticket.priority || "Medium")}</span>
              <span class="${statusClass}">${escapeHtml(ticket.status || "Open")}</span>
            </div>
          </div>
        </button>
      `;
    }).join("");
  }

  function selectTicket(ticketId) {
    const ticket = state.tickets.find((item) => String(item.id) === String(ticketId));
    if (!ticket) return;
    if (state.loading) {
      showToast("AI is still answering. Please wait a moment.", "warning");
      return;
    }

    state.selectedTicket = ticket;
    $$(".aai-ticket-row").forEach((row) => {
      row.classList.toggle("active", row.dataset.ticketId === String(ticketId));
    });

    focusChat();
    showToast(`Analysing ${ticket.id || "ticket"} in chat.`);
    sendAIMessage(buildTicketAnalysisPrompt(ticket));
  }

  function buildTicketAnalysisPrompt(ticket) {
    const created = ticket?.createdAt ? formatDateTime(ticket.createdAt) : "Not available";
    const description = ticket?.description || "No detailed description is available from the ticket queue.";

    return `Analyse support ticket ${ticket?.id || "selected ticket"}.

Ticket details:
- Ticket ID: ${ticket?.id || "Unknown"}
- Student/user: ${ticket?.studentName || "Not available"}
- Category: ${ticket?.category || "general"}
- Priority: ${ticket?.priority || "medium"}
- Status: ${ticket?.status || "open"}
- Reported: ${created}
- Subject: ${ticket?.subject || "Support request"}
- Description: ${description}

Return a clean admin report with short sections:
1. Issue summary
2. Likely cause
3. Student impact
4. Refund recommendation if relevant
5. Next admin action
6. Suggested reply to the student`;
  }

  function focusChat() {
    const chat = $(".aai-chat-card");
    const textarea = $("#aai-chat-text");
    if (chat) chat.scrollIntoView({ behavior: "smooth", block: "nearest" });
    if (textarea) {
      requestAnimationFrame(() => textarea.focus({ preventScroll: true }));
    }
  }

  function updateSelectedTicketPreview(ticket) {
    const code = $("#aai-selected-ticket-code");
    const subject = $("#aai-selected-ticket-subject");
    const meta = $("#aai-selected-ticket-meta");
    if (code) code.textContent = ticket?.id || "Manual ticket";
    if (subject) subject.textContent = ticket?.subject || "Paste support ticket details below.";
    if (meta) {
      const student = ticket?.studentName || "Student";
      const reported = ticket?.createdAt ? formatDateTime(ticket.createdAt) : "Recently reported";
      meta.textContent = `${student} • ${reported}`;
    }
  }

  function showTicketAnalysisForm(show) {
    const empty = $("#aai-ticket-empty");
    const form = $("#aai-ticket-form");
    if (empty) empty.hidden = Boolean(show);
    if (form) form.hidden = !show;
  }

  async function analyseSelectedTicket() {
    const ticketId = $("#aai-ticket-id")?.value.trim() || "";
    const subject = $("#aai-ticket-subject")?.value.trim() || "";
    const description = $("#aai-ticket-description")?.value.trim() || "";

    if (!subject && !description) {
      showToast("Add a ticket subject or description first.", "warning");
      return;
    }

    const button = $("#aai-analyse-ticket");
    const original = button ? button.innerHTML : "";
    setLoadingState(true);
    if (button) button.innerHTML = '<span data-icon="rotate"></span>Analysing...';
    hydrateIcons(button);

    try {
      const data = await apiFetch(`${AI_API_BASE}/analyse-ticket`, {
        method: "POST",
        body: JSON.stringify({ ticketId, subject, description }),
      });
      const analysis = data.analysis || data;
      renderTicketAnalysis(analysis);
      updateAIInsights(subject || ticketId, analysis.summary || analysis.nextAction || "", "Ticket");
      showToast(data.source === "fallback" ? "Ticket analysed with local context." : "Ticket analysed with OpenAI.");
    } catch (error) {
      showToast(error.message || "Ticket analysis failed.", "error");
    } finally {
      setLoadingState(false);
      if (button) {
        button.innerHTML = original || '<span data-icon="sparkles"></span>Analyse Ticket';
        hydrateIcons(button);
      }
    }
  }

  function renderTicketAnalysis(analysis) {
    const result = $("#aai-ticket-result");
    if (!result) return;

    result.hidden = false;
    setPill("#aai-ticket-category", analysis.category || "General");
    setPill("#aai-ticket-priority", analysis.priority || "Medium");
    setPill("#aai-ticket-sentiment", analysis.sentiment || "Neutral");
    setPill("#aai-ticket-refund", analysis.refundRecommendation || "Not Needed", "refund");
    setText("#aai-ticket-summary", analysis.summary || "No summary returned.");
    setText("#aai-ticket-reply", analysis.suggestedReply || "No reply returned.");
    setText("#aai-ticket-next-action", analysis.nextAction || "No action returned.");

    const checks = $("#aai-ticket-checks");
    const relatedChecks = Array.isArray(analysis.relatedChecks) ? analysis.relatedChecks : [];
    if (checks) {
      checks.innerHTML = relatedChecks.length
        ? relatedChecks.map((item) => `<span>${escapeHtml(item)}</span>`).join("")
        : "<span>Review linked admin records</span>";
    }
  }

  function setPill(selector, value, extraClass) {
    const el = $(selector);
    if (!el) return;
    el.textContent = value;
    el.className = `aai-pill ${cleanBadgeClass(value)} ${extraClass || ""}`.trim();
  }

  function setText(selector, value) {
    const el = $(selector);
    if (el) el.textContent = value;
  }

  function setValue(selector, value) {
    const el = $(selector);
    if (el) el.value = value;
  }

  function startNewChat() {
    state.conversationId = null;
    state.messages = [];
    saveChatHistory();
    renderEmptyChat();
    showToast("New AI chat started.");
  }

  async function clearChatHistory() {
    state.conversationId = null;
    state.messages = [];
    try {
      localStorage.removeItem(CHAT_STORAGE_KEY);
      await apiFetch(`${AI_API_BASE}/history`, { method: "DELETE" }).catch(() => {});
    } catch (_) {}
    renderEmptyChat();
    showToast("AI chat history cleared.");
  }

  function exportAINotes() {
    const lines = [
      "Campus Bike Sharing - Admin AI Notes",
      "Exported: " + new Date().toLocaleString(),
      "",
    ];

    if (!state.messages.length) {
      lines.push("No chat messages exported.");
    } else {
      state.messages.forEach((entry) => {
        lines.push(`[${entry.sender === "admin" ? "Admin" : "AI"}] ${formatDateTime(entry.timestamp)}`);
        lines.push(entry.message);
        lines.push("");
      });
    }

    const blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `admin_ai_notes_${new Date().toISOString().slice(0, 10)}.txt`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    showToast("AI notes exported.");
  }

  async function copyMessageToClipboard(message) {
    const text = String(message || "");
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        document.execCommand("copy");
        textarea.remove();
      }
      showToast("AI response copied.");
    } catch (_) {
      showToast("Could not copy the response.", "warning");
    }
  }

  function copyTicketReply() {
    const reply = $("#aai-ticket-reply")?.textContent?.trim() || "";
    if (!reply) {
      showToast("Analyse a ticket before copying a reply.", "warning");
      return;
    }
    copyMessageToClipboard(reply);
  }

  function openSelectedTicket() {
    const ticketId = $("#aai-ticket-id")?.value.trim();
    const target = ticketId
      ? `./Admin_support.html?ticket=${encodeURIComponent(ticketId)}`
      : "./Admin_support.html";
    window.location.href = target;
  }

  function autoResizeTextarea(textarea) {
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = Math.min(textarea.scrollHeight, 150) + "px";
  }

  async function refreshAIWorkspace() {
    await Promise.all([checkAIHealth(), loadTicketQueue()]);
    showToast("AI workspace refreshed.");
  }

  function bindAIEvents() {
    const chatForm = $("#aai-chat-form");
    const chatText = $("#aai-chat-text");
    const ticketForm = $("#aai-ticket-form");

    if (chatForm) {
      chatForm.addEventListener("submit", (event) => {
        event.preventDefault();
        sendAIMessage(chatText ? chatText.value : "");
      });
    }

    if (chatText) {
      chatText.addEventListener("input", () => autoResizeTextarea(chatText));
      chatText.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          sendAIMessage(chatText.value);
        }
      });
    }

    if (ticketForm) {
      ticketForm.addEventListener("submit", (event) => {
        event.preventDefault();
        analyseSelectedTicket();
      });
    }

    $("#aai-new-chat")?.addEventListener("click", startNewChat);
    $("#aai-clear-history")?.addEventListener("click", clearChatHistory);
    $("#refresh-dashboard")?.addEventListener("click", refreshAIWorkspace);
    $("#export-report")?.addEventListener("click", exportAINotes);
    $("#aai-refresh-tickets")?.addEventListener("click", loadTicketQueue);
    $("#aai-copy-reply")?.addEventListener("click", copyTicketReply);
    $("#aai-open-ticket")?.addEventListener("click", openSelectedTicket);

    $("#aai-quick-actions")?.addEventListener("click", (event) => {
      const button = event.target.closest(".aai-action");
      if (!button) return;
      handleQuickAction(button.dataset.action || "");
    });

    $("#aai-chat-body")?.addEventListener("click", (event) => {
      const emptyPrompt = event.target.closest(".aai-empty-chip");
      if (emptyPrompt) {
        sendAIMessage(EMPTY_PROMPTS[emptyPrompt.dataset.emptyPrompt] || emptyPrompt.textContent);
        return;
      }

      const copy = event.target.closest(".aai-copy-btn");
      if (copy) copyMessageToClipboard(copy.dataset.copyMessage || "");
    });

    $("#aai-ticket-queue")?.addEventListener("click", (event) => {
      const row = event.target.closest(".aai-ticket-row");
      if (!row) return;
      selectTicket(row.dataset.ticketId);
    });

    document.addEventListener("mouseover", handleTooltipShow);
    document.addEventListener("mousemove", handleTooltipMove);
    document.addEventListener("mouseout", handleTooltipHide);
  }

  function handleTooltipShow(event) {
    const target = event.target.closest("[data-tooltip]");
    const tooltip = $("#aai-tooltip");
    if (!target || !tooltip) return;
    const text = target.dataset.tooltip || "";
    if (!text) return;
    tooltip.textContent = text;
    tooltip.hidden = false;
    handleTooltipMove(event);
  }

  function handleTooltipMove(event) {
    const tooltip = $("#aai-tooltip");
    if (!tooltip || tooltip.hidden) return;
    const offset = 14;
    const maxX = window.innerWidth - tooltip.offsetWidth - 18;
    const maxY = window.innerHeight - tooltip.offsetHeight - 18;
    tooltip.style.left = Math.min(event.clientX + offset, maxX) + "px";
    tooltip.style.top = Math.min(event.clientY + offset, maxY) + "px";
  }

  function handleTooltipHide(event) {
    if (!event.target.closest("[data-tooltip]")) return;
    const tooltip = $("#aai-tooltip");
    if (tooltip) tooltip.hidden = true;
  }

  function cleanBadgeClass(value) {
    return String(value || "general").toLowerCase().replace(/[^a-z0-9]+/g, "-");
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function escapeAttribute(value) {
    return escapeHtml(value).replace(/\s+/g, " ");
  }

  async function initAdminAIPage() {
    hydrateIcons(document);
    loadChatHistory();
    renderChatHistory();
    updateAIInsights("", "", "Chat");
    bindAIEvents();
    await Promise.all([checkAIHealth(), loadTicketQueue()]);
  }

  window.initAdminAIPage = initAdminAIPage;
  window.bindAIEvents = bindAIEvents;
  window.checkAIHealth = checkAIHealth;
  window.loadTicketQueue = loadTicketQueue;
  window.renderTicketQueue = renderTicketQueue;
  window.selectTicket = selectTicket;
  window.analyseSelectedTicket = analyseSelectedTicket;
  window.sendAIMessage = sendAIMessage;
  window.getAIResponse = getAIResponse;
  window.renderMessage = renderMessage;
  window.showTypingIndicator = showTypingIndicator;
  window.hideTypingIndicator = hideTypingIndicator;
  window.updateAIInsights = updateAIInsights;
  window.handleQuickAction = handleQuickAction;
  window.handleQuickPrompt = handleQuickPrompt;
  window.startNewChat = startNewChat;
  window.clearChatHistory = clearChatHistory;
  window.exportAINotes = exportAINotes;
  window.copyMessageToClipboard = copyMessageToClipboard;
  window.copyTicketReply = copyTicketReply;
  window.openSelectedTicket = openSelectedTicket;
  window.autoResizeTextarea = autoResizeTextarea;
  window.scrollChatToBottom = scrollChatToBottom;
  window.showToast = showToast;
  window.setLoadingState = setLoadingState;

  document.addEventListener("DOMContentLoaded", initAdminAIPage);
})();
