import {
  alertBox,
  api,
  avatar,
  confirmDialog,
  el,
  emptyState,
  errorBlock,
  formatDate,
  formatDateTime,
  formatNumber,
  icon,
  loadingBlock,
  openModal,
  pageHeader,
  toast,
  todayISO,
} from "../core.js";
import { state } from "../state.js";
import { friendlyError, pageEnter } from "../ui.js";
import {
  ADVANCE_STATUS,
  EMP_STATUS,
  LEAVE_STATUS,
  PAYROLL_STATUS,
  attachmentsPanel,
  attTag,
  downloadFile,
  money,
  monthLabel,
  openFormDialog,
  statusTag,
} from "../hr-common.js";

const DOCUMENT_ACCEPT = ".pdf,.png,.jpg,.jpeg,.webp,.docx,.xlsx";
const MAX_FILE_BYTES = 2 * 1024 * 1024;

function card(title, subtitle, ...content) {
  return el(
    "section",
    { class: "card" },
    el(
      "div",
      { class: "card-head" },
      el(
        "div",
        {},
        el("h3", { class: "card-title", text: title }),
        subtitle ? el("p", { class: "card-subtitle", text: subtitle }) : null,
      ),
    ),
    ...content,
  );
}

function profileRows(employee, contract) {
  const rows = [
    ["الرقم الوظيفي", employee.employeeNo],
    ["الفرع", employee.branchName],
    ["القسم", employee.departmentName || "—"],
    ["المسمى الوظيفي", employee.jobTitle || "—"],
    ["المدير المباشر", employee.managerName || "—"],
    ["تاريخ التعيين", formatDate(employee.hireDate)],
    ["الجوال", employee.phone || "—"],
    ["الرقم الوطني", employee.nationalId || "—"],
    ["الراتب الأساسي", money(employee.baseSalary)],
    [
      "العقد النشط",
      contract ? `${contract.contractNo} · ${formatDate(contract.startDate)} — ${contract.endDate ? formatDate(contract.endDate) : "مفتوح"}` : "لا يوجد عقد نشط",
    ],
  ];
  return el(
    "div",
    { class: "profile-rows" },
    rows.map(([label, value]) =>
      el("div", { class: "profile-row" }, el("span", { text: label }), el("span", { text: value })),
    ),
  );
}

function balancesTable(balances) {
  if (!balances.length) return el("p", { class: "tiny muted", text: "لا توجد أرصدة إجازات متتبعة لهذا العام." });
  return el(
    "div",
    { class: "table-wrap" },
    el(
      "table",
      {},
      el(
        "thead",
        {},
        el(
          "tr",
          {},
          ["نوع الإجازة", "الاستحقاق", "المستخدم", "التعديلات", "المتبقي"].map((label) => el("th", { text: label })),
        ),
      ),
      el(
        "tbody",
        {},
        balances.map((item) =>
          el(
            "tr",
            {},
            el("td", {}, el("strong", { text: item.name }), item.paid ? null : el("span", { class: "tag", style: "margin-inline-start:8px", text: "بدون راتب" })),
            el("td", { class: "num", text: formatNumber(item.entitlement) }),
            el("td", { class: "num", text: formatNumber(item.used) }),
            el("td", { class: "num", text: formatNumber(item.adjusted) }),
            el("td", {}, el("strong", { class: "num", text: formatNumber(item.remaining) })),
          ),
        ),
      ),
    ),
  );
}

function movementsList(movements) {
  if (!movements.length) return el("p", { class: "tiny muted", text: "لا توجد حركات على الأرصدة." });
  return el(
    "div",
    { class: "activity-list" },
    movements.slice(0, 10).map((movement) =>
      el(
        "div",
        { class: "activity-item" },
        el("span", { class: `activity-dot ${movement.days < 0 ? "warning" : "info"}` }),
        el(
          "div",
          { class: "activity-copy" },
          el("strong", { text: `${movement.kind === "usage" ? "خصم إجازة" : "تعديل رصيد"} · ${formatNumber(movement.days)} يوم` }),
          el("span", { text: [movement.note, movement.actor].filter(Boolean).join(" · ") || "—" }),
        ),
        el("span", { class: "activity-time", text: formatDate(movement.createdAt) }),
      ),
    ),
  );
}

async function uploadLeaveFile(leaveId, file) {
  const params = new URLSearchParams({ ownerType: "leave", ownerId: leaveId, fileName: file.name, documentType: "other" });
  const response = await fetch(`/api/attachments?${params.toString()}`, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": file.type || "application/octet-stream",
      "X-Requested-With": "XMLHttpRequest",
    },
    body: file,
  });
  if (!response.ok) {
    let message = "تعذر رفع المستند.";
    try {
      const payload = await response.json();
      message = payload?.error?.message ?? message;
    } catch {
      /* ignore malformed error body */
    }
    throw new Error(message);
  }
}

function openNewLeave(overview, reload) {
  const types = overview.leaveTypes ?? [];
  if (!types.length) {
    toast("لا توجد أنواع إجازات معتمدة. تواصل مع الموارد البشرية.", "warning");
    return;
  }
  let createdId = null;
  openFormDialog({
    title: "طلب إجازة أو إذن",
    description: "يُحفظ الطلب كمسودة ثم يُرسل للاعتماد فوراً.",
    submitLabel: "إنشاء وإرسال",
    size: "lg",
    fields: [
      {
        name: "leaveTypeId",
        label: "نوع الطلب",
        type: "select",
        required: true,
        span: 2,
        options: types.map((type) => ({
          value: type.id,
          label: `${type.name}${type.trackBalance ? ` · استحقاق ${formatNumber(type.annualEntitlement)} يوم` : ""}${type.requiresDocument ? " · يتطلب مستنداً" : ""}`,
        })),
      },
      { name: "startDate", label: "من تاريخ", type: "date", required: true, value: todayISO() },
      { name: "endDate", label: "إلى تاريخ", type: "date", required: true, value: todayISO() },
      { name: "reason", label: "السبب", type: "textarea", required: true, span: 2, maxlength: 1000, minlength: 3 },
      { name: "notes", label: "ملاحظات إضافية", type: "textarea", span: 2, maxlength: 1000 },
      {
        name: "document",
        label: "مستند مساند (اختياري)",
        type: "file",
        span: 2,
        accept: DOCUMENT_ACCEPT,
        hint: "PDF أو صورة أو Word أو Excel، بحد أقصى 2 ميجابايت. مطلوب لبعض الأنواع.",
      },
    ],
    onSubmit: async (values, { errorHost }) => {
      const type = types.find((item) => item.id === values.leaveTypeId);
      const startDate = String(values.startDate ?? "");
      const endDate = String(values.endDate ?? "");
      const reason = String(values.reason ?? "").trim();
      const notes = String(values.notes ?? "").trim();
      const file = values.document;
      if (!startDate || !endDate) {
        errorHost.append(alertBox("حدد تاريخ البداية والنهاية.", "error"));
        return false;
      }
      if (endDate < startDate) {
        errorHost.append(alertBox("تاريخ النهاية يجب ألا يسبق تاريخ البداية.", "error"));
        return false;
      }
      if (reason.length < 3) {
        errorHost.append(alertBox("سبب الطلب مطلوب (3 أحرف على الأقل).", "error"));
        return false;
      }
      if (file && file.size > MAX_FILE_BYTES) {
        errorHost.append(alertBox("حجم المستند أكبر من 2 ميجابايت.", "error"));
        return false;
      }
      if (type?.requiresDocument && !file) {
        errorHost.append(alertBox("هذا النوع يتطلب إرفاق مستند قبل الإرسال.", "error"));
        return false;
      }
      if (!createdId) {
        const created = await api("/api/self-service/leaves", {
          method: "POST",
          body: { leaveTypeId: values.leaveTypeId, startDate, endDate, reason, notes },
        });
        createdId = created.id;
      }
      if (file) await uploadLeaveFile(createdId, file);
      await api(`/api/self-service/leaves/${createdId}/submit`, { method: "POST", body: {} });
      toast("تم إرسال الطلب للاعتماد.", "success");
      await reload();
      return true;
    },
  });
}

async function submitOwnLeave(leave, reload) {
  const confirmed = await confirmDialog({
    title: "إرسال الطلب للاعتماد",
    message: `سيُرسل طلب ${leave.leaveTypeName} (${formatDate(leave.startDate)} — ${formatDate(leave.endDate)}) للاعتماد.`,
    confirmLabel: "إرسال",
  });
  if (!confirmed) return;
  try {
    await api(`/api/self-service/leaves/${leave.id}/submit`, { method: "POST", body: {} });
    toast("تم إرسال الطلب للاعتماد.", "success");
    await reload();
  } catch (error) {
    toast(friendlyError(error), "error");
  }
}

async function cancelOwnLeave(leave, reload) {
  const confirmed = await confirmDialog({
    title: "إلغاء الطلب",
    message: `سيتم إلغاء طلب ${leave.leaveTypeName} من ${formatDate(leave.startDate)}. لا يمكن التراجع.`,
    confirmLabel: "إلغاء الطلب",
    danger: true,
  });
  if (!confirmed) return;
  try {
    await api(`/api/self-service/leaves/${leave.id}/cancel`, { method: "POST", body: {} });
    toast("تم إلغاء الطلب.", "success");
    await reload();
  } catch (error) {
    toast(friendlyError(error), "error");
  }
}

function openLeaveDetails(leave) {
  const editable = leave.status === "draft" || leave.status === "rejected";
  const attachments = attachmentsPanel({ ownerType: "leave", ownerId: leave.id, canEdit: editable });
  let controller;
  const body = el(
    "div",
    {},
    el(
      "div",
      { class: "profile-rows" },
      el("div", { class: "profile-row" }, el("span", { text: "النوع" }), el("span", { text: leave.leaveTypeName })),
      el("div", { class: "profile-row" }, el("span", { text: "المدة" }), el("span", { text: `${formatDate(leave.startDate)} — ${formatDate(leave.endDate)}` })),
      el("div", { class: "profile-row" }, el("span", { text: "الأيام" }), el("span", { text: formatNumber(leave.days) })),
      el("div", { class: "profile-row" }, el("span", { text: "السبب" }), el("span", { text: leave.reason || "—" })),
      leave.decidedBy
        ? el(
            "div",
            { class: "profile-row" },
            el("span", { text: "القرار" }),
            el("span", { text: `${leave.decidedBy}${leave.decidedAt ? ` · ${formatDateTime(leave.decidedAt)}` : ""}${leave.decisionNote ? ` · ${leave.decisionNote}` : ""}` }),
          )
        : null,
    ),
    el("div", { style: "margin-top:18px" }, attachments.node),
  );
  controller = openModal({
    title: `طلب ${leave.leaveTypeName}`,
    description: leave.status === "draft" ? "طلب مسودة — يمكنك إرفاق المستند ثم إرساله للاعتماد." : "",
    size: "md",
    body,
    footer: [el("button", { class: "btn btn-ghost", type: "button", onclick: () => controller.close() }, "إغلاق")],
  });
}

function leavesCard(overview, reload) {
  const leaves = overview.leaves ?? [];
  const canRequest = overview.capabilities?.canRequestLeave;
  const table = leaves.length
    ? el(
        "div",
        { class: "table-wrap" },
        el(
          "table",
          {},
          el(
            "thead",
            {},
            el("tr", {}, ["النوع", "الفترة", "الأيام", "الحالة", "القرار", "إجراءات"].map((label) => el("th", { text: label }))),
          ),
          el(
            "tbody",
            {},
            leaves.map((leave) =>
              el(
                "tr",
                {},
                el("td", {}, el("strong", { text: leave.leaveTypeName })),
                el("td", { class: "tiny nowrap", text: `${formatDate(leave.startDate)} — ${formatDate(leave.endDate)}` }),
                el("td", { class: "num", text: formatNumber(leave.days) }),
                el("td", {}, statusTag(LEAVE_STATUS, leave.status)),
                el(
                  "td",
                  { class: "tiny muted", text: leave.decidedBy ? `${leave.decidedBy} · ${formatDate(leave.decidedAt)}` : "—" },
                ),
                el(
                  "td",
                  {},
                  el(
                    "div",
                    { class: "cell-actions" },
                    el(
                      "button",
                      { class: "icon-btn", type: "button", title: "التفاصيل والمرفقات", onclick: () => openLeaveDetails(leave) },
                      icon("file-text"),
                    ),
                    leave.status === "draft" || leave.status === "rejected"
                      ? el(
                          "button",
                          { class: "icon-btn", type: "button", title: "إرسال للاعتماد", onclick: () => submitOwnLeave(leave, reload) },
                          icon("send"),
                        )
                      : null,
                    leave.status !== "approved" && leave.status !== "cancelled"
                      ? el(
                          "button",
                          { class: "icon-btn danger", type: "button", title: "إلغاء الطلب", onclick: () => cancelOwnLeave(leave, reload) },
                          icon("circle-x"),
                        )
                      : null,
                  ),
                ),
              ),
            ),
          ),
        ),
      )
    : emptyState({ title: "لا توجد طلبات", message: "لم تقدّم أي طلب إجازة أو إذن بعد.", iconName: "calendar" });

  return card(
    "إجازاتي وأذوناتي",
    "آخر 12 طلباً مع حالتها وقراراتها.",
    canRequest
      ? el(
          "div",
          { class: "card-head", style: "padding:0;border:0;margin-bottom:12px" },
          el("div"),
          el("button", { class: "btn btn-primary btn-sm", type: "button", onclick: () => openNewLeave(overview, reload) }, icon("plus"), "طلب جديد"),
        )
      : el("div", { class: "form-note" }, icon("info"), el("span", { text: "تقديم الطلبات غير متاح لملف موظف غير نشط." })),
    table,
  );
}

function attendanceCard(rows) {
  const table = rows.length
    ? el(
        "div",
        { class: "table-wrap" },
        el(
          "table",
          {},
          el("thead", {}, el("tr", {}, ["التاريخ", "الحالة", "الدخول", "الخروج", "التأخير", "ساعات العمل"].map((label) => el("th", { text: label })))),
          el(
            "tbody",
            {},
            rows.map((row) =>
              el(
                "tr",
                {},
                el("td", { class: "nowrap", text: formatDate(row.workDate) }),
                el("td", {}, attTag(row.status)),
                el("td", { dir: "ltr", text: row.checkIn || "—" }),
                el("td", { dir: "ltr", text: row.checkOut || "—" }),
                el("td", { class: "num", text: row.lateMinutes ? `${formatNumber(row.lateMinutes)} د` : "—" }),
                el("td", { class: "num", text: row.workHours ? formatNumber(row.workHours) : "—" }),
              ),
            ),
          ),
        ),
      )
    : emptyState({ title: "لا توجد سجلات حضور", message: "لم يُسجَّل حضور لك في الفترة الأخيرة.", iconName: "calendar-check" });
  return card("حضوري", "آخر 31 يوماً مسجلة في التحضير اليومي.", table);
}

function advancesCard(rows) {
  const table = rows.length
    ? el(
        "div",
        { class: "table-wrap" },
        el(
          "table",
          {},
          el("thead", {}, el("tr", {}, ["التاريخ", "المبلغ", "المتبقي", "الأقساط", "الحالة"].map((label) => el("th", { text: label })))),
          el(
            "tbody",
            {},
            rows.map((row) =>
              el(
                "tr",
                {},
                el("td", { class: "nowrap", text: formatDate(row.requestDate) }),
                el("td", { class: "num", text: money(row.amount) }),
                el("td", { class: "num", text: money(row.outstanding) }),
                el("td", { class: "num", text: formatNumber(row.installments) }),
                el("td", {}, statusTag(ADVANCE_STATUS, row.status)),
              ),
            ),
          ),
        ),
      )
    : el("p", { class: "tiny muted", text: "لا توجد سلف مسجلة." });
  return card("سلفي", "السلف المالية وحالة سدادها.", table);
}

function payrollCard(rows) {
  const table = rows.length
    ? el(
        "div",
        { class: "table-wrap" },
        el(
          "table",
          {},
          el("thead", {}, el("tr", {}, ["الشهر", "الأساسي", "البدلات", "الخصومات", "خصم السلف", "الصافي", "الحالة"].map((label) => el("th", { text: label })))),
          el(
            "tbody",
            {},
            rows.map((row) =>
              el(
                "tr",
                {},
                el("td", { class: "nowrap", text: monthLabel(row.year, row.month) }),
                el("td", { class: "num", text: money(row.baseSalary) }),
                el("td", { class: "num", text: money(row.allowances) }),
                el("td", { class: "num", text: money(row.deductions) }),
                el("td", { class: "num", text: money(row.advanceDeduction) }),
                el("td", {}, el("strong", { class: "num", text: money(row.net) })),
                el("td", {}, statusTag(PAYROLL_STATUS, row.reviewStatus)),
              ),
            ),
          ),
        ),
      )
    : el("p", { class: "tiny muted", text: "لا توجد قسائم رواتب." });
  return card("قسائم الرواتب", "آخر 12 شهراً. الأرقام المعتمدة تصدر من الموارد البشرية.", table);
}

function documentsCard(rows) {
  const list = rows.length
    ? el(
        "div",
        { class: "attachment-list" },
        rows.map((document) =>
          el(
            "div",
            { class: "attachment-item" },
            icon("file-text"),
            el(
              "div",
              { class: "attachment-copy" },
              el("strong", { text: document.title || document.fileName }),
              el("span", {
                text: `${document.fileName}${document.expiresAt ? ` · ينتهي ${formatDate(document.expiresAt)}` : ""} · ${formatDate(document.createdAt)}`,
              }),
            ),
            el(
              "div",
              { class: "attachment-actions" },
              el(
                "button",
                {
                  class: "icon-btn",
                  type: "button",
                  title: "تنزيل المستند",
                  onclick: async () => {
                    try {
                      await downloadFile(`/api/attachments/${document.id}/download`, document.fileName);
                    } catch (error) {
                      toast(friendlyError(error), "error");
                    }
                  },
                },
                icon("download"),
              ),
            ),
          ),
        ),
      )
    : el("p", { class: "tiny muted", text: "لا توجد مستندات مرفقة بملفك." });
  return card("مستنداتي", "المستندات الرسمية المرفقة بملف الموظف.", list);
}

function summary(overview) {
  const annual = (overview.balances ?? []).find((balance) => balance.code === "annual");
  const outstanding = (overview.advances ?? []).reduce((total, advance) => total + Number(advance.outstanding ?? 0), 0);
  const pendingLeaves = (overview.leaves ?? []).filter((leave) => leave.status === "pending").length;
  const lastPayroll = overview.payroll?.[0];
  return el(
    "div",
    { class: "summary-strip summary-grid" },
    [
      { iconName: "calendar", tone: "blue", value: annual ? annual.remaining : 0, label: "رصيد الإجازة السنوية (يوم)" },
      { iconName: "wallet", tone: "amber", value: money(outstanding), label: "رصيد السلف القائم" },
      { iconName: "banknote", tone: "green", value: lastPayroll ? money(lastPayroll.net) : "—", label: "صافي آخر راتب" },
      { iconName: "inbox", tone: "purple", value: pendingLeaves, label: "طلبات بانتظار الاعتماد" },
    ].map((item) =>
      el(
        "div",
        { class: "summary-item" },
        el("span", { class: `metric-icon ${item.tone}` }, icon(item.iconName)),
        el("div", {}, el("strong", { class: "num", text: typeof item.value === "number" ? formatNumber(item.value) : item.value }), el("span", { text: item.label })),
      ),
    ),
  );
}

function profileCard(overview) {
  const employee = overview.employee;
  const status = EMP_STATUS[employee.status] ?? { label: employee.status, tone: "neutral" };
  return card(
    "ملفي الوظيفي",
    "البيانات المسجلة في الموارد البشرية. للتعديل تواصل مع إدارة الموارد البشرية.",
    el(
      "div",
      { class: "profile-head" },
      avatar(employee.fullName, "lg"),
      el(
        "div",
        {},
        el("h2", { text: employee.fullName }),
        el("p", { dir: "ltr", text: employee.employeeNo }),
        el("p", { text: [employee.jobTitle, employee.branchName].filter(Boolean).join(" · ") }),
      ),
      el("span", { class: "status-badge status-neutral" }, el("span", { text: status.label })),
    ),
    profileRows(employee, overview.contract),
  );
}

export async function renderSelfService(host, token) {
  const header = pageHeader({
    title: "خدماتي",
    subtitle: "ملفك الوظيفي ورصيد إجازاتك وطلباتك وحضورك وسلفك ورواتبك في مكان واحد.",
    actions: [
      el("button", { class: "btn btn-secondary", type: "button", onclick: () => load() }, icon("refresh"), "تحديث"),
    ],
  });
  const body = el("div");
  const node = pageEnter(header);
  node.append(body);
  host.replaceChildren(node);

  async function load() {
    body.replaceChildren(loadingBlock("جارٍ تحميل بياناتك…"));
    let overview;
    try {
      overview = await api("/api/self-service/overview");
    } catch (error) {
      if (token !== state.renderToken) return;
      const message = friendlyError(error);
      body.replaceChildren(
        error.status === 403
          ? el(
              "div",
              { class: "card" },
              emptyState({
                title: "الحساب غير مرتبط بملف موظف",
                message: "اطلب من إدارة الموارد البشرية ربط حسابك بملفك الوظيفي من شاشة المستخدمين.",
                iconName: "account",
              }),
            )
          : errorBlock(message, () => load()),
      );
      return;
    }
    if (token !== state.renderToken) return;
    const reload = () => load();
    const overviewGrid = el("div", { class: "account-grid" }, profileCard(overview), card("أرصدة الإجازات", "أرصدة العام الحالي حسب النوع، بعد الخصومات والتعديلات.", balancesTable(overview.balances ?? []), el("div", { class: "section-label", style: "margin-top:18px" }, "آخر الحركات"), movementsList(overview.balanceMovements ?? [])));
    body.replaceChildren(
      summary(overview),
      overviewGrid,
      leavesCard(overview, reload),
      attendanceCard(overview.attendance ?? []),
      el("div", { class: "account-grid" }, advancesCard(overview.advances ?? []), payrollCard(overview.payroll ?? [])),
      documentsCard(overview.documents ?? []),
    );
  }

  await load();
}
