(function () {
  "use strict";

  const {
    api,
    requireAuth,
    toast,
    showMessage,
    escapeHtml
  } = window.MOH;

  let canvas;
  let ctx;
  let drawing = false;
  let hasSignature = false;

  function setupPersonChoice() {
    const radios = document.querySelectorAll('input[name="filed_for"]');
    const other = document.getElementById("otherPersonFields");

    radios.forEach((radio) => {
      radio.addEventListener("change", () => {
        const visible = radio.value === "other" && radio.checked;
        if (visible) {
          other.classList.remove("hidden");
        } else if (radio.value === "self" && radio.checked) {
          other.classList.add("hidden");
        }
      });
    });
  }

  function setupDescriptionCounter() {
    const textarea = document.querySelector('[name="description"]');
    const counter = document.getElementById("descriptionCount");

    function update() {
      counter.textContent = `${textarea.value.length.toLocaleString("fa-IR")} / ۵۰۰۰`;
    }

    textarea.addEventListener("input", update);
    update();
  }

  function setupFiles() {
    const input = document.getElementById("files");
    const list = document.getElementById("fileList");

    input.addEventListener("change", () => {
      const files = Array.from(input.files || []);

      if (files.length > 5) {
        input.value = "";
        list.innerHTML = "";
        toast("حداکثر ۵ فایل می‌توانید انتخاب کنید.");
        return;
      }

      list.innerHTML = files.map((file) => `
        <div class="selected-file">
          <span>${escapeHtml(file.name)}</span>
          <span>${Math.ceil(file.size / 1024).toLocaleString("fa-IR")} KB</span>
        </div>
      `).join("");
    });
  }

  function setupSignature() {
    canvas = document.getElementById("signatureCanvas");
    ctx = canvas.getContext("2d");

    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#111827";

    function coordinates(event) {
      const rect = canvas.getBoundingClientRect();

      const source = event.touches ? event.touches[0] : event;

      return {
        x: (source.clientX - rect.left) * (canvas.width / rect.width),
        y: (source.clientY - rect.top) * (canvas.height / rect.height)
      };
    }

    function start(event) {
      event.preventDefault();
      drawing = true;
      hasSignature = true;

      const p = coordinates(event);
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
    }

    function move(event) {
      if (!drawing) return;

      event.preventDefault();

      const p = coordinates(event);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
    }

    function end() {
      drawing = false;
    }

    canvas.addEventListener("mousedown", start);
    canvas.addEventListener("mousemove", move);
    window.addEventListener("mouseup", end);

    canvas.addEventListener("touchstart", start, { passive: false });
    canvas.addEventListener("touchmove", move, { passive: false });
    canvas.addEventListener("touchend", end);

    document.getElementById("clearSignature").addEventListener("click", () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      hasSignature = false;
    });
  }

  function clearErrors() {
    document.querySelectorAll(".field-error").forEach((el) => {
      el.textContent = "";
    });
  }

  function showErrors(fields) {
    Object.entries(fields || {}).forEach(([key, value]) => {
      const el = document.querySelector(`[data-error-for="${key}"]`);
      if (el) el.textContent = value || "";
    });
  }

  function setupSubmit() {
    const form = document.getElementById("complaintForm");
    const message = document.getElementById("complaintMessage");
    const button = document.getElementById("submitComplaint");

    form.addEventListener("submit", async (event) => {
      event.preventDefault();

      clearErrors();
      message.className = "message-box hidden";

      if (!hasSignature) {
        const error = document.querySelector('[data-error-for="signature"]');
        error.textContent = "امضا الزامی است.";
        toast("لطفاً امضای خود را ثبت کنید.");
        return;
      }

      const signatureInput = document.getElementById("signatureInput");
      signatureInput.value = canvas.toDataURL("image/png");

      const formData = new FormData(form);

      button.disabled = true;
      button.textContent = "در حال ثبت پرونده...";

      try {
        const result = await api("/api/cases", {
          method: "POST",
          body: formData
        });

        showMessage(
          message,
          `پرونده با موفقیت ثبت شد. کد رهگیری: ${result.case.tracking_code}`,
          "success"
        );

        form.reset();

        ctx.clearRect(0, 0, canvas.width, canvas.height);
        hasSignature = false;

        document.getElementById("fileList").innerHTML = "";

        setTimeout(() => {
          location.href = "/user.html#cases";
        }, 2500);
      } catch (error) {
        showErrors(error.fields);

        showMessage(
          message,
          error.message || "ثبت پرونده ناموفق بود."
        );

        window.scrollTo({
          top: 0,
          behavior: "smooth"
        });
      } finally {
        button.disabled = false;
        button.textContent = "ثبت نهایی شکایت";
      }
    });
  }

  async function init() {
    const user = await requireAuth(["user", "admin"]);
    if (!user) return;

    setupPersonChoice();
    setupDescriptionCounter();
    setupFiles();
    setupSignature();
    setupSubmit();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
