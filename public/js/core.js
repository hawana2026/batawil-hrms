const SVG_NS = "http://www.w3.org/2000/svg";

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export async function api(path, options = {}) {
  const headers = { Accept: "application/json", "X-Requested-With": "XMLHttpRequest" };
  const init = {
    method: options.method ?? "GET",
    credentials: "same-origin",
    headers,
    signal: options.signal,
  };
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(options.body);
  }

  let response;
  try {
    response = await fetch(path, init);
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    throw new ApiError(0, "NETWORK_ERROR", "تعذر الاتصال بالخادم. تحقق من الشبكة وحاول مجدداً.");
  }

  if (response.status === 204) return null;

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const error = new ApiError(
      response.status,
      payload?.error?.code ?? "REQUEST_FAILED",
      payload?.error?.message ?? "تعذر إكمال العملية. حاول مجدداً.",
      payload?.error?.details,
    );
    if (response.status === 401 && path !== "/api/auth/login" && path !== "/api/auth/session") {
      window.dispatchEvent(new CustomEvent("app:unauthorized"));
    }
    if (response.status === 403 && error.code === "PASSWORD_CHANGE_REQUIRED") {
      window.dispatchEvent(new CustomEvent("app:password-required"));
    }
    throw error;
  }
  return payload;
}

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") {
      node.className = value;
    } else if (key === "dataset") {
      Object.assign(node.dataset, value);
    } else if (key === "text") {
      node.textContent = String(value);
    } else if (key === "value") {
      node.value = value;
    } else if (key === "checked" || key === "disabled" || key === "selected") {
      node[key] = Boolean(value);
    } else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) {
      node.setAttribute(key, "");
    } else {
      node.setAttribute(key, String(value));
    }
  }
  appendChildren(node, children);
  return node;
}

function appendChildren(node, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function icon(name, className = "icon") {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", className);
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const use = document.createElementNS(SVG_NS, "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
}

export function spinner(className = "spinner") {
  return el("span", { class: className, "aria-hidden": "true" });
}

export function initials(name) {
  const parts = String(name ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return "؟";
  return parts
    .slice(0, 2)
    .map((part) => Array.from(part)[0] ?? "")
    .join("");
}

export function avatar(name, size = "md") {
  return el("span", { class: `avatar avatar-${size}`, "aria-hidden": "true", text: initials(name) });
}

const dateFormatter = new Intl.DateTimeFormat("ar-EG", {
  calendar: "gregory",
  numberingSystem: "latn",
  useGrouping: false,
  day: "numeric",
  month: "long",
  year: "numeric",
});
const dateTimeFormatter = new Intl.DateTimeFormat("ar-EG", {
  calendar: "gregory",
  numberingSystem: "latn",
  useGrouping: false,
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
const dayFormatter = new Intl.DateTimeFormat("ar-EG", {
  calendar: "gregory",
  numberingSystem: "latn",
  useGrouping: false,
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
});
const numberFormatter = new Intl.NumberFormat("ar-EG", { numberingSystem: "latn" });

export function formatNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? numberFormatter.format(number) : "0";
}

export function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return dateFormatter.format(date);
}

export function formatDateTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return dateTimeFormatter.format(date);
}

export function formatFullDay(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return "";
  return dayFormatter.format(date);
}

export function formatRelative(value) {
  if (!value) return "لم يسجل الدخول بعد";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (seconds < 45) return "قبل لحظات";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `قبل ${formatNumber(minutes)} دقيقة`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `قبل ${formatNumber(hours)} ساعة`;
  const days = Math.round(hours / 24);
  if (days < 7) return `قبل ${formatNumber(days)} يوم`;
  return formatDate(value);
}

export function todayISO() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

export function greeting() {
  const hour = new Date().getHours();
  if (hour < 12) return "صباح الخير";
  if (hour < 17) return "مساء الخير";
  return "مساء النور";
}

let toastStack = null;

export function toast(message, type = "info") {
  if (!toastStack) {
    toastStack = el("div", { class: "toast-stack", role: "status", "aria-live": "polite" });
    document.body.append(toastStack);
  }
  const iconName = type === "success" ? "circle-check" : type === "error" ? "alert-circle" : type === "warning" ? "alert-triangle" : "info";
  const node = el(
    "div",
    { class: `toast toast-${type}` },
    icon(iconName),
    el("span", { class: "toast-text", text: message }),
    el(
      "button",
      {
        class: "toast-close",
        type: "button",
        "aria-label": "إغلاق",
        onclick: () => removeToast(node),
      },
      icon("close", "icon icon-sm"),
    ),
  );
  toastStack.append(node);
  requestAnimationFrame(() => node.classList.add("show"));
  const timer = setTimeout(() => removeToast(node), type === "error" ? 7000 : 4500);
  node._timer = timer;
}

function removeToast(node) {
  clearTimeout(node._timer);
  node.classList.remove("show");
  setTimeout(() => node.remove(), 220);
}

export function openModal({ title, description = "", body, footer = null, size = "md", onClose = null }) {
  const previouslyFocused = document.activeElement;
  const overlay = el("div", { class: "modal-overlay" });
  const closeButton = el(
    "button",
    { class: "icon-btn modal-close", type: "button", "aria-label": "إغلاق النافذة" },
    icon("close"),
  );
  const dialog = el("div", {
    class: `modal modal-${size}`,
    role: "dialog",
    "aria-modal": "true",
    "aria-label": String(title),
    tabindex: "-1",
  });
  const header = el(
    "header",
    { class: "modal-head" },
    el(
      "div",
      { class: "modal-heading" },
      el("h2", { class: "modal-title", text: title }),
      description ? el("p", { class: "modal-subtitle", text: description }) : null,
    ),
    closeButton,
  );
  const content = el("div", { class: "modal-body" }, body);
  dialog.append(header, content);
  if (footer) dialog.append(el("footer", { class: "modal-foot" }, footer));
  overlay.append(dialog);

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener("keydown", onKeydown);
    document.body.classList.remove("modal-open");
    overlay.classList.remove("open");
    setTimeout(() => overlay.remove(), 180);
    if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
    if (typeof onClose === "function") onClose();
  };
  const onKeydown = (event) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      close();
    }
    if (event.key === "Tab") {
      const focusable = dialog.querySelectorAll(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  };

  closeButton.addEventListener("click", close);
  overlay.addEventListener("mousedown", (event) => {
    if (event.target === overlay) close();
  });
  document.addEventListener("keydown", onKeydown);
  document.body.append(overlay);
  document.body.classList.add("modal-open");
  requestAnimationFrame(() => {
    overlay.classList.add("open");
    const target = dialog.querySelector("input:not([type=hidden]), select, textarea, button");
    (target ?? dialog).focus();
  });

  return { close, dialog, overlay };
}

export function confirmDialog({ title, message, confirmLabel = "تأكيد", cancelLabel = "إلغاء", danger = false }) {
  return new Promise((resolve) => {
    let settled = false;
    let controller = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (controller) controller.close();
      resolve(result);
    };
    const cancelButton = el("button", { class: "btn btn-ghost", type: "button", onclick: () => finish(false) }, cancelLabel);
    const confirmButton = el(
      "button",
      { class: `btn ${danger ? "btn-danger" : "btn-primary"}`, type: "button", onclick: () => finish(true) },
      confirmLabel,
    );
    controller = openModal({
      title,
      size: "sm",
      body: el("p", { class: "confirm-text", text: message }),
      footer: [cancelButton, confirmButton],
      onClose: () => {
        if (!settled) {
          settled = true;
          resolve(false);
        }
      },
    });
    requestAnimationFrame(() => confirmButton.focus());
  });
}

export function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text).then(
      () => true,
      () => fallbackCopy(text),
    );
  }
  return Promise.resolve(fallbackCopy(text));
}

function fallbackCopy(text) {
  const area = el("textarea", { class: "visually-hidden", readonly: true });
  area.value = text;
  document.body.append(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}

export function errorFields(error) {
  if (error instanceof ApiError && error.details && typeof error.details === "object" && error.details.fields) {
    return error.details.fields;
  }
  return {};
}

export function alertBox(message, type = "error") {
  const iconName = type === "error" ? "alert-circle" : type === "success" ? "circle-check" : "info";
  return el(
    "div",
    { class: `alert alert-${type}`, role: type === "error" ? "alert" : "status" },
    icon(iconName),
    el("span", { text: message }),
  );
}

export function fieldGroup({ label, control, error = "", hint = "", className = "" }) {
  const group = el(
    "div",
    { class: `form-field ${className}`.trim() },
    el("label", { class: "form-label", for: control.id || undefined, text: label }),
    control,
    hint ? el("span", { class: "form-hint", text: hint }) : null,
    error ? el("span", { class: "form-error", text: error }) : null,
  );
  return group;
}

export function inputField({ id, name, label, type = "text", value = "", placeholder = "", required = false, autocomplete, error = "", hint = "", minlength, maxlength, dir = "auto" }) {
  const input = el("input", {
    class: `input ${error ? "input-invalid" : ""}`,
    id,
    name,
    type,
    value,
    placeholder,
    required,
    autocomplete,
    minlength,
    maxlength,
    dir,
  });
  return { group: fieldGroup({ label, control: input, error, hint }), input };
}

export function buttonLink(label, href, iconName, className = "btn btn-ghost") {
  const link = el("a", { class: className, href }, iconName ? icon(iconName) : null, el("span", { text: label }));
  return link;
}

export function pageHeader({ title, subtitle, actions = [] }) {
  return el(
    "div",
    { class: "page-head" },
    el("div", { class: "page-heading" }, el("h1", { class: "page-title", text: title }), subtitle ? el("p", { class: "page-subtitle", text: subtitle }) : null),
    actions.length ? el("div", { class: "page-actions" }, actions) : null,
  );
}

export function emptyState({ title, message, iconName = "info", action = null }) {
  return el(
    "div",
    { class: "empty-state" },
    el("span", { class: "empty-icon" }, icon(iconName)),
    el("h3", { class: "empty-title", text: title }),
    el("p", { class: "empty-text", text: message }),
    action,
  );
}

export function loadingBlock(label = "جارٍ تحميل البيانات…") {
  return el(
    "div",
    { class: "loading-block", role: "status" },
    spinner("spinner spinner-lg"),
    el("span", { text: label }),
  );
}

export function errorBlock(message, retry) {
  return el(
    "div",
    { class: "error-block", role: "alert" },
    el("span", { class: "error-block-icon" }, icon("alert-triangle")),
    el("div", { class: "error-block-copy" }, el("strong", { text: "تعذر تحميل البيانات" }), el("p", { text: message })),
    retry ? el("button", { class: "btn btn-secondary", type: "button", onclick: retry }, icon("refresh"), "إعادة المحاولة") : null,
  );
}

export function statusBadge(label, tone = "neutral", iconName = null) {
  return el("span", { class: `status-badge status-${tone}` }, iconName ? icon(iconName, "icon icon-xs") : null, el("span", { text: label }));
}

export function setButtonLoading(button, loading, loadingLabel = "جارٍ التنفيذ…") {
  if (!button) return;
  if (loading) {
    if (!button._originalChildren) {
      button._originalChildren = [...button.childNodes].map((child) => child.cloneNode(true));
    }
    button.disabled = true;
    button.replaceChildren(spinner(), el("span", { text: loadingLabel }));
  } else {
    button.disabled = false;
    if (button._originalChildren) {
      button.replaceChildren(...button._originalChildren.map((child) => child.cloneNode(true)));
      button._originalChildren = null;
    }
  }
}

export function readForm(form) {
  const data = Object.fromEntries(new FormData(form).entries());
  return data;
}

export function showPasswordToggle(input, button) {
  button.addEventListener("click", () => {
    const showing = input.type === "text";
    input.type = showing ? "password" : "text";
    button.setAttribute("aria-label", showing ? "إظهار كلمة المرور" : "إخفاء كلمة المرور");
    button.replaceChildren(icon(showing ? "eye" : "eye-off"));
  });
}
