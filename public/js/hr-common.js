import {
  alertBox,
  api,
  confirmDialog,
  el,
  formatDate,
  formatDateTime,
  formatNumber,
  icon,
  openModal,
  setButtonLoading,
  statusBadge,
  toast,
  todayISO,
} from "./core.js";
import { can, state } from "./state.js";
import { friendlyError } from "./ui.js";

export const ATT_STATUS = {
  present: { label: "حاضر", symbol: "ح", tone: "success", icon: "user-check" },
  absent: { label: "غائب", symbol: "غ", tone: "danger", icon: "circle-x" },
  leave: { label: "إجازة", symbol: "إ", tone: "info", icon: "calendar" },
  permission: { label: "إذن", symbol: "ذ", tone: "warning", icon: "clock" },
  mission: { label: "مهمة", symbol: "م", tone: "purple", icon: "globe" },
  weekly_rest: { label: "راحة أسبوعية", symbol: "ر", tone: "neutral", icon: "calendar" },
  late: { label: "تأخير", symbol: "ت", tone: "warning", icon: "clock" },
  excused_absence: { label: "غياب بعذر", symbol: "ع", tone: "neutral", icon: "info" },
};

export const ATT_ORDER = ["present", "absent", "leave", "permission", "mission", "weekly_rest", "late", "excused_absence"];

export const EMP_STATUS = {
  active: { label: "نشط", tone: "success" },
  leave: { label: "إجازة", tone: "info" },
  suspended: { label: "موقوف", tone: "warning" },
  resigned: { label: "مستقيل", tone: "neutral" },
  transferred: { label: "منقول", tone: "purple" },
};

export const SUBMISSION_STATUS = {
  draft: { label: "مسودة", tone: "neutral" },
  submitted: { label: "مرسل للاعتماد", tone: "info" },
  approved: { label: "معتمد", tone: "success" },
  rejected: { label: "معاد", tone: "warning" },
};

export const LEAVE_TYPES = {
  annual: "إجازة سنوية",
  sick: "إجازة مرضية",
  unpaid: "إجازة بدون راتب",
  emergency: "إجازة طارئة",
  permission: "إذن",
  other: "أخرى",
};

export const LEAVE_STATUS = {
  draft: { label: "مسودة", tone: "neutral" },
  pending: { label: "بانتظار الاعتماد", tone: "info" },
  approved: { label: "معتمدة", tone: "success" },
  rejected: { label: "مرفوضة", tone: "danger" },
  cancelled: { label: "ملغاة", tone: "neutral" },
};

export const ADVANCE_STATUS = {
  draft: { label: "مسودة", tone: "neutral" },
  pending_hr: { label: "بانتظار الموارد البشرية", tone: "info" },
  pending_finance: { label: "بانتظار المالية", tone: "warning" },
  approved: { label: "معتمدة", tone: "success" },
  rejected: { label: "مرفوضة", tone: "danger" },
  disbursed: { label: "مصروفة", tone: "purple" },
};

export const TRANSFER_STATUS = {
  pending: { label: "بانتظار الاعتماد", tone: "info" },
  approved: { label: "معتمد", tone: "success" },
  rejected: { label: "مرفوض", tone: "danger" },
  cancelled: { label: "ملغى", tone: "neutral" },
};

export const NEW_HIRE_STATUS = {
  draft: { label: "مسودة", tone: "neutral" },
  pending: { label: "بانتظار الاعتماد", tone: "info" },
  approved: { label: "معتمد", tone: "success" },
  completed: { label: "مرحّب به", tone: "success" },
  rejected: { label: "مرفوض", tone: "danger" },
};

export const PAYROLL_STATUS = {
  draft: { label: "مسودة", tone: "neutral" },
  reviewed: { label: "تمت المراجعة", tone: "info" },
  approved: { label: "معتمد", tone: "success" },
};

export const FOLLOW_STATUS = {
  not_started: { label: "لم يبدأ", tone: "danger" },
  in_progress: { label: "قيد العمل", tone: "warning" },
  complete_unsubmitted: { label: "مكتمل غير مرسل", tone: "info" },
  submitted: { label: "مرسل", tone: "info" },
  approved: { label: "معتمد", tone: "success" },
  returned: { label: "معاد", tone: "warning" },
};

export const DEPT_NONE = "بدون قسم";

export const MONTH_NAMES = [
  "يناير",
  "فبراير",
  "مارس",
  "أبريل",
  "مايو",
  "يونيو",
  "يوليو",
  "أغسطس",
  "سبتمبر",
  "أكتوبر",
  "نوفمبر",
  "ديسمبر",
];

export function monthLabel(year, month) {
  return `${MONTH_NAMES[month - 1] ?? ""} ${String(year)}`;
}

export function monthValue(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

export function parseMonthValue(value) {
  const [year, month] = String(value || "").split("-").map(Number);
  if (!year || !month) {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() + 1 };
  }
  return { year, month };
}

export function statusTag(map, status) {
  const meta = map[status] ?? { label: status || "—", tone: "neutral" };
  return statusBadge(meta.label, meta.tone);
}

export function attTag(status) {
  const meta = ATT_STATUS[status];
  if (!meta) return el("span", { class: "tiny muted", text: "—" });
  return statusBadge(meta.label, meta.tone);
}

export function attSymbol(status) {
  return ATT_STATUS[status]?.symbol ?? "";
}

export function empTag(status) {
  return statusTag(EMP_STATUS, status);
}

export function money(value) {
  const currency = state.meta?.company?.currency || "YER";
  const number = Number(value ?? 0);
  const formatted = new Intl.NumberFormat("ar-EG", { numberingSystem: "latn", maximumFractionDigits: 2 }).format(
    Number.isFinite(number) ? number : 0,
  );
  return `${formatted} ${currency}`;
}

export function branchList() {
  return state.meta?.branches ?? state.user?.branches ?? [];
}

export function defaultBranchId() {
  return branchList().find((branch) => branch.active)?.id ?? branchList()[0]?.id ?? "";
}

export function branchSelectOptions(selected = "", { allLabel = "" } = {}) {
  const options = [];
  if (allLabel) options.push(el("option", { value: "", selected: !selected }, allLabel));
  for (const branch of branchList()) {
    options.push(
      el(
        "option",
        { value: branch.id, selected: branch.id === selected },
        `${branch.name}${branch.active ? "" : " (معطل)"}`,
      ),
    );
  }
  return options;
}

export function departmentList() {
  return state.meta?.departments ?? [];
}

export function selectOptions(items, selected = "", placeholder = "") {
  const options = [];
  if (placeholder) options.push(el("option", { value: "", selected: !selected }, placeholder));
  for (const item of items) {
    const value = typeof item === "string" ? item : item.value;
    const label = typeof item === "string" ? item : item.label;
    options.push(el("option", { value, selected: value === selected, disabled: Boolean(item.disabled) }, label));
  }
  return options;
}

export function statusSelectOptions(map, selected = "", placeholder = "") {
  return selectOptions(
    Object.entries(map).map(([value, meta]) => ({ value, label: meta.label })),
    selected,
    placeholder,
  );
}

export function filterBar(fields, { onApply, onReset, extra = null }) {
  const form = el(
    "form",
    {
      class: "filter-bar filter-wrap",
      onsubmit: (event) => {
        event.preventDefault();
        onApply();
      },
    },
    ...fields.map((field) =>
      el(
        "div",
        { class: "form-field" },
        el("label", { class: "form-label", text: field.label }),
        field.control,
      ),
    ),
    el(
      "div",
      { class: "filter-actions" },
      el("button", { class: "btn btn-primary", type: "submit" }, icon("search"), "عرض"),
      onReset
        ? el(
            "button",
            {
              class: "btn btn-ghost",
              type: "button",
              onclick: () => {
                onReset();
              },
            },
            "مسح",
          )
        : null,
      extra,
    ),
  );
  return form;
}

export function summaryStrip(items) {
  return el(
    "div",
    { class: "summary-strip summary-grid" },
    items.map((item) =>
      el(
        "div",
        { class: "summary-item" },
        el("span", { class: `metric-icon ${item.tone ?? "blue"}` }, icon(item.iconName ?? "activity")),
        el(
          "div",
          {},
          el("strong", { class: "num", text: typeof item.value === "number" ? formatNumber(item.value) : item.value }),
          el("span", { text: item.label }),
        ),
      ),
    ),
  );
}

export function emptyCell(text = "—") {
  return el("span", { class: "tiny muted", text });
}

export function personCell(name, sub = "", no = "") {
  return el(
    "div",
    { class: "cell-person" },
    el(
      "div",
      {},
      el("strong", { text: name || "—" }),
      sub || no ? el("span", { text: [no, sub].filter(Boolean).join(" · ") }) : null,
    ),
  );
}

function fieldControl(spec, initial) {
  const value = initial ?? spec.value ?? "";
  if (spec.type === "select") {
    const select = el(
      "select",
      {
        class: "select",
        id: spec.id ?? `f-${spec.name}`,
        name: spec.name,
        required: spec.required,
        disabled: spec.disabled,
      },
      ...selectOptions(spec.options ?? [], value, spec.placeholder ?? ""),
    );
    return { control: select, get: () => select.value };
  }
  if (spec.type === "textarea") {
    const area = el("textarea", {
      class: "textarea",
      id: spec.id ?? `f-${spec.name}`,
      name: spec.name,
      rows: spec.rows ?? 3,
      placeholder: spec.placeholder ?? "",
      required: spec.required,
      disabled: spec.disabled,
      maxlength: spec.maxlength,
      dir: spec.dir ?? "auto",
    });
    area.value = value;
    return { control: area, get: () => area.value.trim() };
  }
  if (spec.type === "checkbox") {
    const input = el("input", { type: "checkbox", id: spec.id ?? `f-${spec.name}`, name: spec.name, disabled: spec.disabled });
    input.checked = Boolean(initial ?? spec.checked ?? false);
    return { control: input, get: () => input.checked };
  }
  const input = el("input", {
    class: "input",
    id: spec.id ?? `f-${spec.name}`,
    name: spec.name,
    type: spec.type ?? "text",
    placeholder: spec.placeholder ?? "",
    required: spec.required,
    disabled: spec.disabled,
    readonly: spec.readonly,
    min: spec.min,
    max: spec.max,
    step: spec.step,
    minlength: spec.minlength,
    maxlength: spec.maxlength,
    pattern: spec.pattern,
    autocomplete: spec.autocomplete ?? "off",
    dir: spec.dir ?? (spec.type === "number" || spec.type === "date" || spec.type === "time" ? "ltr" : "auto"),
    accept: spec.accept,
  });
  input.value = value;
  return { control: input, get: () => input.value.trim() };
}

export function openFormDialog({
  title,
  description = "",
  fields,
  values = {},
  submitLabel = "حفظ",
  size = "md",
  submitIcon = "check",
  onSubmit,
  footerExtra = null,
  intro = null,
}) {
  const errorHost = el("div");
  const controls = new Map();
  const formId = `dlg-form-${Math.random().toString(36).slice(2)}`;

  const fieldNodes = fields.map((spec) => {
    const { control, get } = fieldControl(spec, values[spec.name]);
    controls.set(spec.name, { get, spec });
    if (spec.type === "checkbox") {
      return el(
        "label",
        { class: `checkbox-row field-${spec.name} ${spec.span === 2 ? "span-2" : ""}` },
        control,
        el("span", {}, el("strong", { text: spec.label }), spec.hint ? el("span", { class: "tiny muted", text: ` ${spec.hint}` }) : null),
      );
    }
    return el(
      "div",
      { class: `form-field ${spec.span === 2 ? "span-2" : ""}` },
      el("label", { class: "form-label", for: control.id, text: spec.label }),
      control,
      spec.hint ? el("span", { class: "form-hint", text: spec.hint }) : null,
    );
  });

  const form = el(
    "form",
    { class: "dialog-form", id: formId, novalidate: true },
    intro,
    errorHost,
    el("div", { class: "form-grid" }, fieldNodes),
  );

  let controller = null;
  const submit = el(
    "button",
    { class: "btn btn-primary", type: "button", onclick: () => form.requestSubmit() },
    icon(submitIcon),
    submitLabel,
  );
  const cancel = el(
    "button",
    { class: "btn btn-ghost", type: "button", onclick: () => controller.close() },
    "إلغاء",
  );

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    errorHost.replaceChildren();
    for (const [name, { get, spec }] of controls) {
      const value = get();
      if (spec.required && (value === "" || value === null || value === undefined)) {
        errorHost.append(alertBox(`الحقل "${spec.label}" مطلوب.`, "error"));
        return;
      }
    }
    const payload = {};
    for (const [name, { get }] of controls) payload[name] = get();
    setButtonLoading(submit, true, "جارٍ الحفظ…");
    try {
      const result = await onSubmit(payload, { close: () => controller.close(), errorHost, submit });
      if (result !== false) controller.close();
    } catch (error) {
      errorHost.append(alertBox(friendlyError(error), "error"));
    } finally {
      setButtonLoading(submit, false);
    }
  });

  controller = openModal({
    title,
    description,
    size,
    body: form,
    footer: [footerExtra, cancel, submit].filter(Boolean),
  });
  return controller;
}

export function openReasonDialog({
  title,
  message = "",
  label = "السبب",
  confirmLabel = "تأكيد",
  danger = false,
  minLength = 3,
  hint = "",
}) {
  return new Promise((resolve) => {
    let settled = false;
    let controller = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      controller?.close();
      resolve(value);
    };
    const input = el("textarea", {
      class: "textarea",
      rows: 3,
      maxlength: 1000,
      placeholder: "اكتب السبب بوضوح ليظهر في سجل العملية…",
    });
    const errorHost = el("div");
    const body = el(
      "div",
      {},
      message ? el("p", { class: "confirm-text", text: message }) : null,
      el("div", { class: "form-field" }, el("label", { class: "form-label", text: label }), input),
      hint ? el("p", { class: "form-hint", text: hint }) : null,
      errorHost,
    );
    const submit = el(
      "button",
      { class: `btn ${danger ? "btn-danger" : "btn-primary"}`, type: "button", onclick: () => {
          const value = input.value.trim();
          if (value.length < minLength) {
            errorHost.replaceChildren(alertBox(`اكتب سبباً لا يقل عن ${formatNumber(minLength)} أحرف.`, "error"));
            input.focus();
            return;
          }
          finish(value);
        } },
      confirmLabel,
    );
    controller = openModal({
      title,
      size: "sm",
      body,
      footer: [el("button", { class: "btn btn-ghost", type: "button", onclick: () => finish(null) }, "إلغاء"), submit],
      onClose: () => {
        if (!settled) {
          settled = true;
          resolve(null);
        }
      },
    });
    requestAnimationFrame(() => input.focus());
  });
}

export function detailRows(rows) {
  return el(
    "div",
    { class: "detail-grid" },
    rows
      .filter(Boolean)
      .map((row) =>
        el(
          "div",
          { class: "detail-row" },
          el("span", { class: "detail-label", text: row[0] }),
          el("div", { class: "detail-value" }, row[1] instanceof Node ? row[1] : String(row[1] ?? "—")),
        ),
      ),
  );
}

export function formGrid(fields) {
  return el("div", { class: "form-grid" }, fields);
}

export async function downloadFile(path, fallbackName = "download") {
  let response;
  try {
    response = await fetch(path, {
      credentials: "same-origin",
      headers: { Accept: "application/octet-stream", "X-Requested-With": "XMLHttpRequest" },
    });
  } catch {
    throw new Error("تعذر الاتصال بالخادم لتنزيل الملف.");
  }
  if (!response.ok) {
    let message = "تعذر تنزيل الملف.";
    try {
      const payload = await response.json();
      message = payload?.error?.message ?? message;
    } catch {
      /* ignore */
    }
    throw new Error(message);
  }
  const blob = await response.blob();
  const disposition = response.headers.get("content-disposition") ?? "";
  let filename = fallbackName;
  const utf = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
  const plain = /filename="?([^";]+)"?/i.exec(disposition);
  if (utf) {
    try {
      filename = decodeURIComponent(utf[1]);
    } catch {
      /* ignore */
    }
  } else if (plain) {
    filename = plain[1];
  }
  const url = URL.createObjectURL(blob);
  const link = el("a", { href: url, download: filename, style: "display:none" });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function printHeader({ title, subtitle = "", meta = [] }) {
  const company = state.meta?.company?.name || "BATAWIL";
  const footer = state.meta?.company?.printFooter || "نظام الموارد البشرية BATAWIL";
  return el(
    "div",
    { class: "print-header" },
    el(
      "div",
      { class: "print-brand" },
      el("span", { class: "print-logo" }, icon("shield-check")),
      el("div", {}, el("strong", { text: company }), el("span", { text: footer })),
    ),
    el(
      "div",
      { class: "print-title" },
      el("h2", { text: title }),
      subtitle ? el("p", { text: subtitle }) : null,
    ),
    el(
      "div",
      { class: "print-meta" },
      ...meta.map((item) => el("span", { text: item })),
      el("span", { text: `طُبع في: ${formatDateTime(new Date().toISOString())}` }),
    ),
  );
}

export function printPage({ landscape = false } = {}) {
  const style = el(
    "style",
    {},
    `@page { size: A4 ${landscape ? "landscape" : "portrait"}; margin: 10mm; }`,
  );
  style.id = "print-orientation";
  document.head.append(style);
  const cleanup = () => {
    style.remove();
    window.removeEventListener("afterprint", cleanup);
  };
  window.addEventListener("afterprint", cleanup);
  requestAnimationFrame(() => {
    window.print();
    setTimeout(cleanup, 1000);
  });
}

export function hashParams() {
  const raw = window.location.hash.replace(/^#\/?/, "");
  const index = raw.indexOf("?");
  return new URLSearchParams(index === -1 ? "" : raw.slice(index + 1));
}

export function navigateHash(id, params = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== "" && value !== null && value !== undefined) search.set(key, value);
  }
  const suffix = search.toString() ? `?${search.toString()}` : "";
  const target = `#/${id}${suffix}`;
  if (window.location.hash === target) {
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  } else {
    window.location.hash = target;
  }
}

export function fileSize(bytes) {
  const value = Number(bytes ?? 0);
  if (value < 1024) return `${formatNumber(value)} بايت`;
  if (value < 1024 * 1024) return `${formatNumber(Math.round(value / 1024))} ك.ب`;
  return `${new Intl.NumberFormat("ar-EG", { numberingSystem: "latn", maximumFractionDigits: 1 }).format(value / (1024 * 1024))} م.ب`;
}

export function attachmentsPanel({ ownerType, ownerId, canEdit = false }) {
  const listHost = el("div", { class: "attachment-list" }, el("span", { class: "tiny muted", text: "جارٍ تحميل المرفقات…" }));
  const input = el("input", {
    type: "file",
    accept: ".pdf,.png,.jpg,.jpeg,.webp,.docx,.xlsx",
    class: "visually-hidden",
  });
  const uploadButton = el(
    "button",
    { class: "btn btn-secondary btn-sm", type: "button", onclick: () => input.click() },
    icon("upload"),
    "إرفاق ملف",
  );
  const errorHost = el("div");

  async function reload() {
    try {
      const data = await api(`/api/attachments?ownerType=${ownerType}&ownerId=${ownerId}`);
      if (!data.items.length) {
        listHost.replaceChildren(el("p", { class: "tiny muted", text: "لا توجد مرفقات." }));
        return;
      }
      listHost.replaceChildren(
        ...data.items.map((item) =>
          el(
            "div",
            { class: "attachment-item" },
            icon("file-text"),
            el(
              "div",
              { class: "attachment-copy" },
              el("strong", { text: item.fileName }),
              el("span", { text: `${fileSize(item.sizeBytes)} · ${item.uploadedBy || "—"} · ${formatDate(item.createdAt)}` }),
            ),
            el(
              "div",
              { class: "attachment-actions" },
              el(
                "button",
                {
                  class: "icon-btn",
                  type: "button",
                  title: "تنزيل المرفق",
                  onclick: async () => {
                    try {
                      await downloadFile(`/api/attachments/${item.id}/download`, item.fileName);
                    } catch (error) {
                      toast(error.message, "error");
                    }
                  },
                },
                icon("download"),
              ),
              canEdit
                ? el(
                    "button",
                    {
                      class: "icon-btn danger",
                      type: "button",
                      title: "حذف المرفق",
                      onclick: async () => {
                        const ok = await confirmDialog({
                          title: "حذف المرفق",
                          message: `سيتم حذف "${item.fileName}" نهائياً.`,
                          confirmLabel: "حذف",
                          danger: true,
                        });
                        if (!ok) return;
                        try {
                          await api(`/api/attachments/${item.id}`, { method: "DELETE" });
                          toast("تم حذف المرفق.", "success");
                          await reload();
                        } catch (error) {
                          toast(friendlyError(error), "error");
                        }
                      },
                    },
                    icon("trash"),
                  )
                : null,
            ),
          ),
        ),
      );
    } catch (error) {
      listHost.replaceChildren(el("p", { class: "tiny muted", text: friendlyError(error) }));
    }
  }

  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (!file) return;
    errorHost.replaceChildren();
    if (file.size > 2 * 1024 * 1024) {
      errorHost.append(alertBox("الحد الأقصى لحجم الملف 2 ميجابايت.", "error"));
      input.value = "";
      return;
    }
    setButtonLoading(uploadButton, true, "جارٍ الرفع…");
    try {
      const response = await fetch(
        `/api/attachments?ownerType=${ownerType}&ownerId=${ownerId}&fileName=${encodeURIComponent(file.name)}`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "Content-Type": file.type || "application/octet-stream",
            "X-Requested-With": "XMLHttpRequest",
          },
          body: file,
        },
      );
      if (!response.ok) {
        let message = "تعذر رفع المرفق.";
        try {
          const payload = await response.json();
          message = payload?.error?.message ?? message;
        } catch {
          /* ignore */
        }
        throw new Error(message);
      }
      toast("تم رفع المرفق.", "success");
      input.value = "";
      await reload();
    } catch (error) {
      errorHost.append(alertBox(error.message, "error"));
    } finally {
      setButtonLoading(uploadButton, false);
    }
  });

  const node = el(
    "div",
    { class: "card section-card" },
    el(
      "div",
      { class: "section-head" },
      el("div", {}, el("h3", { class: "section-title" }, icon("file-text"), "المرفقات")),
      canEdit ? el("div", {}, uploadButton, input) : null,
    ),
    errorHost,
    listHost,
  );
  reload();
  return { node, reload };
}

export function canAny(permissions) {
  return permissions.some((permission) => can(permission));
}

export function todayLabel() {
  return formatDate(todayISO());
}

export { todayISO };
