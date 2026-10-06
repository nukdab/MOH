(function () {
  "use strict";

  const {
    api,
    requireAuth,
    escapeHtml,
    faNumber,
    statusLabel,
    categoryLabel,
    formatDate,
    toast
  } = window.MOH;

  let user = null;
  let cases = [];
  let notifications = [];

  const sections = {
    dashboard: document.getElementById("dashboardSection"),
    cases: document.getElementById("casesSection"),
    notifications: document.getElementById("notificationsSection"),
    detail: document.getElementById("caseDetailSection")
  };

  function emptyState(text) {
    return `<div class="empty-state">${escapeHtml(text)}</div>`;
  }

  function caseHtml(item) {
    return `
      <button class="case-item" type="button" data-case-id="${item.id}">
        <span class="case-main">
          <strong>${escapeHtml(item.subject)}</strong>
          <small>${escapeHtml(item.tracking_code)} · ${escapeHtml(categoryLabel(item.category))} · ${escapeHtml(formatDate(item.created_at))}</small>
        </span>
        <span class="status-badge status-${escapeHtml(item.status)}">${escapeHtml(statusLabel(item.status))}</span>
      </button>
    `;
  }

  function notificationHtml(item) {
    const unread = !item.viewed_at;

    return `
      <article class="notification-item ${unread ? "unread" : ""}" data-notification-id="${item.id}">
        <h3>${escapeHtml(item.title)}</h3>
        <p>${escapeHtml(item.body)}</p>
        <div class="notification-meta">
          <span>${escapeHtml(item.tracking_code || "")}</span>
          <span>${escapeHtml(formatDate(item.created_at))}</span>
        </div>

        <div style="display:flex;gap:8px;margin-top:10px;">
          ${
            !item.viewed_at
              ? `<button class="button button-secondary button-small notification-view" data-id="${item.id}" type="button">مشاهده</button>`
              : `<span class="status-badge status-closed">مشاهده شده</span>`
          }

          ${
            item.requires_confirmation && !item.confirmed_at
              ? `<button class="button button-primary button-small notification-confirm" data-id="${item.id}" type="button">تأیید دریافت</button>`
              : item.requires_confirmation
                ? `<span class="status-badge status-answered">تأیید شده</span>`
                : ""
          }
        </div>
      </article>
    `;
  }

  function renderCases() {
    const recent = document.getElementById("recentCases");
    const all = document.getElementById("allCases");

    if (!cases.length) {
      recent.innerHTML = emptyState("هنوز پرونده‌ای ثبت نکرده‌اید.");
      all.innerHTML = emptyState("هنوز پرونده‌ای ثبت نکرده‌اید.");
      return;
    }

    recent.innerHTML = cases.slice(0, 5).map(caseHtml).join("");
    all.innerHTML = cases.map(caseHtml).join("");

    document.querySelectorAll("[data-case-id]").forEach((el) => {
      el.addEventListener("click", () => openCase(Number(el.dataset.caseId)));
    });
  }

  function renderNotifications() {
    const recent = document.getElementById("recentNotifications");
    const all = document.getElementById("allNotifications");

    if (!notifications.length) {
      recent.innerHTML = emptyState("ابلاغیه‌ای وجود ندارد.");
      all.innerHTML = emptyState("ابلاغیه‌ای وجود ندارد.");
      return;
    }

    recent.innerHTML = notifications.slice(0, 4).map(notificationHtml).join("");
    all.innerHTML = notifications.map(notificationHtml).join("");

    bindNotificationActions();
  }

  function bindNotificationActions() {
    document.querySelectorAll(".notification-view").forEach((button) => {
      button.addEventListener("click", async (event) => {
        event.stopPropagation();

        try {
          await api(`/api/notifications/${button.dataset.id}/view`, {
            method: "POST"
          });

          await loadNotifications();
          await loadSummary();
          toast("ابلاغیه به عنوان مشاهده‌شده ثبت شد.", "success");
        } catch (error) {
          toast(error.message);
        }
      });
    });

    document.querySelectorAll(".notification-confirm").forEach((button) => {
      button.addEventListener("click", async (event) => {
        event.stopPropagation();

        try {
          await api(`/api/notifications/${button.dataset.id}/confirm`, {
            method: "POST"
          });

          await loadNotifications();
          await loadSummary();
          toast("دریافت ابلاغیه تأیید شد.", "success");
        } catch (error) {
          toast(error.message);
        }
      });
    });
  }

  function showSection(name) {
    Object.values(sections).forEach((section) => section.classList.add("hidden"));

    if (sections[name]) sections[name].classList.remove("hidden");

    document.querySelectorAll("[data-section]").forEach((item) => {
      item.classList.toggle("active", item.dataset.section === name);
    });

    if (name !== "detail") {
      history.replaceState(null, "", `#${name}`);
    }
  }

  async function loadSummary() {
    const data = await api("/api/user/summary");

    document.getElementById("welcomeTitle").textContent =
      `سلام ${data.user.full_name}`;

    document.getElementById("statTotal").textContent = faNumber(data.total);
    document.getElementById("statReviewing").textContent = faNumber(data.reviewing);
    document.getElementById("statAnswered").textContent = faNumber(data.answered);
    document.getElementById("statUnread").textContent = faNumber(data.unread);

    const count = document.getElementById("notificationCount");
    count.textContent = faNumber(data.unread);
    count.classList.toggle("hidden", !data.unread);
  }

  async function loadCases() {
    const data = await api("/api/cases");
    cases = data.cases || [];
    renderCases();
  }

  async function loadNotifications() {
    const data = await api("/api/notifications");
    notifications = data.notifications || [];
    renderNotifications();
  }

  function renderDetail(data) {
    const c = data.case;

    document.getElementById("caseDetailSubject").textContent = c.subject;

    const attachments = (data.attachments || []).map((file) => `
      <a
        class="attachment-link"
        href="/api/attachments/${file.id}?inline=0"
        target="_blank"
        rel="noopener"
      >
        <span>${escapeHtml(file.filename)}</span>
        <span>${faNumber(Math.ceil(file.size / 1024))} KB</span>
      </a>
    `).join("");

    const events = (data.events || []).map((event) => `
      <div class="timeline-item">
        <strong>${escapeHtml(event.message || event.type)}</strong>
        <small>${escapeHtml(event.actor_name || "سامانه")} · ${escapeHtml(formatDate(event.created_at))}</small>
        ${
          event.from_status && event.to_status
            ? `<p>${escapeHtml(statusLabel(event.from_status))} ← ${escapeHtml(statusLabel(event.to_status))}</p>`
            : ""
        }
      </div>
    `).join("");

    document.getElementById("caseDetail").innerHTML = `
      <div class="detail-grid">
        <div class="detail-box">
          <small>کد رهگیری</small>
          <strong>${escapeHtml(c.tracking_code)}</strong>
        </div>

        <div class="detail-box">
          <small>وضعیت</small>
          <strong><span class="status-badge status-${escapeHtml(c.status)}">${escapeHtml(statusLabel(c.status))}</span></strong>
        </div>

        <div class="detail-box">
          <small>دسته‌بندی</small>
          <strong>${escapeHtml(categoryLabel(c.category))}</strong>
        </div>

        <div class="detail-box">
          <small>تاریخ ثبت</small>
          <strong>${escapeHtml(formatDate(c.created_at))}</strong>
        </div>

        <div class="detail-box detail-full">
          <small>طرف شکایت</small>
          <strong>${escapeHtml(c.against_name || "ثبت نشده")}</strong>
        </div>

        <div class="detail-box detail-full">
          <small>شرح شکایت</small>
          <div class="description-box">${escapeHtml(c.description)}</div>
        </div>

        <div class="detail-box detail-full">
          <small>پیوست‌ها</small>
          <div class="attachments">
            ${attachments || `<span class="empty-state">پیوستی وجود ندارد.</span>`}
          </div>
        </div>

        <div class="detail-box detail-full">
          <small>تاریخچه پرونده</small>
          <div class="timeline">
            ${events || `<span class="empty-state">تاریخچه‌ای ثبت نشده است.</span>`}
          </div>
        </div>
      </div>
    `;
  }

  async function openCase(id) {
    showSection("detail");

    document.getElementById("caseDetail").innerHTML =
      `<div class="loading">در حال دریافت جزئیات پرونده...</div>`;

    try {
      const data = await api(`/api/cases/${id}`);
      renderDetail(data);
    } catch (error) {
      document.getElementById("caseDetail").innerHTML = emptyState(error.message);
    }
  }

  function setupNavigation() {
    document.querySelectorAll("[data-section]").forEach((item) => {
      item.addEventListener("click", (event) => {
        event.preventDefault();
        showSection(item.dataset.section);
      });
    });

    document.querySelectorAll("[data-go-section]").forEach((button) => {
      button.addEventListener("click", () => {
        showSection(button.dataset.goSection);
      });
    });

    document.getElementById("closeCaseDetail").addEventListener("click", () => {
      showSection("cases");
    });
  }

  async function init() {
    user = await requireAuth(["user", "admin"]);
    if (!user) return;

    if (user.role === "admin") {
      const path = location.pathname;
      if (path === "/user.html" && location.hash === "#admin") {
        location.href = "/admin.html";
        return;
      }
    }

    setupNavigation();

    try {
      await Promise.all([
        loadSummary(),
        loadCases(),
        loadNotifications()
      ]);

      const hash = location.hash.replace("#", "");

      if (["cases", "notifications"].includes(hash)) {
        showSection(hash);
      } else {
        showSection("dashboard");
      }
    } catch (error) {
      toast(error.message);
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
