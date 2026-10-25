import type { Db, Row } from "../db/index.js";
import { ApiError, conflict, forbidden, notFound } from "../lib/errors.js";
import { newId } from "../lib/ids.js";
import { closeApproval, notifyPermissionHolders, notifyUser, openApproval } from "./approvals.js";
import { applyDueTransfers, nextEmployeeNo } from "./employees.js";

export interface DecisionActor {
  id: string;
  username: string;
  fullName: string;
}

export interface DecisionOutcome {
  action: string;
  branchId: string | null;
  entityId: string;
  details: Record<string, unknown>;
  requesterId: string | null;
  summary: string;
}

function requireReason(note: string, decision: "approved" | "rejected"): string | null {
  if (decision === "rejected" && note.trim().length < 3) {
    throw new ApiError(400, "REASON_REQUIRED", "سبب الرفض أو الإعادة مطلوب.");
  }
  return note.trim() || null;
}

export async function decideAttendanceDay(
  db: Db,
  actor: DecisionActor,
  submissionId: string,
  decision: "approved" | "rejected",
  note: string,
): Promise<DecisionOutcome> {
  const reason = requireReason(note, decision);
  const result = await db.query<
    Row & {
      id: string;
      branch_id: string;
      branch_name: string;
      work_date: string;
      status: string;
      submitted_by: string | null;
    }
  >(
    `SELECT s.id, s.branch_id, b.name AS branch_name, s.work_date::text AS work_date, s.status, s.submitted_by
     FROM attendance_submissions s JOIN branches b ON b.id = s.branch_id WHERE s.id = $1`,
    [submissionId],
  );
  const submission = result.rows[0];
  if (!submission) throw notFound("كشف التحضير غير موجود.");
  if (submission.status !== "submitted") throw conflict("لا يمكن اعتماد أو رفض كشف غير مرسل.");
  await db.query(
    `UPDATE attendance_submissions
     SET status = $2, approved_by = $3, approved_at = now(), rejection_reason = $4, updated_at = now()
     WHERE id = $1`,
    [submissionId, decision, actor.id, decision === "rejected" ? reason : null],
  );
  await closeApproval(db, "attendance_day", submissionId, decision, actor.id, reason);
  await notifyUser(
    db,
    submission.submitted_by,
    decision === "approved" ? "اعتماد كشف التحضير" : "إعادة كشف التحضير",
    decision === "approved"
      ? `اعتُمد كشف ${submission.branch_name} بتاريخ ${submission.work_date}.`
      : `أُعيد كشف ${submission.branch_name} بتاريخ ${submission.work_date}. السبب: ${reason}`,
    `#/attendance/daily?branch=${submission.branch_id}&date=${submission.work_date}`,
  );
  return {
    action: decision === "approved" ? "attendance.approved" : "attendance.rejected",
    branchId: submission.branch_id,
    entityId: submissionId,
    requesterId: submission.submitted_by,
    summary: `تحضير ${submission.branch_name} بتاريخ ${submission.work_date}`,
    details: { date: submission.work_date, reason: reason ?? undefined },
  };
}

export async function decideAttendanceMonth(
  db: Db,
  actor: DecisionActor,
  monthlyId: string,
  decision: "approved" | "rejected",
  note: string,
): Promise<DecisionOutcome> {
  const reason = requireReason(note, decision);
  const result = await db.query<
    Row & {
      id: string;
      branch_id: string;
      branch_name: string;
      year: number;
      month: number;
      status: string;
      submitted_by: string | null;
    }
  >(
    `SELECT m.id, m.branch_id, b.name AS branch_name, m.year, m.month, m.status, m.submitted_by
     FROM monthly_attendance m JOIN branches b ON b.id = m.branch_id WHERE m.id = $1`,
    [monthlyId],
  );
  const monthly = result.rows[0];
  if (!monthly) throw notFound("سجل الشهر غير موجود.");
  if (monthly.status !== "submitted") throw conflict("لا يمكن اعتماد أو رفض سجل غير مرسل.");
  await db.query(
    `UPDATE monthly_attendance SET status = $2, approved_by = $3, approved_at = now(), rejection_reason = $4, updated_at = now() WHERE id = $1`,
    [monthlyId, decision, actor.id, decision === "rejected" ? reason : null],
  );
  await closeApproval(db, "attendance_month", monthlyId, decision, actor.id, reason);
  await notifyUser(
    db,
    monthly.submitted_by,
    decision === "approved" ? "اعتماد التحضير الشهري" : "إعادة التحضير الشهري",
    decision === "approved"
      ? `اعتُمد تحضير ${monthly.branch_name} لشهر ${monthly.month}/${monthly.year}.`
      : `أُعيد تحضير ${monthly.branch_name} لشهر ${monthly.month}/${monthly.year}. السبب: ${reason}`,
    `#/attendance/monthly?branch=${monthly.branch_id}&year=${monthly.year}&month=${monthly.month}`,
  );
  return {
    action: decision === "approved" ? "attendance.monthly_approved" : "attendance.monthly_rejected",
    branchId: monthly.branch_id,
    entityId: monthlyId,
    requesterId: monthly.submitted_by,
    summary: `تحضير ${monthly.branch_name} لشهر ${monthly.month}/${monthly.year}`,
    details: { year: monthly.year, month: monthly.month, reason: reason ?? undefined },
  };
}

export async function decideLeave(
  db: Db,
  actor: DecisionActor,
  leaveId: string,
  decision: "approved" | "rejected",
  note: string,
): Promise<DecisionOutcome> {
  const reason = requireReason(note, decision);
  const result = await db.query<
    Row & {
      id: string;
      employee_id: string;
      employee_name: string;
      branch_id: string;
      branch_name: string;
      leave_type: string;
      start_date: string;
      end_date: string;
      status: string;
      requested_by: string | null;
    }
  >(
    `SELECT l.id, l.employee_id, e.full_name AS employee_name, l.branch_id, b.name AS branch_name,
            l.leave_type, l.start_date::text AS start_date, l.end_date::text AS end_date, l.status, l.requested_by
     FROM leave_requests l
     JOIN employees e ON e.id = l.employee_id
     JOIN branches b ON b.id = l.branch_id
     WHERE l.id = $1`,
    [leaveId],
  );
  const leave = result.rows[0];
  if (!leave) throw notFound("طلب الإجازة غير موجود.");
  if (leave.status !== "pending") throw conflict("لا يمكن اعتماد طلب ليس قيد المراجعة.");
  let linkedDayRows = 0;
  await db.transaction(async (tx) => {
    await tx.query(
      `UPDATE leave_requests SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4, updated_at = now() WHERE id = $1`,
      [leaveId, decision, actor.id, reason],
    );
    if (decision === "approved") {
      const attendanceStatus = leave.leave_type === "permission" ? "permission" : "leave";
      const updated = await tx.query(
        `UPDATE daily_attendance d
         SET status = $1,
             reason = CASE WHEN d.reason = '' THEN $2 ELSE d.reason || ' — ' || $2 END,
             updated_by = $3,
             updated_at = now()
         FROM attendance_submissions s
         WHERE d.submission_id = s.id
           AND d.employee_id = $4
           AND s.branch_id = $5
           AND s.work_date BETWEEN $6::date AND $7::date
           AND s.status IN ('draft', 'rejected')`,
        [attendanceStatus, leave.leave_type === "permission" ? "إذن معتمد" : "إجازة معتمدة", actor.id, leave.employee_id, leave.branch_id, leave.start_date, leave.end_date],
      );
      linkedDayRows = updated.rowCount;
    }
  });
  await closeApproval(db, "leave", leaveId, decision, actor.id, reason);
  await notifyUser(
    db,
    leave.requested_by,
    decision === "approved" ? "اعتماد طلب إجازة" : "رفض طلب إجازة",
    decision === "approved"
      ? `اعتُمدت إجازة ${leave.employee_name} من ${leave.start_date} إلى ${leave.end_date}.`
      : `رُفض طلب إجازة ${leave.employee_name}. السبب: ${reason}`,
    "#/leaves",
  );
  return {
    action: decision === "approved" ? "leave.approved" : "leave.rejected",
    branchId: leave.branch_id,
    entityId: leaveId,
    requesterId: leave.requested_by,
    summary: `إجازة ${leave.employee_name}: ${leave.start_date} → ${leave.end_date}`,
    details: { employee: leave.employee_name, linkedAttendanceRows: linkedDayRows, reason: reason ?? undefined },
  };
}

export async function decideTransfer(
  db: Db,
  actor: DecisionActor,
  transferId: string,
  decision: "approved" | "rejected",
  note: string,
): Promise<DecisionOutcome> {
  const reason = requireReason(note, decision);
  const result = await db.query<
    Row & {
      id: string;
      employee_id: string;
      employee_name: string;
      from_branch_id: string;
      from_branch_name: string;
      to_branch_id: string;
      to_branch_name: string;
      effective_date: string;
      status: string;
      requested_by: string | null;
    }
  >(
    `SELECT t.id, t.employee_id, e.full_name AS employee_name, t.from_branch_id, fb.name AS from_branch_name,
            t.to_branch_id, tb.name AS to_branch_name, t.effective_date::text AS effective_date, t.status, t.requested_by
     FROM employee_transfers t
     JOIN employees e ON e.id = t.employee_id
     JOIN branches fb ON fb.id = t.from_branch_id
     JOIN branches tb ON tb.id = t.to_branch_id
     WHERE t.id = $1`,
    [transferId],
  );
  const transfer = result.rows[0];
  if (!transfer) throw notFound("طلب التحويل غير موجود.");
  if (transfer.status !== "pending") throw conflict("لا يمكن اعتماد طلب ليس قيد المراجعة.");
  await db.query(
    `UPDATE employee_transfers SET status = $2, approved_by = $3, approved_at = now(), decision_note = $4, updated_at = now() WHERE id = $1`,
    [transferId, decision, actor.id, reason],
  );
  await closeApproval(db, "transfer", transferId, decision, actor.id, reason);
  let applied = false;
  if (decision === "approved") {
    await applyDueTransfers(db);
    const appliedCheck = await db.query<Row & { applied_at: string | Date | null }>(
      "SELECT applied_at FROM employee_transfers WHERE id = $1",
      [transferId],
    );
    applied = Boolean(appliedCheck.rows[0]?.applied_at);
  }
  await notifyUser(
    db,
    transfer.requested_by,
    decision === "approved" ? "اعتماد تحويل وظيفي" : "رفض تحويل وظيفي",
    decision === "approved"
      ? `اعتُمد تحويل ${transfer.employee_name} من ${transfer.from_branch_name} إلى ${transfer.to_branch_name}${applied ? "" : ` اعتباراً من ${transfer.effective_date}`}.`
      : `رُفض تحويل ${transfer.employee_name}. السبب: ${reason}`,
    "#/transfers",
  );
  return {
    action: decision === "approved" ? "transfer.approved" : "transfer.rejected",
    branchId: transfer.from_branch_id,
    entityId: transferId,
    requesterId: transfer.requested_by,
    summary: `تحويل ${transfer.employee_name}: ${transfer.from_branch_name} → ${transfer.to_branch_name}`,
    details: { employee: transfer.employee_name, effectiveDate: transfer.effective_date, applied, reason: reason ?? undefined },
  };
}

export async function decideNewHire(
  db: Db,
  actor: DecisionActor,
  requestId: string,
  decision: "approved" | "rejected",
  note: string,
): Promise<DecisionOutcome> {
  const reason = requireReason(note, decision);
  const result = await db.query<
    Row & {
      id: string;
      full_name: string;
      phone: string;
      branch_id: string;
      branch_name: string;
      department_id: string | null;
      job_title: string;
      proposed_salary: string | number;
      start_date: string;
      notes: string;
      status: string;
      requested_by: string | null;
    }
  >(
    `SELECT n.id, n.full_name, n.phone, n.branch_id, b.name AS branch_name, n.department_id, n.job_title,
            n.proposed_salary, n.start_date::text AS start_date, n.notes, n.status, n.requested_by
     FROM new_employee_requests n JOIN branches b ON b.id = n.branch_id WHERE n.id = $1`,
    [requestId],
  );
  const request = result.rows[0];
  if (!request) throw notFound("طلب الموظف الجديد غير موجود.");
  if (request.status !== "pending") throw conflict("لا يمكن اعتماد طلب ليس قيد المراجعة.");

  let employeeId: string | null = null;
  let employeeNo = "";
  if (decision === "rejected") {
    await db.query(
      `UPDATE new_employee_requests SET status = 'rejected', approved_by = $2, approved_at = now(), decision_note = $3, updated_at = now()
       WHERE id = $1 AND status = 'pending'`,
      [requestId, actor.id, reason],
    );
  } else {
    const duplicate = await db.query<Row & { id: string; employee_no: string }>(
      "SELECT id, employee_no FROM employees WHERE phone = $1 AND lower(full_name) = lower($2) AND archived_at IS NULL LIMIT 1",
      [request.phone, request.full_name],
    );
    if (duplicate.rows[0]) {
      throw conflict(`يوجد موظف مسجل بنفس الاسم ورقم الهاتف برقم وظيفي ${duplicate.rows[0].employee_no}.`);
    }
    await db.transaction(async (tx) => {
      const locked = await tx.query<Row & { status: string; employee_id: string | null }>(
        "SELECT status, employee_id FROM new_employee_requests WHERE id = $1 FOR UPDATE",
        [requestId],
      );
      const current = locked.rows[0];
      if (!current || current.status !== "pending" || current.employee_id) {
        throw conflict("تمت معالجة الطلب مسبقاً.");
      }
      employeeNo = await nextEmployeeNo(tx);
      employeeId = newId();
      await tx.query(
        `INSERT INTO employees
          (id, employee_no, full_name, phone, branch_id, department_id, job_title, hire_date, base_salary, status, notes, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::date,$9,'active',$10,$11,$11)`,
        [
          employeeId,
          employeeNo,
          request.full_name,
          request.phone,
          request.branch_id,
          request.department_id,
          request.job_title,
          request.start_date,
          Number(request.proposed_salary),
          request.notes,
          actor.id,
        ],
      );
      await tx.query(
        `UPDATE new_employee_requests
         SET status = 'completed', employee_id = $2, approved_by = $3, approved_at = now(), decision_note = $4, updated_at = now()
         WHERE id = $1`,
        [requestId, employeeId, actor.id, reason],
      );
    });
  }
  await closeApproval(db, "new_hire", requestId, decision, actor.id, reason);
  await notifyUser(
    db,
    request.requested_by,
    decision === "approved" ? "اعتماد موظف جديد" : "رفض طلب موظف جديد",
    decision === "approved"
      ? `اعتُمد تعيين ${request.full_name} في ${request.branch_name} برقم وظيفي ${employeeNo}.`
      : `رُفض طلب تعيين ${request.full_name}. السبب: ${reason}`,
    decision === "approved" ? "#/employees" : "#/new-hires",
  );
  return {
    action: decision === "approved" ? "new_hire.approved" : "new_hire.rejected",
    branchId: request.branch_id,
    entityId: requestId,
    requesterId: request.requested_by,
    summary: `تعيين ${request.full_name} — ${request.branch_name}`,
    details: { employeeId, employeeNo, reason: reason ?? undefined },
  };
}

export async function decideAdvance(
  db: Db,
  actor: DecisionActor,
  advanceId: string,
  decision: "approved" | "rejected",
  note: string,
  permissions: { canHr: boolean; canFinance: boolean },
): Promise<DecisionOutcome> {
  const reason = requireReason(note, decision);
  const result = await db.query<
    Row & {
      id: string;
      employee_name: string;
      branch_id: string;
      branch_name: string;
      amount: string | number;
      status: string;
      requested_by: string | null;
      title: string;
    }
  >(
    `SELECT a.id, e.full_name AS employee_name, a.branch_id, b.name AS branch_name, a.amount, a.status, a.requested_by,
            COALESCE(ar.title, '') AS title
     FROM advance_requests a
     JOIN employees e ON e.id = a.employee_id
     JOIN branches b ON b.id = a.branch_id
     LEFT JOIN approval_requests ar ON ar.entity_type = 'advance' AND ar.entity_id = a.id
     WHERE a.id = $1`,
    [advanceId],
  );
  const advance = result.rows[0];
  if (!advance) throw notFound("طلب السلفة غير موجود.");
  if (advance.status !== "pending_hr" && advance.status !== "pending_finance") {
    throw conflict("لا يمكن اعتماد طلب في هذه الحالة.");
  }
  if (advance.status === "pending_hr" && !permissions.canHr) throw forbidden("اعتماد الموارد البشرية مطلوب في هذه المرحلة.");
  if (advance.status === "pending_finance" && !permissions.canFinance) throw forbidden("اعتماد المالية مطلوب في هذه المرحلة.");

  if (decision === "rejected") {
    await db.query(
      `UPDATE advance_requests SET status = 'rejected', decision_note = $2, updated_at = now() WHERE id = $1`,
      [advanceId, reason],
    );
    await closeApproval(db, "advance", advanceId, "rejected", actor.id, reason);
    await notifyUser(
      db,
      advance.requested_by,
      "رفض طلب سلفة",
      `رُفضت سلفة ${advance.employee_name}. السبب: ${reason}`,
      "#/advances",
    );
    return {
      action: "advance.rejected",
      branchId: advance.branch_id,
      entityId: advanceId,
      requesterId: advance.requested_by,
      summary: `سلفة ${advance.employee_name}`,
      details: { stage: advance.status, reason },
    };
  }

  if (advance.status === "pending_hr") {
    await db.query(
      `UPDATE advance_requests SET status = 'pending_finance', hr_approved_by = $2, hr_approved_at = now(), decision_note = COALESCE($3, decision_note), updated_at = now()
       WHERE id = $1`,
      [advanceId, actor.id, reason],
    );
    await openApproval(db, {
      entityType: "advance",
      entityId: advanceId,
      branchId: advance.branch_id,
      title: `سلفة مالية — ${advance.employee_name} — اعتماد مالي`,
      summary: `المبلغ: ${Number(advance.amount)} — اعتماد الموارد البشرية مكتمل`,
      requestedBy: advance.requested_by,
    });
    await notifyPermissionHolders(
      db,
      "advances.approve_finance",
      advance.branch_id,
      "سلفة بانتظار اعتماد المالية",
      `اعتمدت الموارد البشرية سلفة ${advance.employee_name} بمبلغ ${Number(advance.amount)}.`,
      "#/approvals",
    );
    return {
      action: "advance.hr_approved",
      branchId: advance.branch_id,
      entityId: advanceId,
      requesterId: advance.requested_by,
      summary: `سلفة ${advance.employee_name}`,
      details: { stage: "hr", note: reason ?? undefined },
    };
  }

  await db.query(
    `UPDATE advance_requests SET status = 'approved', finance_approved_by = $2, finance_approved_at = now(), decision_note = COALESCE($3, decision_note), updated_at = now()
     WHERE id = $1`,
    [advanceId, actor.id, reason],
  );
  await closeApproval(db, "advance", advanceId, "approved", actor.id, reason);
  await notifyUser(
    db,
    advance.requested_by,
    "اعتماد سلفة مالية",
    `اعتُمدت سلفة ${advance.employee_name} بمبلغ ${Number(advance.amount)}.`,
    "#/advances",
  );
  return {
    action: "advance.approved",
    branchId: advance.branch_id,
    entityId: advanceId,
    requesterId: advance.requested_by,
    summary: `سلفة ${advance.employee_name}`,
    details: { stage: "finance", note: reason ?? undefined },
  };
}
