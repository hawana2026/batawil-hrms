import {
  api,
  confirmDialog,
  el,
  errorBlock,
  formatDateTime,
  formatFullDay,
  formatNumber,
  icon,
  loadingBlock,
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
  SUBMISSION_STATUS,
  attTag,
  branchList,
  branchSelectOptions,
  downloadFile,
  filterBar,
  hashParams,
  navigateHash,
  openFormDialog,
  openReasonDialog,
  printHeader,
  printPage,
  summaryStrip,
} from "../hr-common.js";

export async function renderAttendanceDaily(host, token) {
  const params = hashParams();
  const preferredBranch = params.get("branch") || "";
  const branches = branchList();
  if (branches.length === 0) {
    host.replaceChildren(
      pageEnter(
        pageHeader({ title: "التحضير اليومي", subtitle: "سجل الحضور اليدوي لكل فرع ويوم." }),
        el("div", { class: "card" }, el("div", { class: "empty-inline", text: "لا توجد فروع متاحة ضمن نطاق صلاحيتك." })),
      ),
    );
    return;
  }
  const branchId = branches.some((branch) => branch.id === preferredBranch) ? preferredBranch : (branches.find((b) => b.active)?.id ?? branches[0].id);
  const date = params.get("date") || todayISO();
  host.replaceChildren(loadingBlock("جارٍ تحميل كشف التحضير…"));

  let data;
  try {
    data = await api(`/api/attendance/daily?branchId=${encodeURIComponent(branchId)}&date=${encodeURIComponent(date)}`);
  } catch (error) {
    if (token !== state.renderToken) return;
    host.replaceChildren(errorBlock(friendlyError(error), () => renderAttendanceDaily(host, token)));
    return;
  }
  if (token !== state.renderToken) return;
  paint();

  function paint() {
    const rows = data.rows.map((row) => ({ ...row, touched: false }));
    const submission = { ...data.submission };
    const canEdit = Boolean(data.capabilities.canManage);
    const canSubmit = Boolean(data.capabilities.canSubmit);
    const canApprove = Boolean(data.capabilities.canApprove);
    const canCorrect = Boolean(data.capabilities.canCorrect);
    const readOnly = !canEdit;
    const statusMeta = SUBMISSION_STATUS[submission.status] ?? SUBMISSION_STATUS.draft;
    let autosaveTimer = null;
    let savePromise = null;
    let saving = false;

    const summaryHost = el("div");
    const sheetStateHost = el("div");
    const tableHost = el("div");
    const autoSaveNode = el("span", { class: "auto-save" });
    setAutoSave("idle");

    const pageTitle = pageHeader({
      title: `التحضير اليومي — ${data.branch.name}`,
      subtitle: `${formatFullDay(`${data.date}T00:00:00`)} · ${formatNumber(data.counts.total)} موظفاً في الفرع · التحضير اليدوي مستقل عن أجهزة البصمة.`,
      actions: [],
    });
    const actionsHost = pageTitle.querySelector(".page-actions") ?? el("div");
    if (!actionsHost.parentNode) pageTitle.append(actionsHost);

    function action(iconName, label, handler, kind = "btn-secondary", disabled = false, cls = "") {
      const button = el(
        "button",
        { class: `btn ${kind} ${cls}`.trim(), type: "button", disabled, onclick: handler },
        icon(iconName),
        label,
      );
      return button;
    }

    let saveButton = null;
    let submitButton = null;
    actionsHost.append(
      action("printer", "طباعة / PDF", () => printPage({ landscape: true })),
      action("download", "تصدير Excel", async (event) => {
        const button = event?.currentTarget;
        setButtonLoading(button, true, "جارٍ التصدير…");
        try {
          await downloadFile(
            `/api/attendance/daily/export.xlsx?branchId=${encodeURIComponent(branchId)}&date=${encodeURIComponent(date)}`,
            `attendance-${date}.xlsx`,
          );
        } catch (error) {
          toast(error.message, "error");
        } finally {
          setButtonLoading(button, false);
        }
      }),
    );
    if (canEdit) {
      saveButton = action("check", "حفظ المسودة", async (event) => {
        const button = event?.currentTarget;
        setButtonLoading(button, true, "جارٍ الحفظ…");
        try {
          const ok = await saveRows(false);
          if (ok) toast("تم حفظ المسودة.", "success");
        } finally {
          setButtonLoading(button, false);
        }
      }, "btn-secondary");
      submitButton = action("send", "إرسال للاعتماد", async (event) => submitSheet(event?.currentTarget));
      actionsHost.append(saveButton, submitButton);
    }
    if (canApprove) {
      actionsHost.append(
        action("circle-check", "اعتماد الكشف", (event) => decideSheet("approve", event?.currentTarget), "btn-primary"),
        action("corner-up-left", "إعادة الكشف", (event) => decideSheet("reject", event?.currentTarget), "btn-ghost"),
      );
    }

    const printHead = printHeader({
      title: `كشف التحضير اليومي — ${data.branch.name}`,
      subtitle: `${data.date} · ${formatFullDay(`${data.date}T00:00:00`)}`,
      meta: [
        `الفرع: ${data.branch.name} (${data.branch.code})`,
        `حالة الكشف: ${statusMeta.label}`,
        `أُعد بواسطة: ${submission.preparedBy || "—"}`,
        `الاعتماد: ${submission.approvedBy || "—"}`,
      ],
    });

    const branchSelect = el(
      "select",
      { class: "select", "aria-label": "الفرع" },
      ...branchSelectOptions(branchId),
    );
    const dateInput = el("input", {
      class: "input",
      type: "date",
      value: date,
      max: data.today,
      "aria-label": "تاريخ التحضير",
    });
    const filters = filterBar(
      [
        { label: "الفرع", control: branchSelect },
        { label: "تاريخ التحضير", control: dateInput },
      ],
      {
        onApply: () => navigateHash("attendance-daily", { branch: branchSelect.value, date: dateInput.value }),
        onReset: () => navigateHash("attendance-daily", { branch: branchId, date: todayISO() }),
        extra: el(
          "span",
          { class: "tiny muted" },
          `بداية الدوام ${data.settings.workStart} · سماح ${formatNumber(data.settings.lateGraceMinutes)} دقيقة`,
        ),
      },
    );

    renderSummary();
    renderSheetState();
    renderTable();

    const notesInput = el("input", {
      class: "input",
      placeholder: "ملاحظات الكشف (اختياري)",
      value: submission.notes || "",
      maxlength: 1000,
      disabled: readOnly,
      "aria-label": "ملاحظات الكشف",
    });
    notesInput.addEventListener("input", () => {
      submission.notes = notesInput.value;
      markDirty(null, false);
    });

    const bulkStatus = el(
      "select",
      { class: "select", "aria-label": "حالة جماعية" },
      ...ATT_ORDER.map((status) => el("option", { value: status }, ATT_STATUS[status].label)),
    );
    const bulkButton = el(
      "button",
      {
        class: "btn btn-secondary btn-sm",
        type: "button",
        disabled: readOnly,
        onclick: () => {
          for (const row of rows) {
            row.status = bulkStatus.value;
            row.touched = true;
          }
          renderTable();
          renderSummary();
          markDirty(null, false);
          toast(`تم تعيين الحالة "${ATT_STATUS[bulkStatus.value].label}" لجميع الصفوف. احفظ الكشف لتثبيتها.`, "info");
        },
      },
      icon("check"),
      "تطبيق على الكل",
    );
    const addManualButton = el(
      "button",
      {
        class: "btn btn-secondary btn-sm",
        type: "button",
        disabled: readOnly,
        onclick: () => {
          rows.push({
            id: null,
            employeeId: null,
            manualName: "",
            employeeNo: "—",
            fullName: "",
            departmentId: null,
            departmentName: null,
            status: "present",
            checkIn: "",
            checkOut: "",
            lateMinutes: 0,
            workHours: 0,
            reason: "",
            notes: "",
            recorded: false,
            temporary: true,
            touched: true,
          });
          renderTable();
          const input = tableHost.querySelector("tr.row-temporary input.input-name");
          input?.focus();
        },
      },
      icon("plus"),
      "اسم مؤقت",
    );

    const cardFooter = el(
      "div",
      { class: "card-footer no-print" },
      el(
        "span",
        {},
        `إجمالي الصفوف المسجلة: ${formatNumber(data.counts.recorded)} من ${formatNumber(data.counts.total)} · الأسماء المؤقتة: ${formatNumber(data.counts.manual)}`,
      ),
      el("span", { class: "tag", text: "التأخير يُحتسب تلقائياً من وقت الحضور" }),
    );

    const toolbar = el(
      "div",
      { class: "attendance-toolbar no-print" },
      el(
        "div",
        { class: "toolbar-group" },
        bulkStatus,
        bulkButton,
        addManualButton,
        el("div", { style: "flex:1; min-width:170px" }, notesInput),
      ),
      autoSaveNode,
    );

    const card = el(
      "div",
      { class: "card table-card" },
      toolbar,
      tableHost,
      el("div", { class: "legend" }, ...Object.entries(ATT_STATUS).map(([, meta]) => el("span", {}, el("b", { text: meta.symbol }), meta.label)), el("span", { class: "tiny muted", text: "الرمز في ملف Excel الشهري" })),
      cardFooter,
    );

    host.replaceChildren(
      pageEnter(
        pageTitle,
        filters,
        printHead,
        summaryHost,
        sheetStateHost,
        card,
      ),
    );

    function setAutoSave(mode, text = "") {
      autoSaveNode.className = `auto-save ${mode === "idle" ? "" : mode}`.trim();
      const iconName = mode === "saving" ? "refresh" : mode === "error" ? "alert-circle" : mode === "dirty" ? "clock" : "circle-check";
      const label =
        text ||
        (mode === "saving"
          ? "جارٍ حفظ المسودة…"
          : mode === "error"
            ? "تعذر الحفظ التلقائي"
            : mode === "dirty"
              ? "تغييرات غير محفوظة…"
              : mode === "saved"
                ? "جميع التغييرات محفوظة"
                : canEdit
                  ? "الحفظ التلقائي مفعّل"
                  : "");
      autoSaveNode.replaceChildren(icon(iconName), el("span", { text: label }));
    }

    function refreshCounts() {
      const counts = { total: 0, recorded: 0, unrecorded: 0, present: 0, absent: 0, leave: 0, permission: 0, mission: 0, weeklyRest: 0, late: 0, excusedAbsence: 0, manual: 0 };
      for (const row of rows) {
        if (row.temporary) {
          if (row.manualName.trim()) counts.manual += 1;
          continue;
        }
        counts.total += 1;
        if (row.recorded || row.touched) counts.recorded += 1;
        else counts.unrecorded += 1;
        if (row.status === "present") counts.present += 1;
        else if (row.status === "absent") counts.absent += 1;
        else if (row.status === "leave") counts.leave += 1;
        else if (row.status === "permission") counts.permission += 1;
        else if (row.status === "mission") counts.mission += 1;
        else if (row.status === "weekly_rest") counts.weeklyRest += 1;
        else if (row.status === "late") counts.late += 1;
        else if (row.status === "excused_absence") counts.excusedAbsence += 1;
      }
      return counts;
    }

    function renderSummary() {
      const counts = refreshCounts();
      summaryHost.replaceChildren(
        summaryStrip([
          { label: "موظفو الفرع", value: counts.total, tone: "blue", iconName: "users" },
          { label: "صفوف مسجلة", value: counts.recorded, tone: "green", iconName: "circle-check" },
          { label: "غير مسجل", value: counts.unrecorded, tone: "orange", iconName: "alert-triangle" },
          { label: "حاضر", value: counts.present, tone: "green", iconName: "user-check" },
          { label: "غائب", value: counts.absent, tone: "red", iconName: "circle-x" },
          { label: "تأخير", value: counts.late, tone: "orange", iconName: "clock" },
          { label: "إجازات وأذونات", value: counts.leave + counts.permission, tone: "purple", iconName: "calendar" },
          { label: "أسماء مؤقتة", value: counts.manual, tone: "blue", iconName: "user-plus" },
        ]),
      );
    }

    function renderSheetState() {
      const meta = SUBMISSION_STATUS[submission.status] ?? SUBMISSION_STATUS.draft;
      const tone = submission.status === "approved" ? "success" : submission.status === "rejected" ? "danger" : submission.status === "submitted" ? "warning" : "";
      const steps = [
        { label: "مسودة", done: true },
        { label: "مرسل للاعتماد", done: submission.status === "submitted" || submission.status === "approved", current: submission.status === "submitted" },
        { label: "معتمد", done: submission.status === "approved", current: submission.status === "approved" },
      ];
      const node = el(
        "div",
        { class: `sheet-state ${tone}`.trim() },
        el(
          "div",
          { class: "state-copy" },
          el(
            "strong",
            {},
            el("span", { class: "inline-actions" }, "حالة الكشف: ", statusBadge(meta.label, meta.tone)),
            !submission.id ? el("span", { class: "tiny muted", text: " — لم يُحفظ الكشف بعد" }) : null,
          ),
          submission.rejectionReason
            ? el("p", { class: "timeline-note", style: "margin-top:8px", text: `سبب الإعادة: ${submission.rejectionReason}` })
            : el("p", {
                text:
                  submission.status === "approved"
                    ? "الكشف معتمد وثابت. أي تعديل لاحق يتطلب صلاحية التصحيح ويُسجَّل في التدقيق."
                    : submission.status === "submitted"
                      ? "الكشف مرسل للاعتماد ولا يمكن تعديله قبل اعتماده أو إعادته."
                      : "يمكن تعديل الصفوف وحفظها كمسودة، ثم إرسالها للاعتماد عند اكتمالها.",
              }),
          el(
            "div",
            { class: "sheet-meta" },
            el("span", {}, "أعدّه: ", el("b", { text: submission.preparedBy || "—" })),
            el("span", {}, "أرسله: ", el("b", { text: submission.submittedBy || "—" })),
            submission.submittedAt ? el("span", {}, "وقت الإرسال: ", el("b", { text: formatDateTime(submission.submittedAt) })) : null,
            submission.approvedBy ? el("span", {}, "اعتمده: ", el("b", { text: submission.approvedBy })) : null,
            submission.approvedAt ? el("span", {}, "وقت الاعتماد: ", el("b", { text: formatDateTime(submission.approvedAt) })) : null,
            submission.correctionCount > 0
              ? el("span", {}, "تصحيحات: ", el("b", { text: `${formatNumber(submission.correctionCount)} — ${submission.lastCorrectedBy || ""}` }))
              : null,
          ),
        ),
        el("div", { class: "status-flow" }, ...steps.map((step) =>
          el(
            "span",
            { class: `flow-step ${step.current ? "current" : step.done ? "done" : ""}`.trim() },
            icon(step.done ? "check" : "clock"),
            step.label,
          ),
        )),
      );
      sheetStateHost.replaceChildren(node);
    }

    function renderTable() {
      const headers = ["#", "الرقم الوظيفي", "الموظف", "القسم", "الحالة", "الحضور", "الانصراف", "تأخير (د)", "ساعات العمل", "السبب", "ملاحظات"];
      if (canCorrect || canEdit) headers.push("إجراءات");
      const tbody = el("tbody");
      rows.forEach((row, index) => {
        const rowNode = el("tr", {
          class: `${row.temporary ? "row-temporary" : ""} ${row.touched ? "row-touched" : ""} ${!row.recorded && !row.touched && !row.temporary ? "row-unrecorded" : ""}`.trim(),
        });
        rowNode.append(
          el("td", { class: "row-index num", text: formatNumber(index + 1) }),
          el("td", { class: "nowrap" }, el("span", { class: "code-chip", text: row.employeeNo || "—" })),
          el(
            "td",
            {},
            row.temporary && canEdit
              ? el("input", {
                  class: "input input-name",
                  value: row.manualName,
                  placeholder: "اسم مؤقت…",
                  maxlength: 120,
                  "aria-label": "اسم مؤقت",
                  oninput: (event) => {
                    row.manualName = event.currentTarget.value;
                    markDirty(row, false);
                  },
                })
              : el(
                  "div",
                  { class: "cell-person" },
                  el(
                    "div",
                    {},
                    el("strong", { text: row.fullName || row.manualName || "—" }),
                    row.temporary ? el("span", { class: "tag warning", style: "margin-top:2px", text: "اسم مؤقت" }) : null,
                    row.status === "weekly_rest" ? el("span", { class: "tag", style: "margin-top:2px", text: "راحة" }) : null,
                  ),
                ),
          ),
          el("td", { class: "tiny muted", text: row.departmentName || "—" }),
          el(
            "td",
            {},
            el(
              "select",
              {
                class: "select status-select-pill",
                disabled: readOnly || !canEdit,
                "aria-label": "حالة الحضور",
                onchange: (event) => {
                  row.status = event.currentTarget.value;
                  markDirty(row, true);
                },
              },
              ...ATT_ORDER.map((status) => el("option", { value: status, selected: status === row.status }, ATT_STATUS[status].label)),
            ),
          ),
          el(
            "td",
            {},
            el("input", {
              class: "input input-time",
              type: "time",
              value: row.checkIn || "",
              disabled: readOnly || !canEdit,
              "aria-label": "وقت الحضور",
              oninput: (event) => {
                row.checkIn = event.currentTarget.value;
                markDirty(row, false);
              },
            }),
          ),
          el(
            "td",
            {},
            el("input", {
              class: "input input-time",
              type: "time",
              value: row.checkOut || "",
              disabled: readOnly || !canEdit,
              "aria-label": "وقت الانصراف",
              oninput: (event) => {
                row.checkOut = event.currentTarget.value;
                markDirty(row, false);
              },
            }),
          ),
          el(
            "td",
            {},
            el("input", {
              class: "input input-mini",
              type: "number",
              min: 0,
              max: 1440,
              value: row.lateMinutes || 0,
              disabled: readOnly || !canEdit,
              "aria-label": "دقائق التأخير",
              oninput: (event) => {
                row.lateMinutes = Number(event.currentTarget.value || 0);
                markDirty(row, false);
              },
            }),
          ),
          el(
            "td",
            {},
            el("input", {
              class: "input input-mini",
              type: "number",
              min: 0,
              max: 24,
              step: "0.25",
              value: row.workHours || 0,
              disabled: readOnly || !canEdit,
              "aria-label": "ساعات العمل",
              oninput: (event) => {
                row.workHours = Number(event.currentTarget.value || 0);
                markDirty(row, false);
              },
            }),
          ),
          el(
            "td",
            {},
            el("input", {
              class: "input input-reason",
              value: row.reason || "",
              maxlength: 300,
              placeholder: "سبب الغياب أو الإذن…",
              disabled: readOnly || !canEdit,
              "aria-label": "السبب",
              oninput: (event) => {
                row.reason = event.currentTarget.value;
                markDirty(row, false);
              },
            }),
          ),
          el(
            "td",
            {},
            el("input", {
              class: "input input-notes",
              value: row.notes || "",
              maxlength: 500,
              disabled: readOnly || !canEdit,
              "aria-label": "ملاحظات",
              oninput: (event) => {
                row.notes = event.currentTarget.value;
                markDirty(row, false);
              },
            }),
          ),
        );

        if (canCorrect || canEdit) {
          const actionCell = el("td", { class: "no-print" });
          if (canCorrect && row.id) {
            actionCell.append(
              el(
                "button",
                { class: "icon-btn", type: "button", title: "تصحيح الصف", onclick: () => correctRow(row) },
                icon("pencil"),
              ),
            );
          }
          if (canEdit && row.temporary) {
            actionCell.append(
              el(
                "button",
                {
                  class: "icon-btn danger",
                  type: "button",
                  title: "حذف الاسم المؤقت",
                  onclick: () => {
                    const indexToRemove = rows.indexOf(row);
                    if (indexToRemove >= 0) rows.splice(indexToRemove, 1);
                    renderTable();
                    renderSummary();
                    markDirty(null, false);
                  },
                },
                icon("trash"),
              ),
            );
          }
          rowNode.append(actionCell);
        }
        tbody.append(rowNode);
      });
      const table = el(
        "table",
        { class: "att-table" },
        el("thead", {}, el("tr", {}, headers.map((label, index) => el("th", { class: index === headers.length - 1 && (canCorrect || canEdit) ? "no-print" : "", text: label })))),
        tbody,
      );
      tableHost.replaceChildren(
        rows.length === 0
          ? el("div", { class: "empty-inline", text: "لا توجد صفوف. أضف اسماً مؤقتاً أو تحقق من بيانات موظفي الفرع." })
          : el("div", { class: "table-wrap" }, table),
      );
    }

    function markDirty(row, rerenderSummary = false) {
      if (row) row.touched = true;
      if (!canEdit) return;
      setAutoSave("dirty");
      if (rerenderSummary) renderSummary();
      clearTimeout(autosaveTimer);
      autosaveTimer = setTimeout(() => {
        saveRows(true);
      }, 1400);
    }

    function payloadRows() {
      return rows
        .filter((row) => (row.temporary ? row.manualName.trim() !== "" : Boolean(row.employeeId && (row.recorded || row.touched))))
        .map((row) => ({
          employeeId: row.employeeId || undefined,
          manualName: row.temporary ? row.manualName.trim() : undefined,
          status: row.status,
          checkIn: row.checkIn || "",
          checkOut: row.checkOut || "",
          lateMinutes: Number(row.lateMinutes || 0),
          workHours: Number(row.workHours || 0),
          reason: row.reason || "",
          notes: row.notes || "",
        }));
    }

    async function performSave(silent) {
      if (!canEdit) return false;
      const payload = payloadRows();
      if (payload.length === 0) {
        if (!silent) toast("أضف صفاً واحداً على الأقل قبل الحفظ.", "warning");
        setAutoSave("idle");
        return false;
      }
      const names = payload.filter((row) => row.manualName).map((row) => row.manualName.toLowerCase());
      if (new Set(names).size !== names.length) {
        setAutoSave("error");
        toast("يوجد اسم مؤقت مكرر في الكشف. وحّد الأسماء قبل الحفظ.", "error");
        return false;
      }
      saving = true;
      setAutoSave("saving");
      try {
        const result = await api("/api/attendance/daily/save", {
          method: "POST",
          body: { branchId, date, notes: notesInput?.value ?? submission.notes ?? "", rows: payload },
        });
        if (token !== state.renderToken) return false;
        Object.assign(submission, result.submission);
        for (const row of rows) {
          if (row.employeeId && (row.recorded || row.touched)) {
            row.recorded = true;
            row.touched = false;
          } else if (row.temporary && row.manualName.trim()) {
            row.recorded = true;
            row.touched = false;
          }
        }
        setAutoSave("saved");
        renderSummary();
        renderSheetState();
        return true;
      } catch (error) {
        setAutoSave("error");
        if (!silent) toast(friendlyError(error), "error");
        else toast("تعذر الحفظ التلقائي. راجع البيانات ثم احفظ يدوياً.", "error");
        return false;
      } finally {
        saving = false;
      }
    }

    function saveRows(silent) {
      clearTimeout(autosaveTimer);
      if (savePromise) return savePromise;
      savePromise = performSave(silent).finally(() => {
        savePromise = null;
      });
      return savePromise;
    }

    async function submitSheet(button) {
      if (!canSubmit) return;
      const confirmed = await confirmDialog({
        title: "إرسال الكشف للاعتماد",
        message: "سيُقفل الكشف للتحرير ويُرسل إلى أصحاب صلاحية الاعتماد. تأكد من مراجعة جميع الصفوف قبل المتابعة.",
        confirmLabel: "إرسال للاعتماد",
      });
      if (!confirmed) return;
      setButtonLoading(button, true, "جارٍ الإرسال…");
      try {
        const saved = await saveRows(false);
        if (!saved || !submission.id) return;
        await api(`/api/attendance/daily/${submission.id}/submit`, { method: "POST", body: { note: "" } });
        toast("تم إرسال الكشف للاعتماد.", "success");
        await reload();
      } catch (error) {
        toast(friendlyError(error), "error");
      } finally {
        setButtonLoading(button, false);
      }
    }

    async function decideSheet(kind, button) {
      let reason = "";
      if (kind === "reject") {
        reason = await openReasonDialog({
          title: "إعادة كشف التحضير",
          message: "سيُعاد الكشف لمن أعدّه ويمكنه تعديله ثم إرساله مجدداً.",
          label: "سبب الإعادة",
          confirmLabel: "إعادة الكشف",
          danger: true,
        });
        if (!reason) return;
      } else {
        const confirmed = await confirmDialog({
          title: "اعتماد كشف التحضير",
          message: "بعد الاعتماد يصبح الكشف ثابتاً، ولا يمكن تعديله إلا عبر صلاحية التصحيح مع تسجيل السبب.",
          confirmLabel: "اعتماد",
        });
        if (!confirmed) return;
      }
      setButtonLoading(button, true, "جارٍ التنفيذ…");
      try {
        await api(`/api/attendance/daily/${submission.id}/${kind === "approve" ? "approve" : "reject"}`, {
          method: "POST",
          body: { reason },
        });
        toast(kind === "approve" ? "تم اعتماد الكشف." : "تمت إعادة الكشف.", "success");
        await reload();
      } catch (error) {
        toast(friendlyError(error), "error");
      } finally {
        setButtonLoading(button, false);
      }
    }

    function correctRow(row) {
      if (!row.id) return;
      openFormDialog({
        title: `تصحيح صف — ${row.fullName || row.manualName}`,
        description: "التصحيح على كشف معتمد يُسجَّل في سجل التدقيق مع سبب إلزامي.",
        submitLabel: "حفظ التصحيح",
        fields: [
          {
            name: "status",
            label: "الحالة",
            type: "select",
            options: ATT_ORDER.map((status) => ({ value: status, label: ATT_STATUS[status].label })),
            value: row.status,
          },
          { name: "checkIn", label: "وقت الحضور", type: "time", value: row.checkIn || "" },
          { name: "checkOut", label: "وقت الانصراف", type: "time", value: row.checkOut || "" },
          { name: "lateMinutes", label: "دقائق التأخير", type: "number", min: 0, max: 1440, value: row.lateMinutes || 0 },
          { name: "workHours", label: "ساعات العمل", type: "number", min: 0, max: 24, step: "0.25", value: row.workHours || 0 },
          { name: "reason", label: "سبب الحالة", value: row.reason || "", span: 2 },
          { name: "notes", label: "ملاحظات", value: row.notes || "", span: 2 },
          {
            name: "correctionReason",
            label: "سبب التصحيح (إلزامي)",
            type: "textarea",
            rows: 3,
            required: true,
            span: 2,
            hint: "سيظهر هذا السبب في سجل التدقيق.",
          },
        ],
        onSubmit: async (values) => {
          await api(`/api/attendance/daily/${submission.id}/rows/${row.id}`, {
            method: "PATCH",
            body: {
              status: values.status,
              checkIn: values.checkIn,
              checkOut: values.checkOut,
              lateMinutes: Number(values.lateMinutes || 0),
              workHours: Number(values.workHours || 0),
              reason: values.reason,
              notes: values.notes,
              correctionReason: values.correctionReason,
            },
          });
          toast("تم حفظ التصحيح وتسجيله في التدقيق.", "success");
          await reload();
        },
      });
    }

    async function reload() {
      clearTimeout(autosaveTimer);
      try {
        const refreshed = await api(`/api/attendance/daily?branchId=${encodeURIComponent(branchId)}&date=${encodeURIComponent(date)}`);
        if (token !== state.renderToken) return;
        data = refreshed;
        paint();
      } catch (error) {
        toast(friendlyError(error), "error");
      }
    }
  }
}
