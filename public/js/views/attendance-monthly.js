import {
  api,
  confirmDialog,
  el,
  errorBlock,
  formatDateTime,
  formatNumber,
  icon,
  loadingBlock,
  openModal,
  pageHeader,
  setButtonLoading,
  statusBadge,
  toast,
  todayISO,
} from "../core.js";
import { state } from "../state.js";
import { friendlyError, pageEnter } from "../ui.js";
import {
  ATT_ORDER,
  ATT_STATUS,
  FOLLOW_STATUS,
  MONTH_NAMES,
  SUBMISSION_STATUS,
  branchList,
  branchSelectOptions,
  downloadFile,
  filterBar,
  hashParams,
  monthLabel,
  monthValue,
  navigateHash,
  openReasonDialog,
  printHeader,
  printPage,
  statusTag,
  summaryStrip,
} from "../hr-common.js";

const WEEKDAY_SHORT = ["أحد", "اثن", "ثلا", "أرب", "خمي", "جمع", "سبت"];

function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

function defaultMonth() {
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() + 1 };
}

export async function renderAttendanceMonthly(host, token) {
  const params = hashParams();
  const tab = params.get("tab") === "followup" || window.location.hash.includes("follow-up") ? "followup" : "sheet";
  host.replaceChildren(loadingBlock(tab === "followup" ? "جارٍ تحميل متابعة الفروع…" : "جارٍ تحميل التحضير الشهري…"));
  try {
    if (tab === "followup") {
      await renderFollowUp(host, token, params);
    } else {
      await renderSheet(host, token, params);
    }
  } catch (error) {
    if (token !== state.renderToken) return;
    host.replaceChildren(errorBlock(friendlyError(error), () => renderAttendanceMonthly(host, token)));
  }
}

function tabBar(active) {
  const button = (id, label, iconName) =>
    el(
      "button",
      {
        class: `tab ${active === id ? "active" : ""}`.trim(),
        type: "button",
        onclick: () => navigateHash("attendance-monthly", id === "followup" ? { tab: "followup" } : {}),
      },
      icon(iconName),
      label,
    );
  return el("div", { class: "tabs no-print" }, button("sheet", "التحضير الشهري", "calendar-range"), button("followup", "متابعة الفروع", "trending-up"));
}

function monthFilter(selected, onApply, extraFields = []) {
  const branches = branchList();
  const branchId = selected.branchId || branchList().find((b) => b.active)?.id || branches[0]?.id || "";
  const branchSelect = el("select", { class: "select", "aria-label": "الفرع" }, ...branchSelectOptions(branchId, { allLabel: selected.allBranches ? "كل الفروع" : "" }));
  const monthInput = el("input", { class: "input", type: "month", value: monthValue(new Date(selected.year, selected.month - 1, 1)), "aria-label": "الشهر" });
  return filterBar(
    [{ label: "الفرع", control: branchSelect }, { label: "الشهر", control: monthInput }, ...extraFields.map((field) => ({ label: field.label, control: field.control }))],
    {
      onApply: () => {
        const [year, month] = parseMonth(monthInput.value);
        onApply({ branchId: branchSelect.value, year, month });
      },
      onReset: () => {
        const now = defaultMonth();
        navigateHash("attendance-monthly", selected.followup ? { tab: "followup" } : {});
      },
    },
  );
}

function parseMonth(value) {
  const [year, month] = String(value || "").split("-").map(Number);
  if (!year || !month) return defaultMonth();
  return { year, month };
}

async function renderSheet(host, token, params) {
  const branches = branchList();
  if (branches.length === 0) {
    host.replaceChildren(pageEnter(pageHeader({ title: "التحضير الشهري" }), el("div", { class: "card" }, el("div", { class: "empty-inline", text: "لا توجد فروع متاحة." }))));
    return;
  }
  const now = defaultMonth();
  const year = Number(params.get("year")) || now.year;
  const month = Number(params.get("month")) || now.month;
  const branchId = branches.some((b) => b.id === params.get("branch")) ? params.get("branch") : (branches.find((b) => b.active)?.id ?? branches[0].id);
  const departmentId = params.get("department") || "";

  let data;
  const load = async () => {
    data = await api(
      `/api/attendance/monthly?branchId=${encodeURIComponent(branchId)}&year=${year}&month=${month}${departmentId ? `&departmentId=${encodeURIComponent(departmentId)}` : ""}`,
    );
  };
  await load();
  if (token !== state.renderToken) return;

  const perms = data.capabilities;
  const canEdit = Boolean(perms.canManage);
  const canSubmit = Boolean(perms.canSubmit);
  const canApprove = Boolean(perms.canApprove);
  const canCorrect = Boolean(perms.canCorrect);
  let overrides = new Map((data.overrides || []).map((item) => [`${item.employeeId}:${item.day}`, { ...item }]));
  let notes = data.monthly?.notes ?? "";
  let saveTimer = null;
  let savePromise = null;

  const summaryHost = el("div");
  const stateHost = el("div");
  const matrixHost = el("div");
  const autoSaveNode = el("span", { class: "auto-save" });

  const pageTitle = pageHeader({
    title: `التحضير الشهري — ${data.branch.name}`,
    subtitle: `${monthLabel(data.year, data.month)} · ${formatNumber(data.days)} يوماً · يُشتق تلقائياً من التحضير اليومي مع إمكانية تجاوز أي يوم.`,
    actions: [],
  });
  const actions = pageTitle.querySelector(".page-actions") ?? el("div");
  if (!actions.parentNode) pageTitle.append(actions);

  const action = (iconName, label, handler, kind = "btn-secondary") =>
    el("button", { class: `btn ${kind}`, type: "button", onclick: handler }, icon(iconName), label);

  actions.append(
    action("printer", "طباعة A4", () => printPage({ landscape: true })),
    action("download", "تصدير Excel", async (event) => {
      const button = event.currentTarget;
      setButtonLoading(button, true, "جارٍ التصدير…");
      try {
        await downloadFile(`/api/attendance/monthly/export.xlsx?branchId=${encodeURIComponent(branchId)}&year=${year}&month=${month}`, `attendance-monthly-${year}-${month}.xlsx`);
      } catch (error) {
        toast(error.message, "error");
      } finally {
        setButtonLoading(button, false);
      }
    }),
  );
  if (canEdit) actions.append(action("check", "حفظ التجاوزات", async (event) => {
    const button = event.currentTarget;
    setButtonLoading(button, true, "جارٍ الحفظ…");
    try {
      const ok = await saveMonthly();
      if (ok) toast("تم حفظ تجاوزات الشهر.", "success");
    } finally {
      setButtonLoading(button, false);
    }
  }));
  if (canSubmit) actions.append(action("send", "إرسال للاعتماد", (event) => submitMonthly(event.currentTarget), "btn-primary"));
  if (canApprove) {
    actions.append(
      action("circle-check", "اعتماد الشهر", (event) => decideMonthly("approve", event.currentTarget), "btn-primary"),
      action("corner-up-left", "إعادة الشهر", (event) => decideMonthly("reject", event.currentTarget), "btn-ghost"),
    );
  }
  if (canCorrect && data.monthly?.status === "approved") {
    autoSaveNode.append(el("span", { class: "tag", text: "تصحيح الصفوف يتم من كشف التحضير اليومي" }));
  }

  const printHead = printHeader({
    title: `كشف التحضير الشهري — ${data.branch.name}`,
    subtitle: monthLabel(year, month),
    meta: [`الفرع: ${data.branch.name} (${data.branch.code})`, `الأيام: ${data.days}`, `أيام العمل المتوقعة: ${data.rows[0]?.totals.workdays ?? "—"}`],
  });

  const branchSelect = el("select", { class: "select", "aria-label": "الفرع" }, ...branchSelectOptions(branchId));
  const monthInput = el("input", { class: "input", type: "month", value: `${year}-${String(month).padStart(2, "0")}`, "aria-label": "الشهر" });
  const departmentSelect = el(
    "select",
    { class: "select", "aria-label": "القسم" },
    el("option", { value: "" }, "كل الأقسام"),
    ...(state.meta?.departments ?? []).map((dept) => el("option", { value: dept.id, selected: dept.id === departmentId }, dept.name)),
  );
  const filters = filterBar(
    [
      { label: "الفرع", control: branchSelect },
      { label: "الشهر", control: monthInput },
      { label: "القسم", control: departmentSelect },
    ],
    {
      onApply: () => {
        const parsed = parseMonth(monthInput.value);
        navigateHash("attendance-monthly", { branch: branchSelect.value, year: parsed.year, month: parsed.month, department: departmentSelect.value });
      },
      onReset: () => navigateHash("attendance-monthly", {}),
    },
  );

  const missing = data.missingDays || 0;

  renderSummary();
  renderState();
  renderMatrix();

  const notesInput = el("input", {
    class: "input",
    value: notes,
    maxlength: 1000,
    placeholder: "ملاحظات الشهر (اختياري)",
    disabled: !canEdit,
    "aria-label": "ملاحظات الشهر",
  });
  notesInput.addEventListener("input", () => {
    notes = notesInput.value;
    markDirty();
  });

  const footer = el(
    "div",
    { class: "card-footer no-print" },
    el(
      "span",
      {},
      missing > 0
        ? el("span", { class: "inline-actions" }, statusBadge(`${formatNumber(missing)} يوم/خلية غير مسجلة`, "warning"), " يعتمد الإرسال على تأكيد الأيام الناقصة.")
        : el("span", { class: "inline-actions" }, statusBadge("لا توجد أيام ناقصة", "success"), " جميع أيام العمل مسجلة."),
    ),
    canEdit ? notesInput : null,
  );

  const legend = el(
    "div",
    { class: "legend" },
    ...ATT_ORDER.map((status) => el("span", {}, el("b", { text: ATT_STATUS[status].symbol }), ATT_STATUS[status].label)),
    el("span", { class: "tiny muted", text: "انقر أي خلية لتجاوزها يدوياً — التجاوزات تُحفظ على الخادم" }),
  );

  host.replaceChildren(
    pageEnter(
      pageTitle,
      tabBar("sheet"),
      filters,
      printHead,
      summaryHost,
      stateHost,
      el("div", { class: "card table-card" }, matrixHost, legend, footer),
      autoSaveNode,
    ),
  );

  function setSaveState(mode, text = "") {
    autoSaveNode.className = `auto-save ${mode}`.trim();
    const labels = { saving: "جارٍ حفظ التجاوزات…", saved: "جميع التجاوزات محفوظة", error: "تعذر حفظ التجاوزات", dirty: "تغييرات غير محفوظة…" };
    autoSaveNode.replaceChildren(icon(mode === "error" ? "alert-circle" : mode === "saving" ? "refresh" : mode === "dirty" ? "clock" : "circle-check"), el("span", { text: text || labels[mode] || "" }));
  }

  function markDirty() {
    if (!canEdit) return;
    setSaveState("dirty");
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveMonthly(true), 1600);
  }

  function renderSummary() {
    const totals = { present: 0, absent: 0, leave: 0, permission: 0, mission: 0, weeklyRest: 0, late: 0, excused: 0, unrecorded: 0, workdays: 0 };
    for (const row of data.rows) {
      totals.present += row.totals.present;
      totals.absent += row.totals.absent;
      totals.leave += row.totals.leave;
      totals.permission += row.totals.permission;
      totals.mission += row.totals.mission;
      totals.weeklyRest += row.totals.weeklyRest;
      totals.late += row.totals.late;
      totals.excused += row.totals.excusedAbsence;
      totals.unrecorded += row.totals.unrecorded;
      totals.workdays += row.totals.workdays;
    }
    summaryHost.replaceChildren(
      summaryStrip([
        { label: "الموظفون", value: data.rows.filter((r) => r.employeeId).length, tone: "blue", iconName: "users" },
        { label: "أيام مسجلة", value: totals.workdays, tone: "green", iconName: "calendar-check" },
        { label: "حاضر", value: totals.present, tone: "green", iconName: "user-check" },
        { label: "غائب", value: totals.absent, tone: "red", iconName: "circle-x" },
        { label: "إجازات وأذونات", value: totals.leave + totals.permission, tone: "purple", iconName: "calendar" },
        { label: "تأخير", value: totals.late, tone: "orange", iconName: "clock" },
        { label: "غير مسجل", value: totals.unrecorded, tone: "orange", iconName: "alert-triangle" },
        { label: "الأيام الناقصة", value: missing, tone: "red", iconName: "alert-circle" },
      ]),
    );
  }

  function renderState() {
    const monthly = data.monthly ?? { status: "draft" };
    const meta = SUBMISSION_STATUS[monthly.status] ?? SUBMISSION_STATUS.draft;
    const steps = [
      { label: "مسودة", done: true },
      { label: "مرسل", done: ["submitted", "approved"].includes(monthly.status), current: monthly.status === "submitted" },
      { label: "معتمد", done: monthly.status === "approved", current: monthly.status === "approved" },
    ];
    stateHost.replaceChildren(
      el(
        "div",
        { class: "sheet-state" },
        el(
          "div",
          { class: "state-copy" },
          el("strong", {}, "حالة كشف الشهر: ", statusBadge(meta.label, meta.tone), monthly.missingDaysConfirmed ? el("span", { class: "tag warning", style: "margin-right:8px", text: "تم تأكيد الأيام الناقصة" }) : null),
          monthly.rejectionReason ? el("p", { text: `سبب الإعادة: ${monthly.rejectionReason}` }) : el("p", { text: "التجاوزات تُطبَّق فوق البيانات اليومية المعتمدة. الرموز: ح غ إ ذ م ر ت ع." }),
          el(
            "div",
            { class: "sheet-meta" },
            el("span", {}, "أعدّه: ", el("b", { text: monthly.preparedBy || "—" })),
            monthly.submittedAt ? el("span", {}, "أرسله: ", el("b", { text: monthly.submittedBy || "—" }), " · ", formatDateTime(monthly.submittedAt)) : null,
            monthly.approvedBy ? el("span", {}, "اعتمده: ", el("b", { text: monthly.approvedBy }), monthly.approvedAt ? ` · ${formatDateTime(monthly.approvedAt)}` : "") : null,
          ),
        ),
        el("div", { class: "status-flow" }, ...steps.map((step) => el("span", { class: `flow-step ${step.current ? "current" : step.done ? "done" : ""}`.trim() }, icon(step.done ? "check" : "clock"), step.label))),
      ),
    );
  }

  function cellFor(row, cell) {
    const key = row.employeeId ? `${row.employeeId}:${cell.day}` : null;
    const override = key ? overrides.get(key) : null;
    const status = override?.status ?? cell.status;
    const weekend = cell.source === "weekend";
    if (!status) {
      const inactive = cell.source === "inactive";
      const content = el("span", { class: "mcell-inner", text: inactive ? "—" : "" });
      return el(
        "td",
        { class: `mcell empty ${inactive ? "inactive" : ""}`.trim(), title: inactive ? "خارج فترة العمل" : "غير مسجل" },
        canEdit && row.employeeId && !inactive && data.monthly?.status !== "approved"
          ? el("button", { class: "mcell-btn", type: "button", onclick: () => editCell(row, cell), "aria-label": "تجاوز اليوم" }, "+")
          : content,
      );
    }
    const meta = ATT_STATUS[status];
    const classes = ["mcell", status, override ? "override" : "", weekend ? "weekend" : ""].filter(Boolean).join(" ");
    const canClick = canEdit && row.employeeId && data.monthly?.status !== "approved";
    return el(
      "td",
      { class: classes, title: `${cell.day} — ${meta?.label ?? status}${override ? " (تجاوز)" : ""}${cell.note ? ` — ${cell.note}` : ""}` },
      canClick
        ? el("button", { class: "mcell-btn", type: "button", onclick: () => editCell(row, cell), "aria-label": `تعديل يوم ${cell.day}` }, meta?.symbol ?? "?")
        : el("span", { text: meta?.symbol ?? "?" }),
    );
  }

  function renderMatrix() {
    if (data.rows.length === 0) {
      matrixHost.replaceChildren(el("div", { class: "empty-inline", text: "لا توجد بيانات موظفين لهذا الشهر." }));
      return;
    }
    const date = new Date(year, month - 1, 1);
    const head = el(
      "thead",
      {},
      el(
        "tr",
        {},
        el("th", { class: "sticky-col", text: "الموظف" }),
        el("th", { text: "القسم" }),
        ...Array.from({ length: data.days }, (_, index) => {
          const dayDate = new Date(year, month - 1, index + 1);
          return el("th", { class: "mcell", title: WEEKDAY_SHORT[dayDate.getDay()] }, el("span", { text: formatNumber(index + 1) }), el("small", { text: WEEKDAY_SHORT[dayDate.getDay()] }));
        }),
        el("th", { text: "أيام العمل" }),
        el("th", { text: "غير مسجل" }),
      ),
    );
    const body = el("tbody");
    for (const row of data.rows) {
      body.append(
        el(
          "tr",
          {},
          el(
            "td",
            { class: "sticky-col" },
            el("div", { class: "cell-person" }, el("div", {}, el("strong", { text: row.fullName }), el("span", { text: `${row.employeeNo || "—"}${row.temporary ? " · اسم مؤقت" : ""}` }))),
          ),
          el("td", { class: "tiny muted", text: row.departmentName || "—" }),
          ...row.days.map((cell) => cellFor(row, cell)),
          el("td", { class: "num", text: formatNumber(row.totals.workdays) }),
          el("td", { class: `num ${row.totals.unrecorded > 0 ? "text-danger" : ""}`.trim(), text: formatNumber(row.totals.unrecorded) }),
        ),
      );
    }
    matrixHost.replaceChildren(el("div", { class: "table-wrap matrix-wrap" }, el("table", { class: "att-table matrix-table" }, head, body)));
  }

  function editCell(row, cell) {
    if (!row.employeeId || !canEdit) return;
    const key = `${row.employeeId}:${cell.day}`;
    const current = overrides.get(key);
    let chosen = current?.status ?? cell.status ?? "present";
    const statusSelect = el(
      "select",
      { class: "select" },
      ...ATT_ORDER.map((status) => el("option", { value: status, selected: status === chosen }, `${ATT_STATUS[status].label} (${ATT_STATUS[status].symbol})`)),
    );
    statusSelect.addEventListener("change", () => {
      chosen = statusSelect.value;
    });
    const note = el("input", { class: "input", value: current?.note ?? cell.note ?? "", maxlength: 300, placeholder: "ملاحظة التجاوز (اختياري)" });
    const errorHost = el("div");
    const dialogBody = el(
      "div",
      {},
      el("div", { class: "detail-grid" }, el("div", { class: "detail-row" }, el("span", { class: "detail-label", text: "الموظف" }), el("div", { class: "detail-value", text: row.fullName })), el("div", { class: "detail-row" }, el("span", { class: "detail-label", text: "اليوم" }), el("div", { class: "detail-value", text: `${formatNumber(cell.day)} ${monthLabel(year, month)}` }))),
      el("div", { class: "form-field" }, el("label", { class: "form-label", text: "الحالة" }), statusSelect),
      el("div", { class: "form-field" }, el("label", { class: "form-label", text: "ملاحظة" }), note),
      errorHost,
    );
    let controller;
    const apply = async () => {
      if (chosen === (cell.status ?? null) && !note.value.trim()) overrides.delete(key);
      else overrides.set(key, { employeeId: row.employeeId, day: cell.day, status: chosen, note: note.value.trim() });
      const saved = await saveMonthly(false);
      if (!saved) {
        errorHost.replaceChildren(el("div", { class: "alert alert-error", text: "تعذر حفظ التجاوز. تحقق من الاتصال وحاول مجدداً." }));
        return;
      }
      controller.close();
      await reload();
    };
    const remove = async () => {
      overrides.delete(key);
      const saved = await saveMonthly(false);
      if (!saved) {
        errorHost.replaceChildren(el("div", { class: "alert alert-error", text: "تعذر حفظ التجاوز. تحقق من الاتصال وحاول مجدداً." }));
        return;
      }
      controller.close();
      await reload();
    };
    const footer = [
      current ? el("button", { class: "btn btn-ghost", type: "button", onclick: remove }, icon("trash"), "إزالة التجاوز") : null,
      el("button", { class: "btn btn-ghost", type: "button", onclick: () => controller.close() }, "إلغاء"),
      el("button", { class: "btn btn-primary", type: "button", onclick: async (event) => {
        const button = event.currentTarget;
        setButtonLoading(button, true, "جارٍ الحفظ…");
        try {
          await apply();
        } catch (error) {
          errorHost.replaceChildren(el("div", { class: "alert alert-error", text: friendlyError(error) }));
        } finally {
          setButtonLoading(button, false);
        }
      } }, icon("check"), "حفظ التجاوز"),
    ].filter(Boolean);
    controller = openModal({ title: "تجاوز يوم في التحضير الشهري", description: "التجاوز يُطبَّق فوق بيانات التحضير اليومي ويُسجَّل في التدقيق.", body: dialogBody, footer, size: "sm" });
  }

  async function saveMonthly(silent) {
    if (!canEdit) return false;
    clearTimeout(saveTimer);
    if (savePromise) return savePromise;
    setSaveState("saving");
    savePromise = (async () => {
      try {
        await api("/api/attendance/monthly/save", {
          method: "POST",
          body: {
            branchId,
            year,
            month,
            notes,
            overrides: [...overrides.values()].map(({ employeeId, day, status, note }) => ({ employeeId, day, status, note: note ?? "" })),
          },
        });
        setSaveState("saved");
        return true;
      } catch (error) {
        setSaveState("error");
        if (!silent) toast(friendlyError(error), "error");
        return false;
      } finally {
        savePromise = null;
      }
    })();
    return savePromise;
  }

  async function submitMonthly(button) {
    if (!canSubmit) return;
    const saved = await saveMonthly(false);
    if (!saved) return;
    let confirmed = false;
    if (data.missingDays > 0) {
      confirmed = await confirmDialog({
        title: "تأكيد الأيام غير المسجلة",
        message: `يوجد ${formatNumber(data.missingDays)} خلية عمل غير مسجلة. سيُرسل الكشف مع تأكيدك بأن هذه الأيام مراجعة ومقصودة.`,
        confirmLabel: "تأكيد وإرسال",
        danger: true,
      });
      if (!confirmed) return;
    }
    setButtonLoading(button, true, "جارٍ الإرسال…");
    try {
      const id = data.monthly?.id;
      if (!id) throw new Error("احفظ الكشف أولاً قبل الإرسال.");
      await api(`/api/attendance/monthly/${id}/submit`, { method: "POST", body: { missingDaysConfirmed: confirmed, note: "" } });
      toast("تم إرسال كشف الشهر للاعتماد.", "success");
      await reload();
    } catch (error) {
      toast(friendlyError(error), "error");
    } finally {
      setButtonLoading(button, false);
    }
  }

  async function decideMonthly(kind, button) {
    let reason = "";
    if (kind === "reject") {
      reason = await openReasonDialog({ title: "إعادة كشف الشهر", message: "سيُعاد الكشف لمن أعدّه لتعديل التجاوزات ثم إعادة الإرسال.", label: "سبب الإعادة", confirmLabel: "إعادة", danger: true });
      if (!reason) return;
    } else {
      const ok = await confirmDialog({ title: "اعتماد كشف الشهر", message: "بعد الاعتماد يُقفل الكشف ويُستخدم في الرواتب والتقارير.", confirmLabel: "اعتماد" });
      if (!ok) return;
    }
    setButtonLoading(button, true, "جارٍ التنفيذ…");
    try {
      await api(`/api/attendance/monthly/${data.monthly.id}/${kind === "approve" ? "approve" : "reject"}`, { method: "POST", body: { reason } });
      toast(kind === "approve" ? "تم اعتماد كشف الشهر." : "تمت إعادة الكشف.", "success");
      await reload();
    } catch (error) {
      toast(friendlyError(error), "error");
    } finally {
      setButtonLoading(button, false);
    }
  }

  async function reload() {
    navigateHash("attendance-monthly", { branch: branchId, year, month, department: departmentId });
  }
}

async function renderFollowUp(host, token, params) {
  const now = defaultMonth();
  const year = Number(params.get("year")) || now.year;
  const month = Number(params.get("month")) || now.month;
  const late = params.get("late") !== "false";
  const data = await api(`/api/attendance/follow-up?year=${year}&month=${month}&late=${late}`);
  if (token !== state.renderToken) return;

  const monthInput = el("input", { class: "input", type: "month", value: `${year}-${String(month).padStart(2, "0")}`, "aria-label": "الشهر" });
  const lateSelect = el(
    "select",
    { class: "select", "aria-label": "تصفية التأخر" },
    el("option", { value: "true", selected: late }, "المتأخرة فقط"),
    el("option", { value: "false", selected: !late }, "جميع الفروع"),
  );
  const filters = filterBar(
    [
      { label: "الشهر", control: monthInput },
      { label: "العرض", control: lateSelect },
    ],
    {
      onApply: () => {
        const parsed = parseMonth(monthInput.value);
        navigateHash("attendance-monthly", { tab: "followup", year: parsed.year, month: parsed.month, late: lateSelect.value });
      },
      onReset: () => navigateHash("attendance-monthly", { tab: "followup" }),
    },
  );

  const pageTitle = pageHeader({
    title: "متابعة تحضير الفروع",
    subtitle: `${monthLabel(year, month)} · حالة كل فرع من حيث التغطية والاعتماد والتأخر`,
    actions: [
      el("button", { class: "btn btn-secondary", type: "button", onclick: () => printPage({ landscape: true }) }, icon("printer"), "طباعة"),
    ],
  });

  const rows = data.rows || [];
  const statusRows = rows.map((row) => {
    const meta = FOLLOW_STATUS[row.status] ?? FOLLOW_STATUS.not_started;
    return el(
      "tr",
      { class: row.late ? "row-late" : "" },
      el("td", {}, el("div", { class: "cell-person" }, el("div", {}, el("strong", { text: row.branchName }), el("span", { text: row.branchCode })))),
      el("td", { class: "num", text: formatNumber(row.employees) }),
      el("td", { class: "num", text: formatNumber(row.expectedWorkdays) }),
      el("td", { class: "num", text: formatNumber(row.coveredDays) }),
      el("td", { class: `num ${row.missingDays > 0 ? "text-danger" : ""}`.trim(), text: formatNumber(row.missingDays) }),
      el("td", { class: "num", text: formatNumber(row.approvedDays) }),
      el("td", { class: "num", text: formatNumber(row.submittedDays) }),
      el("td", { class: "num", text: formatNumber(row.draftDays) }),
      statusTag(FOLLOW_STATUS, row.status),
      el("td", { class: "tiny muted", text: row.lastSubmissionAt ? `${formatDateTime(row.lastSubmissionAt)} · ${row.lastSubmitter || ""}` : "—" }),
      el(
        "td",
        { class: "no-print" },
        el(
          "div",
          { class: "inline-actions" },
          el("button", { class: "btn btn-secondary btn-sm", type: "button", onclick: () => navigateHash("attendance-monthly", { branch: row.branchId, year, month }) }, "كشف الشهر"),
          el("button", { class: "btn btn-ghost btn-sm", type: "button", onclick: () => navigateHash("attendance-daily", { branch: row.branchId, date: todayISO() }) }, "تحضير اليوم"),
        ),
      ),
    );
  });

  host.replaceChildren(
    pageEnter(
      pageTitle,
      tabBar("followup"),
      filters,
      summaryStrip([
        { label: "الفروع", value: data.totals.branches, tone: "blue", iconName: "building" },
        { label: "الأيام الناقصة", value: data.totals.missingDays, tone: "orange", iconName: "alert-triangle" },
        { label: "فروع متأخرة", value: data.totals.lateBranches, tone: "red", iconName: "clock" },
      ]),
      el(
        "div",
        { class: "card table-card" },
        rows.length === 0
          ? el("div", { class: "empty-inline", text: late ? "لا توجد فروع متأخرة في هذا الشهر." : "لا توجد فروع ضمن نطاقك." })
          : el(
              "div",
              { class: "table-wrap" },
              el(
                "table",
                { class: "att-table" },
                el(
                  "thead",
                  {},
                  el(
                    "tr",
                    {},
                    ...["الفرع", "الموظفون", "أيام العمل", "الأيام المغطاة", "الناقص", "معتمد", "مرسل", "مسودة", "الحالة", "آخر إرسال", "إجراءات"].map((label, index) => el("th", { class: index === 10 ? "no-print" : "", text: label })),
                  ),
                ),
                el("tbody", {}, ...statusRows),
              ),
            ),
      ),
      el(
        "div",
        { class: "legend" },
        el("span", {}, "العتبة: يُعدّ الفرع متأخراً عند وجود أيام عمل غير مسجلة أو كشف غير مرسل بعد."),
      ),
    ),
  );
}
