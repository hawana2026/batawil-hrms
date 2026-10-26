import {
  alertBox,
  api,
  el,
  errorBlock,
  formatNumber,
  icon,
  loadingBlock,
  openModal,
  pageHeader,
  setButtonLoading,
  statusBadge,
  toast,
} from "../core.js";
import { can, refreshMeta, state } from "../state.js";
import { actionButton, friendlyError, pageEnter } from "../ui.js";
import { canDeleteRecords, deleteRecord } from "../hr-common.js";

function branchCard(branch, manage) {
  const status = branch.active
    ? statusBadge("نشط", "success", "circle-check")
    : statusBadge("معطل", "danger", "circle-x");
  const card = el(
    "div",
    { class: "card branch-card" },
    el(
      "div",
      { class: "branch-card-head" },
      el(
        "div",
        { class: "branch-card-title" },
        el("span", { class: `metric-icon ${branch.active ? "blue" : "red"}` }, icon("building")),
        el(
          "div",
          {},
          el("h3", { text: branch.name }),
          el("p", {}, branch.city ? `${branch.city} · ` : "", el("span", { class: "branch-code", text: branch.code })),
        ),
      ),
      el(
        "div",
        { class: "inline-actions" },
        manage ? actionButton("pencil", "تعديل بيانات الفرع", () => openBranchForm(branch, card._reload)) : null,
        canDeleteRecords()
          ? actionButton("trash", "حذف الفرع نهائيًا", async () => {
              await deleteRecord({
                entity: "branch",
                id: branch.id,
                label: `فرع ${branch.name} (${branch.code})`,
                onDeleted: () => card._reload(),
              });
            }, { danger: true })
          : null,
      ),
    ),
    el("div", {}, status),
    el(
      "div",
      { class: "branch-stats" },
      el("div", { class: "branch-stat" }, el("strong", { class: "num", text: formatNumber(branch.userCount) }), el("span", { text: "مستخدمون مرتبطون" })),
      el("div", { class: "branch-stat" }, el("strong", { class: "num", text: formatNumber(branch.activeUserCount) }), el("span", { text: "حسابات نشطة" })),
    ),
  );
  return card;
}

async function openBranchForm(branch, reload) {
  const isEdit = Boolean(branch);
  const errorHost = el("div");
  const codeInput = el("input", {
    class: "input",
    id: "branch-code",
    value: branch?.code ?? "",
    placeholder: "مثال: SANAA",
    autocomplete: "off",
    dir: "ltr",
    required: true,
    maxlength: 20,
    pattern: "[A-Za-z0-9_-]{2,20}",
  });
  const nameInput = el("input", {
    class: "input",
    id: "branch-name",
    value: branch?.name ?? "",
    placeholder: "اسم الفرع",
    required: true,
    maxlength: 100,
  });
  const cityInput = el("input", {
    class: "input",
    id: "branch-city",
    value: branch?.city ?? "",
    placeholder: "المدينة (اختياري)",
    maxlength: 100,
  });
  const activeInput = branch
    ? el("input", { type: "checkbox", checked: branch.active })
    : null;
  const activeRow = activeInput
    ? el(
        "label",
        { class: "checkbox-row" },
        activeInput,
        el("span", {}, el("strong", { text: "الفرع نشط" }), el("br"), el("span", { class: "tiny muted", text: "لا يمكن تعطيل فرع مرتبط بمستخدمين نشطين." })),
      )
    : null;

  const form = el(
    "form",
    { id: "branch-form", novalidate: true },
    errorHost,
    el(
      "div",
      { class: "form-grid" },
      el(
        "div",
        { class: "form-field" },
        el("label", { class: "form-label", for: "branch-code", text: "رمز الفرع" }),
        codeInput,
        el("span", { class: "form-hint", text: "حروف لاتينية وأرقام، 2–20 حرفاً. يُحوَّل تلقائياً إلى أحرف كبيرة." }),
      ),
      el(
        "div",
        { class: "form-field" },
        el("label", { class: "form-label", for: "branch-name", text: "اسم الفرع" }),
        nameInput,
      ),
      el(
        "div",
        { class: "form-field span-2" },
        el("label", { class: "form-label", for: "branch-city", text: "المدينة" }),
        cityInput,
      ),
      activeRow ? el("div", { class: "form-field span-2" }, activeRow) : null,
    ),
  );

  let controller;
  let submitButton;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    errorHost.replaceChildren();
    const code = codeInput.value.trim();
    const name = nameInput.value.trim();
    if (!/^[A-Za-z0-9_-]{2,20}$/.test(code)) {
      errorHost.append(el("div", { class: "mb-16" }, alertBox("رمز الفرع غير صالح. استخدم 2–20 حرفاً لاتينياً أو رقماً أو شرطة.", "error")));
      codeInput.focus();
      return;
    }
    if (name.length < 2) {
      errorHost.append(el("div", { class: "mb-16" }, alertBox("اسم الفرع مطلوب.", "error")));
      nameInput.focus();
      return;
    }
    const body = { code, name, city: cityInput.value.trim() };
    if (isEdit) body.active = activeInput.checked;

    setButtonLoading(submitButton, true, isEdit ? "جارٍ الحفظ…" : "جارٍ الإنشاء…");
    try {
      if (isEdit) await api(`/api/branches/${branch.id}`, { method: "PATCH", body });
      else await api("/api/branches", { method: "POST", body });
      controller.close();
      toast(isEdit ? "تم تحديث بيانات الفرع." : "تم إنشاء الفرع بنجاح.", "success");
      await refreshMeta().catch(() => {});
      await reload();
    } catch (error) {
      errorHost.append(el("div", { class: "mb-16" }, alertBox(friendlyError(error), "error")));
      setButtonLoading(submitButton, false);
    }
  });

  submitButton = el(
    "button",
    { class: "btn btn-primary", type: "submit", form: "branch-form" },
    icon(isEdit ? "check" : "building"),
    isEdit ? "حفظ التغييرات" : "إنشاء الفرع",
  );

  controller = openModal({
    title: isEdit ? "تعديل بيانات الفرع" : "إضافة فرع",
    description: isEdit ? "تحديث الاسم أو الرمز أو حالة الفرع." : "أضف فرعاً جديداً ثم أسنِد إليه المستخدمين.",
    body: form,
    footer: [
      el("button", { class: "btn btn-ghost", type: "button", onclick: () => controller.close() }, "إلغاء"),
      submitButton,
    ],
  });
  codeInput.focus();
}

function summaryStrip(items) {
  const active = items.filter((branch) => branch.active).length;
  const users = items.reduce((total, branch) => total + branch.userCount, 0);
  return el(
    "div",
    { class: "summary-strip" },
    el(
      "div",
      { class: "summary-item" },
      el("span", { class: "metric-icon blue" }, icon("building")),
      el("div", {}, el("strong", { class: "num", text: formatNumber(items.length) }), el("span", { text: "إجمالي الفروع" })),
    ),
    el(
      "div",
      { class: "summary-item" },
      el("span", { class: "metric-icon green" }, icon("circle-check")),
      el("div", {}, el("strong", { class: "num", text: formatNumber(active) }), el("span", { text: "فروع نشطة" })),
    ),
    el(
      "div",
      { class: "summary-item" },
      el("span", { class: "metric-icon orange" }, icon("users")),
      el("div", {}, el("strong", { class: "num", text: formatNumber(users) }), el("span", { text: "ارتباطات المستخدمين" })),
    ),
    el(
      "div",
      { class: "summary-item" },
      el("span", { class: "metric-icon purple" }, icon("shield-check")),
      el("div", {}, el("strong", { text: "مركزي" }), el("span", { text: "نطاق البيانات" })),
    ),
  );
}

export async function renderBranches(host, token) {
  const manage = can("branches.manage") && state.user.allBranches;
  const node = pageEnter(
    pageHeader({
      title: "إدارة الفروع",
      subtitle: "هيكل الفروع المركزي الذي يحدد نطاق البيانات والمستخدمين.",
      actions: [
        el("button", { class: "btn btn-secondary", type: "button", onclick: () => load() }, icon("refresh"), "تحديث"),
        manage
          ? el("button", { class: "btn btn-primary", type: "button", onclick: () => openBranchForm(null, load) }, icon("plus"), "إضافة فرع")
          : null,
      ].filter(Boolean),
    }),
  );
  const contentHost = el("div");
  node.append(contentHost);
  host.replaceChildren(node);

  async function load() {
    contentHost.replaceChildren(loadingBlock("جارٍ تحميل الفروع…"));
    try {
      const data = await api("/api/branches");
      if (token !== state.renderToken) return;
      if (data.items.length === 0) {
        contentHost.replaceChildren(
          el(
            "div",
            { class: "card" },
            el(
              "div",
              { class: "empty-state" },
              el("span", { class: "empty-icon" }, icon("building")),
              el("h3", { class: "empty-title", text: "لا توجد فروع بعد" }),
              el("p", { class: "empty-text", text: "أنشئ أول فرع لتبدأ بإسناد المستخدمين وتحديد نطاق البيانات." }),
              manage
                ? el("button", { class: "btn btn-primary", type: "button", onclick: () => openBranchForm(null, load) }, icon("plus"), "إضافة فرع")
                : null,
            ),
          ),
        );
        return;
      }
      const cards = data.items.map((branch) => {
        const card = branchCard(branch, manage);
        card._reload = load;
        return card;
      });
      contentHost.replaceChildren(
        summaryStrip(data.items),
        el("div", { class: "branches-cards" }, cards),
      );
    } catch (error) {
      if (token !== state.renderToken) return;
      contentHost.replaceChildren(errorBlock(friendlyError(error), load));
    }
  }

  await load();
}
