import {
  alertBox,
  api,
  confirmDialog,
  el,
  errorBlock,
  formatDateTime,
  formatNumber,
  icon,
  loadingBlock,
  pageHeader,
  setButtonLoading,
  toast,
} from "../core.js";
import { refreshMeta, state } from "../state.js";
import { friendlyError, pageEnter } from "../ui.js";
import { detailRows, openFormDialog } from "../hr-common.js";

const WEEKDAYS = [
  { value: 0, label: "الأحد" },
  { value: 1, label: "الاثنين" },
  { value: 2, label: "الثلاثاء" },
  { value: 3, label: "الأربعاء" },
  { value: 4, label: "الخميس" },
  { value: 5, label: "الجمعة" },
  { value: 6, label: "السبت" },
];

export async function renderSettings(host, token) {
  host.replaceChildren(loadingBlock("جارٍ تحميل إعدادات النظام…"));
  let data;
  let departments;
  try {
    [data, departments] = await Promise.all([api("/api/settings"), api("/api/departments?includeInactive=true")]);
  } catch (error) {
    if (token !== state.renderToken) return;
    host.replaceChildren(errorBlock(friendlyError(error), () => renderSettings(host, token)));
    return;
  }
  if (token !== state.renderToken) return;

  const canManage = Boolean(data.capabilities?.canManage);
  const companyName = el("input", { class: "input", value: data.company.name, maxlength: 160, disabled: !canManage });
  const currency = el("input", { class: "input", value: data.company.currency, maxlength: 10, disabled: !canManage, dir: "ltr" });
  const printFooter = el("textarea", { class: "textarea", rows: 2, maxlength: 300, disabled: !canManage });
  printFooter.value = data.company.printFooter || "";
  const workStart = el("input", { class: "input", type: "time", value: data.attendance.workStart, disabled: !canManage });
  const workEnd = el("input", { class: "input", type: "time", value: data.attendance.workEnd, disabled: !canManage });
  const grace = el("input", { class: "input", type: "number", min: 0, max: 240, value: data.attendance.lateGraceMinutes, disabled: !canManage });
  const weekendInputs = WEEKDAYS.map((day) => {
    const input = el("input", { type: "checkbox", checked: data.attendance.weekendDays.includes(day.value), disabled: !canManage });
    return { ...day, input };
  });

  const errorHost = el("div");
  const saveButton = el("button", { class: "btn btn-primary", type: "submit" }, icon("check"), "حفظ الإعدادات");
  const form = el(
    "form",
    { class: "settings-form", novalidate: true },
    el(
      "div",
      { class: "card section-card" },
      el("div", { class: "section-head" }, el("div", {}, el("h3", { class: "section-title" }, icon("building"), "بيانات الشركة والطباعة"))),
      errorHost,
      el(
        "div",
        { class: "form-grid" },
        el("div", { class: "form-field" }, el("label", { class: "form-label", text: "اسم الشركة" }), companyName, el("span", { class: "form-hint", text: "يظهر في رأس كل تقرير وكشف مطبوع." })),
        el("div", { class: "form-field" }, el("label", { class: "form-label", text: "رمز العملة" }), currency, el("span", { class: "form-hint", text: "مثال: YER أو SAR." })),
        el("div", { class: "form-field span-2" }, el("label", { class: "form-label", text: "تذييل الطباعة" }), printFooter),
      ),
    ),
    el(
      "div",
      { class: "card section-card" },
      el("div", { class: "section-head" }, el("div", {}, el("h3", { class: "section-title" }, icon("clock"), "دوام التحضير"), el("p", { class: "tiny muted", text: "تُستخدم لحساب التأخير وأيام العمل المتوقعة في التحضير الشهري والتقارير." }))),
      el(
        "div",
        { class: "form-grid" },
        el("div", { class: "form-field" }, el("label", { class: "form-label", text: "بداية الدوام" }), workStart),
        el("div", { class: "form-field" }, el("label", { class: "form-label", text: "نهاية الدوام" }), workEnd),
        el("div", { class: "form-field" }, el("label", { class: "form-label", text: "دقائق السماح قبل احتساب التأخير" }), grace),
        el(
          "div",
          { class: "form-field span-2" },
          el("label", { class: "form-label", text: "أيام الراحة الأسبوعية" }),
          el("div", { class: "checkbox-group" }, ...weekendInputs.map((day) => el("label", { class: "checkbox-row" }, day.input, el("span", { text: day.label })))),
          el("span", { class: "form-hint", text: "تُستثنى أيام الراحة من الأيام المتوقعة وتظهر بالرمز ر في الكشف الشهري." }),
        ),
      ),
    ),
    canManage
      ? el("div", { class: "form-actions" }, saveButton)
      : el("p", { class: "tiny muted" }, "لا تملك صلاحية تعديل إعدادات النظام؛ العرض للقراءة فقط."),
  );

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    errorHost.replaceChildren();
    if (!companyName.value.trim() || !currency.value.trim()) {
      errorHost.append(alertBox("اسم الشركة ورمز العملة مطلوبان.", "error"));
      return;
    }
    setButtonLoading(saveButton, true, "جارٍ الحفظ…");
    try {
      const result = await api("/api/settings", {
        method: "PATCH",
        body: {
          company: { name: companyName.value.trim(), currency: currency.value.trim(), printFooter: printFooter.value.trim() },
          attendance: {
            workStart: workStart.value,
            workEnd: workEnd.value,
            lateGraceMinutes: Number(grace.value || 0),
            weekendDays: weekendInputs.filter((day) => day.input.checked).map((day) => day.value),
          },
        },
      });
      toast(`تم حفظ الإعدادات${result.changed ? ` (${formatNumber(result.changed)} تغيير)` : ""}.`, "success");
      await refreshMeta();
      renderSettings(host, token);
    } catch (error) {
      errorHost.append(alertBox(friendlyError(error), "error"));
      setButtonLoading(saveButton, false);
    }
  });

  const departmentRows = departments.items.length
    ? departments.items.map((department) =>
        el(
          "tr",
          { class: department.active ? "" : "row-muted" },
          el("td", { text: department.name }),
          el("td", { class: "num", text: formatNumber(department.employeesCount) }),
          el("td", {}, el("span", { class: `tag ${department.active ? "success" : "neutral"}`.trim(), text: department.active ? "مفعّل" : "معطل" })),
          el("td", { class: "tiny", text: formatDateTime(department.createdAt) }),
          el(
            "td",
            { class: "no-print" },
            canManage
              ? el(
                  "div",
                  { class: "inline-actions" },
                  el("button", { class: "icon-btn", type: "button", title: "إعادة تسمية", onclick: () => renameDepartment(department) }, icon("pencil")),
                  el("button", { class: "icon-btn", type: "button", title: department.active ? "تعطيل" : "تفعيل", onclick: () => toggleDepartment(department) }, icon(department.active ? "lock" : "circle-check")),
                )
              : el("span", { class: "tiny muted", text: "—" }),
          ),
        ),
      )
    : [el("tr", {}, el("td", { colspan: "5", class: "empty-inline", text: "لا توجد أقسام بعد." }))];

  const addDepartment = el("button", { class: "btn btn-secondary", type: "button", onclick: () => createDepartment() }, icon("plus"), "إضافة قسم");

  host.replaceChildren(
    pageEnter(
      pageHeader({
        title: "إعدادات النظام",
        subtitle: "بيانات الشركة، أوقات الدوام، أيام الراحة، والأقسام — تنعكس فوراً على التحضير والتقارير.",
        actions: data.updatedAt ? [el("span", { class: "tag", text: `آخر تحديث: ${formatDateTime(Object.values(data.updatedAt)[0])}` })] : [],
      }),
      form,
      el(
        "div",
        { class: "card table-card" },
        el(
          "div",
          { class: "section-head" },
          el("div", {}, el("h3", { class: "section-title" }, icon("building"), "الأقسام"), el("p", { class: "tiny muted", text: "تُستخدم في تصنيف الموظفين وتصفية التحضير والتقارير." })),
          canManage ? addDepartment : null,
        ),
        el(
          "div",
          { class: "table-wrap" },
          el(
            "table",
            { class: "att-table" },
            el("thead", {}, el("tr", {}, ...["القسم", "عدد الموظفين", "الحالة", "أُنشئ في", "إجراءات"].map((label, index) => el("th", { class: index === 4 ? "no-print" : "", text: label })))),
            el("tbody", {}, ...departmentRows),
          ),
        ),
      ),
      el("div", { class: "card section-card" }, el("div", { class: "section-head" }, el("div", {}, el("h3", { class: "section-title" }, icon("shield-check"), "ملاحظات تشغيلية"))), detailRows([
        ["نطاق الفروع", state.user?.allBranches ? "جميع الفروع" : (state.user?.branches ?? []).map((branch) => branch.name).join("، ") || "—"],
        ["آخر تحديث لإعدادات الشركة", data.updatedAt?.company ? formatDateTime(data.updatedAt.company) : "—"],
        ["آخر تحديث لإعدادات الدوام", data.updatedAt?.attendance ? formatDateTime(data.updatedAt.attendance) : "—"],
        ["سياسة كلمات المرور", `${formatNumber(state.meta?.passwordMinLength ?? 10)} أحرف على الأقل مع حرف ورقم`],
      ])),
    ),
  );

  function createDepartment() {
    openFormDialog({
      title: "إضافة قسم",
      fields: [{ name: "name", label: "اسم القسم", required: true, minlength: 2, maxlength: 120 }],
      submitLabel: "إضافة",
      size: "sm",
      onSubmit: async (values) => {
        await api("/api/departments", { method: "POST", body: { name: values.name, active: true } });
        await refreshMeta();
        toast("تمت إضافة القسم.", "success");
        renderSettings(host, token);
      },
    });
  }

  function renameDepartment(department) {
    openFormDialog({
      title: "إعادة تسمية القسم",
      fields: [{ name: "name", label: "الاسم الجديد", required: true, minlength: 2, maxlength: 120, value: department.name }],
      submitLabel: "حفظ",
      size: "sm",
      onSubmit: async (values) => {
        await api(`/api/departments/${department.id}`, { method: "PATCH", body: { name: values.name } });
        await refreshMeta();
        toast("تم تحديث اسم القسم.", "success");
        renderSettings(host, token);
      },
    });
  }

  async function toggleDepartment(department) {
    const ok = await confirmDialog({
      title: department.active ? "تعطيل القسم" : "تفعيل القسم",
      message: department.active ? "لن يظهر القسم في نماذج الموظفين الجدد، ويبقى مرتبطاً بالموظفين الحاليين." : "سيظهر القسم مجدداً في النماذج والتصفية.",
      confirmLabel: department.active ? "تعطيل" : "تفعيل",
      danger: department.active,
    });
    if (!ok) return;
    try {
      await api(`/api/departments/${department.id}`, { method: "PATCH", body: { active: !department.active } });
      await refreshMeta();
      toast(department.active ? "تم تعطيل القسم." : "تم تفعيل القسم.", "success");
      renderSettings(host, token);
    } catch (error) {
      toast(friendlyError(error), "error");
    }
  }
}
