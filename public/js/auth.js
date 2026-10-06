(function () {
  "use strict";

  const {
    api,
    showMessage,
    hideMessage
  } = window.MOH;

  const loginForm = document.getElementById("loginForm");
  const registerForm = document.getElementById("registerForm");
  const authMessage = document.getElementById("authMessage");
  const tabs = document.querySelectorAll(".auth-tab");

  function setMode(mode) {
    const register = mode === "register";

    loginForm.classList.toggle("hidden", register);
    registerForm.classList.toggle("hidden", !register);

    tabs.forEach((tab) => {
      tab.classList.toggle("active", tab.dataset.mode === mode);
    });

    hideMessage(authMessage);
    clearErrors();
    history.replaceState(null, "", `/auth.html?mode=${mode}`);
  }

  function clearErrors(form = document) {
    form.querySelectorAll(".field-error").forEach((el) => {
      el.textContent = "";
    });
  }

  function showFieldErrors(form, fields) {
    Object.entries(fields || {}).forEach(([key, value]) => {
      const el = form.querySelector(`[data-error-for="${key}"]`);
      if (el) el.textContent = value || "";
    });
  }

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => setMode(tab.dataset.mode));
  });

  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    clearErrors(loginForm);
    hideMessage(authMessage);

    const formData = new FormData(loginForm);

    const payload = {
      phone: formData.get("phone"),
      password: formData.get("password")
    };

    const button = loginForm.querySelector("button[type=submit]");
    button.disabled = true;
    button.textContent = "در حال ورود...";

    try {
      const result = await api("/api/auth/login", {
        method: "POST",
        body: JSON.stringify(payload)
      });

      location.href = result.redirect || "/user.html";
    } catch (error) {
      showFieldErrors(loginForm, error.fields);
      showMessage(authMessage, error.message || "ورود ناموفق بود.");
    } finally {
      button.disabled = false;
      button.textContent = "ورود";
    }
  });

  registerForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    clearErrors(registerForm);
    hideMessage(authMessage);

    const formData = new FormData(registerForm);

    const payload = {
      full_name: formData.get("full_name"),
      phone: formData.get("phone"),
      password: formData.get("password"),
      password_confirm: formData.get("password_confirm"),
      accept_terms: formData.get("accept_terms") === "true"
    };

    const button = registerForm.querySelector("button[type=submit]");
    button.disabled = true;
    button.textContent = "در حال ایجاد حساب...";

    try {
      const result = await api("/api/auth/register", {
        method: "POST",
        body: JSON.stringify(payload)
      });

      showMessage(authMessage, "حساب شما با موفقیت ایجاد شد.", "success");

      setTimeout(() => {
        location.href = result.redirect || "/user.html";
      }, 500);
    } catch (error) {
      showFieldErrors(registerForm, error.fields);
      showMessage(authMessage, error.message || "ثبت‌نام ناموفق بود.");
    } finally {
      button.disabled = false;
      button.textContent = "ایجاد حساب";
    }
  });

  async function redirectIfLoggedIn() {
    try {
      const data = await api("/api/auth/me");

      if (data.user.role === "admin") {
        location.href = "/admin.html";
      } else {
        location.href = "/user.html";
      }
    } catch {
      // کاربر وارد نشده است؛ صفحه عادی نمایش داده می‌شود.
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    const mode = new URLSearchParams(location.search).get("mode");
    setMode(mode === "register" ? "register" : "login");
    redirectIfLoggedIn();
  });
})();
