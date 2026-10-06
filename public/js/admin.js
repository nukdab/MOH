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

  let currentUser = null;
  let currentPage = 1;
  let totalPages = 1;
  let currentCaseId = null;

  const sections = {
    dashboard: document.getElementById("adminDashboardSection"),
    cases: document.getElementById("adminCasesSection"),
    detail: document.getElementById("adminCaseDetailSection"),
    audit: document.getElementById("adminAuditSection")
  };

  function emptyState(text) {
    return `<div class="empty-state">${escapeHtml(text)}</div>`;
  }

  function showAdminSection(name) {
    Object.values(sections).forEach((section) => section.classList.add("hidden"));

    if (sections[name]) sections[name].classList.remove("hidden");

    document.querySelectorAll("[data-admin-section]").forEach((item) => {
      item.classList.toggle("active", item.dataset.adminSection === name);
    });

    if (name !== "detail") {
      history.replaceState(null, "", `#${name}`);
    }
  }

  function renderCaseRow(item) {
    return `
      <tr data-admin-case="${item.id}">
        <td>${escapeHtml(item.tracking_code)}</td>
        <td>${escapeHtml(item.subject)}</td>
        <td>${escapeHtml(item.owner_name || item.complainant_name || "-")}</td>
        <td>${escapeHtml(categoryLabel(item.category))}</td>
        <td><span class="status-badge status-${escapeHtml(item.status)}">${escapeHtml(statusLabel(item.status))}</span></td>
        <td>${escapeHtml(formatDate(item.created_at))}</td>
      </tr>
    `;
  }

  function renderDashboardCase(item) {
    return `
      <button class="case-item" type="button" data-admin-case="${item.id}">
        <span class="case-main">
          <strong>${escapeHtml(item.subject)}</strong>
          <small>${escapeHtml(item.tracking_code)} · ${escapeHtml(item.owner_name || "")}</small>
        </span>
        <span class="status-badge status-${escapeHtml(item.status)}">${escapeHtml(statusLabel(item.status))}</span>
      </button>
    `;
  }

  async function loadStats() {
    const data = await api("/api/admin/stats");

    document.getElementById("adminTotal").textContent = faNumber(data.total);
    document.getElementById("adminSubmitted").textContent = faNumber(data.by_status.submitted);
    document.getElementById("adminReviewing").textContent = faNumber(data.by_status.reviewing);
    document.getElementById("adminUsers").textContent = faNumber(data.users);
  }

  async function loadCases(page = 1) {
    currentPage = page;

    const q = document.getElementById("caseSearch").value.trim();
    const status = document.getElementById("caseStatusFilter").value;

    const params = new URLSearchParams({
      page: String(page)
    });

    if (q) params.set("q", q);
    if (status) params.set("status", status);

    const data = await api(`/api/admin/cases?${params.toString()}`);

    totalPages = data.pages || 1;

    document.getElementById("pageInfo").textContent =
      `صفحه ${faNumber(data.page)} از ${faNumber(totalPages)}`;

    document.getElementById("prevPage").disabled = currentPage <= 1;
    document.getElementById("nextPage").disabled = currentPage >= totalPages;

    const container = document.getElementById("adminCases");

    if (!data.cases.length) {
      container.innerHTML = emptyState("پرونده‌ای پیدا نشد.");
      return;
    }

    container.innerHTML = `
      <table class="admin-table">
        <thead>
          <tr>
            <th>کد رهگیری</th>
            <th>موضوع</th>
            <th>ثبت‌کننده</th>
            <th>دسته‌بندی</th>
            <th>وضعیت</th>
            <th>تاریخ</th>
          </tr>
        </thead>
        <tbody>
          ${data.cases.map(renderCaseRow).join("")}
        </tbody>
      </table>
    `;

    bindCaseButtons();
  }

  async function loadDashboardCases() {
    const data = await api("/api/admin/cases?page=1");

    const container = document.getElementById("dashboardCases");

    if (!data.cases.length) {
      container.innerHTML = emptyState("پرونده‌ای وجود ندارد.");
      return;
    }

    container.innerHTML = data.cases.slice(0, 8).map(renderDashboardCase).join("");
    bindCaseButtons();
  }

  function bindCaseButtons() {
    document.querySelectorAll("[data-admin-case]").forEach((element) => {
      element.addEventListener("click", () => {
        openCase(Number(element.dataset.adminCase));
      });
    });
  }

  function renderCaseDetail(data) {
    const c = data.case;

    document.getElementById("adminCaseSubject").textContent = c.subject;

    const attachments = (data.attachments || []).map((file) => `
      <a
        class="attachment-link"
        href="/api/attachments/${file.id}?inline=0"
        target="_blank"
        rel="noopener"
      >
        <span>
          ${escapeHtml(file.filename)}
          ${file.kind === "petition" ? " · شکواییه/دادخواست" : ""}
        </span>
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

    const notifications = (data.notifications || []).map((n) => `
      <div class="notification-item">
        <h3>${escapeHtml(n.title)}</h3>
        <p>${escapeHtml(n.body)}</p>
        <div class="notification-meta">
          <span>${n.confirmed_at ? "تأیید شده" : n.viewed_at ? "مشاهده شده" : "مشاهده نشده"}</span>
          <span>${escapeHtml(formatDate(n.created_at))}</span>
        </div>
      </div>
    `).join("");

    document.getElementById("adminCaseDetail").innerHTML = `
      <div class="detail-grid">
        <div class="detail-box">
          <small>کد رهگیری</small>
          <strong>${escapeHtml(c.tracking_code)}</strong>
        </div>

        <div class="detail-box">
          <small>وضعیت</small>
          <strong>
            <span class="status-badge status-${escapeHtml(c.status)}">
              ${escapeHtml(statusLabel(c.status))}
            </span>
          </strong>
        </div>

        <div class="detail-box">
          <small>شاکی</small>
          <strong>${escapeHtml(c.complainant_name)}</strong>
        </div>

        <div class="detail-box">
          <small>تلفن شاکی</small>
          <strong>${escapeHtml(c.complainant_phone)}</strong>
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
          <small>تاریخچه</small>
          <div class="timeline">
            ${events || emptyState("تاریخچه‌ای وجود ندارد.")}
          </div>
        </div>

        <div class="detail-box detail-full">
          <small>ابلاغیه‌های پرونده</small>
          <div class="notification-list">
            ${notifications || emptyState("ابلاغیه‌ای ارسال نشده است.")}
          </div>
        </div>
      </div>
    `;

    document.getElementById("newCaseStatus").value = c.status;
  }

  async function openCase(id) {
    currentCaseId = id;
    showAdminSection("detail");

    document.getElementById("adminCaseDetail").innerHTML =
      `<div class="loading">در حال دریافت پرونده...</div>`;

    try {
      const data = await api(`/api/admin/cases/${id}`);
      renderCaseDetail(data);
    } catch (error) {
      document.getElementById("adminCaseDetail").innerHTML =
        emptyState(error.message);
    }
  }

  async function saveStatus() {
    if (!currentCaseId) return;

    const status = document.getElementById("newCaseStatus").value;
    const note = document.getElementById("statusNote").value.trim();

    try {
      await api(`/api/admin/cases/${currentCaseId}/status`, {
        method: "POST",
        body: JSON.stringify({ status, note })
      });

      toast("وضعیت پرونده با موفقیت تغییر کرد.", "success");
      document.getElementById("statusNote").value = "";

      await Promise.all([
        loadStats(),
        openCase(currentCaseId)
      ]);
    } catch (error) {
      toast(error.message);
    }
  }

  async function sendNotification() {
    if (!currentCaseId) return;

    const title = document.getElementById("notificationTitle").value.trim();
    const body = document.getElementById("notificationBody").value.trim();
    const requires_confirmation =
      document.getElementById("requiresConfirmation").checked;

    try {
      await api(`/api/admin/cases/${currentCaseId}/notifications`, {
        method: "POST",
        body: JSON.stringify({
          title,
          body,
          requires_confirmation
        })
      });

      document.getElementById("notificationTitle").value = "";
      document.getElementById("notificationBody").value = "";
      document.getElementById("requiresConfirmation").checked = false;

      toast("ابلاغیه ارسال شد.", "success");
      await openCase(currentCaseId);
    } catch (error) {
      toast(error.message);
    }
  }

  async function uploadPetition() {
    if (!currentCaseId) return;

    const input = document.getElementById("petitionFile");
    const file = input.files[0];

    if (!file) {
      toast("یک فایل انتخاب کنید.");
      return;
    }

    const form = new FormData();
    form.append("file", file);
    form.append(
      "note",
      document.getElementById("petitionNote").value.trim()
    );

    try {
      await api(`/api/admin/cases/${currentCaseId}/attachments`, {
        method: "POST",
        body: form
      });

      input.value = "";
      document.getElementById("petitionNote").value = "";

      toast("فایل با موفقیت به پرونده اضافه شد.", "success");
      await openCase(currentCaseId);
    } catch (error) {
      toast(error.message);
    }
  }

  async function loadAudit() {
    const data = await api("/api/admin/audit");
    const container = document.getElementById("auditLogs");

    if (!data.logs.length) {
      container.innerHTML = emptyState("هنوز فعالیتی ثبت نشده است.");
      return;
    }

    container.innerHTML = data.logs.map((log) => `
      <article class="audit-item">
        <strong>${escapeHtml(log.action)}</strong>
        <span>${escapeHtml(log.details || "-")}</span>
        <small>${escapeHtml(log.admin_name || "مدیر")} · ${escapeHtml(formatDate(log.created_at))}</small>
      </article>
    `).join("");
  }

  function setupNavigation() {
    document.querySelectorAll("[data-admin-section]").forEach((item) => {
      item.addEventListener("click", async (event) => {
        event.preventDefault();

        const section = item.dataset.adminSection;
        showAdminSection(section);

        if (section === "cases") {
          await loadCases(1);
        }

        if (section === "audit") {
          await loadAudit();
        }
      });
    });

    document.querySelectorAll("[data-admin-go]").forEach((button) => {
      button.addEventListener("click", async () => {
        const section = button.dataset.adminGo;

        showAdminSection(section);

        if (section === "cases") {
          await loadCases(1);
        }
      });
    });

    document.getElementById("backToCases").addEventListener("click", async () => {
      showAdminSection("cases");
      await loadCases(currentPage);
    });

    document.getElementById("caseFilterButton").addEventListener("click", () => {
      loadCases(1);
    });

    document.getElementById("caseSearch").addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        loadCases(1);
      }
    });

    document.getElementById("prevPage").addEventListener("click", () => {
      if (currentPage > 1) loadCases(currentPage - 1);
    });

    document.getElementById("nextPage").addEventListener("click", () => {
      if (currentPage < totalPages) loadCases(currentPage + 1);
    });

    document.getElementById("saveCaseStatus").addEventListener("click", saveStatus);
    document.getElementById("sendNotification").addEventListener("click", sendNotification);
    document.getElementById("uploadPetition").addEventListener("click", uploadPetition);
  }

  async function init() {
    currentUser = await requireAuth(["admin"]);

    if (!currentUser) return;

    document.getElementById("adminWelcome").textContent =
      `سلام ${currentUser.full_name}`;

    setupNavigation();

    try {
      await Promise.all([
        loadStats(),
        loadDashboardCases()
      ]);

      const hash = location.hash.replace("#", "");

      if (hash === "cases") {
        showAdminSection("cases");
        await loadCases(1);
      } else if (hash === "audit") {
        showAdminSection("audit");
        await loadAudit();
      } else {
        showAdminSection("dashboard");
      }
    } catch (error) {
      toast(error.message);
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
