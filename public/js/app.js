(function () {
  "use strict";

  const root = document.documentElement;

  function getStoredTheme() {
    const saved = localStorage.getItem("moh-theme");
    if (saved === "light" || saved === "dark") return saved;

    return window.matchMedia &&
      window.matchMedia("(prefers-color-scheme: light)").matches
      ? "light"
      : "dark";
  }

  function applyTheme(theme) {
    root.classList.toggle("light", theme === "light");
    localStorage.setItem("moh-theme", theme);

    document.querySelectorAll("#themeToggle, #mobileThemeToggle").forEach((btn) => {
      btn.textContent = theme === "dark" ? "☀" : "◐";
      btn.title = theme === "dark" ? "حالت روشن" : "حالت تاریک";
    });
  }

  function toggleTheme() {
    applyTheme(root.classList.contains("light") ? "dark" : "light");
  }

  async function api(url, options = {}) {
    const opts = { credentials: "same-origin", ...options };
    opts.headers = new Headers(opts.headers || {});

    if (opts.body && !(opts.body instanceof FormData) && !opts.headers.has("Content-Type")) {
      opts.headers.set("Content-Type", "application/json");
    }

    if (opts.method && !["GET", "HEAD"].includes(opts.method.toUpperCase())) {
      opts.headers.set("X-Requested-With", "fetch");
    }

    const response = await fetch(url, opts);
    let data = null;

    try {
      data = await response.json();
    } catch {
      data = {};
    }

    if (!response.ok) {
      const error = new Error(data.error || "درخواست با خطا مواجه شد.");
      error.status = response.status;
      error.fields = data.fields || {};
      throw error;
    }

    return data;
  }

  function toast(message, type = "error") {
    const old = document.querySelector(".toast");
    if (old) old.remove();

    const el = document.createElement("div");
    el.className = "toast";
    el.textContent = message;

    if (type === "success") {
      el.style.borderColor = "rgba(74,222,128,.35)";
    }

    document.body.appendChild(el);

    setTimeout(() => {
      el.remove();
    }, 4000);
  }

  function showMessage(element, message, type = "error") {
    if (!element) return;

    element.textContent = message;
    element.className = `message-box ${type}`;
  }

  function hideMessage(element) {
    if (!element) return;
    element.className = "message-box hidden";
    element.textContent = "";
  }

  function faNumber(value) {
    return String(value ?? 0).replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[d]);
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function statusLabel(status) {
    return {
      submitted: "ثبت‌شده",
      reviewing: "در حال بررسی",
      answered: "پاسخ داده‌شده",
      closed: "بسته‌شده",
      rejected: "رد‌شده"
    }[status] || status || "نامشخص";
  }

  function categoryLabel(category) {
    return {
      services: "خدمات",
      financial: "مالی",
      administrative: "اداری",
      technical: "فنی",
      behavior: "رفتاری",
      other: "سایر"
    }[category] || category || "سایر";
  }

  function formatDate(value) {
    if (!value) return "-";

    const date = new Date(String(value).replace(" ", "T") + "Z");

    if (Number.isNaN(date.getTime())) return value;

    return new Intl.DateTimeFormat("fa-IR", {
      dateStyle: "medium",
      timeStyle: "short"
    }).format(date);
  }

  async function currentUser() {
    return api("/api/auth/me");
  }

  async function requireAuth(allowedRoles = []) {
    try {
      const data = await currentUser();

      if (allowedRoles.length && !allowedRoles.includes(data.user.role)) {
        location.href = data.user.role === "admin" ? "/admin.html" : "/user.html";
        return null;
      }

      return data.user;
    } catch {
      location.href = "/auth.html";
      return null;
    }
  }

  async function logout() {
    try {
      await api("/api/auth/logout", { method: "POST" });
    } finally {
      location.href = "/auth.html";
    }
  }

  function setupTheme() {
    applyTheme(getStoredTheme());

    document.querySelectorAll("#themeToggle, #mobileThemeToggle").forEach((button) => {
      button.addEventListener("click", toggleTheme);
    });
  }

  function setupPasswordToggles() {
    document.querySelectorAll(".password-toggle").forEach((button) => {
      button.addEventListener("click", () => {
        const input = button.parentElement.querySelector("input");
        if (!input) return;

        input.type = input.type === "password" ? "text" : "password";
        button.textContent = input.type === "password" ? "◉" : "◎";
      });
    });
  }

  function setupMobileSidebar() {
    const toggle = document.getElementById("sidebarToggle");
    const sidebar = document.getElementById("sidebar");

    if (!toggle || !sidebar) return;

    toggle.addEventListener("click", () => {
      sidebar.classList.toggle("open");
    });

    sidebar.querySelectorAll("a").forEach((link) => {
      link.addEventListener("click", () => sidebar.classList.remove("open"));
    });
  }

  window.MOH = {
    api,
    toast,
    showMessage,
    hideMessage,
    faNumber,
    escapeHtml,
    statusLabel,
    categoryLabel,
    formatDate,
    currentUser,
    requireAuth,
    logout
  };

  document.addEventListener("DOMContentLoaded", () => {
    setupTheme();
    setupPasswordToggles();
    setupMobileSidebar();

    document.querySelectorAll("#logoutButton").forEach((button) => {
      button.addEventListener("click", logout);
    });
  });
})();
