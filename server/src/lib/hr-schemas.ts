import { z } from "zod";

export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "التاريخ يجب أن يكون بصيغة YYYY-MM-DD.");

export const timeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "الوقت يجب أن يكون بصيغة HH:MM.");

export const optionalTimeSchema = z.union([z.literal(""), timeSchema]).transform((value) => value || null);

export const attendanceStatusSchema = z.enum([
  "present",
  "absent",
  "leave",
  "permission",
  "mission",
  "weekly_rest",
  "late",
  "excused_absence",
]);

export const employeeStatusSchema = z.enum(["active", "leave", "suspended", "resigned", "transferred"]);

export const phoneSchema = z.string().trim().min(6, "رقم الهاتف مطلوب.").max(30, "رقم الهاتف طويل جداً.");
export const nationalIdSchema = z
  .union([z.literal(""), z.string().trim().max(30, "الرقم الوطني طويل جداً.")])
  .transform((value) => value || null)
  .nullable()
  .optional();
export const employeeNoSchema = z
  .union([z.literal(""), z.string().trim().max(30, "الرقم الوظيفي طويل جداً.")])
  .transform((value) => value || null)
  .nullable()
  .optional();
export const moneySchema = z.coerce.number().min(0, "المبلغ يجب ألا يكون سالباً.").max(999_999_999);

const personName = z.string().trim().min(2, "الاسم مطلوب.").max(120, "الاسم طويل جداً.");
const notesSchema = z.string().trim().max(2000, "الملاحظات طويلة جداً.").default("");
const optionalId = z.union([z.uuid("المعرّف غير صالح."), z.literal("")]).transform((value) => value || null).optional();

export const createEmployeeSchema = z.object({
  employeeNo: employeeNoSchema,
  fullName: personName,
  phone: phoneSchema,
  nationalId: nationalIdSchema,
  branchId: z.uuid("يجب اختيار فرع صالح."),
  departmentId: z.union([z.uuid("معرّف قسم غير صالح."), z.literal("")]).transform((value) => value || null).optional(),
  jobTitle: z.string().trim().max(120).default(""),
  jobTitleId: optionalId,
  managerId: optionalId,
  hireDate: isoDateSchema,
  baseSalary: moneySchema.default(0),
  status: employeeStatusSchema.default("active"),
  notes: notesSchema,
});

export const updateEmployeeSchema = z.object({
  employeeNo: employeeNoSchema,
  fullName: personName.optional(),
  phone: phoneSchema.optional(),
  nationalId: nationalIdSchema,
  branchId: z.uuid("يجب اختيار فرع صالح.").optional(),
  departmentId: z.union([z.uuid("معرّف قسم غير صالح."), z.literal("")]).transform((value) => value || null).optional(),
  jobTitle: z.string().trim().max(120).optional(),
  jobTitleId: optionalId,
  managerId: optionalId,
  hireDate: isoDateSchema.optional(),
  baseSalary: moneySchema.optional(),
  status: employeeStatusSchema.optional(),
  notes: z.string().trim().max(2000).optional(),
  terminationDate: z.union([z.literal(""), isoDateSchema]).transform((value) => value || null).optional(),
  terminationReason: z.string().trim().max(500).optional(),
});

export const jobTitleSchema = z.object({
  name: z.string().trim().min(2, "اسم المسمى الوظيفي مطلوب.").max(120),
  departmentId: optionalId,
  active: z.boolean().default(true),
});

export const jobTitleUpdateSchema = z.object({
  name: z.string().trim().min(2, "اسم المسمى الوظيفي مطلوب.").max(120).optional(),
  departmentId: optionalId,
  active: z.boolean().optional(),
});

const contractTypeSchema = z.enum(["permanent", "fixed", "probation", "part_time"]);
const contractStatusSchema = z.enum(["active", "ended", "terminated"]);

export const contractSchema = z
  .object({
    contractNo: z.string().trim().max(60, "رقم العقد طويل جداً.").default(""),
    contractType: contractTypeSchema.default("permanent"),
    startDate: isoDateSchema,
    endDate: z.union([z.literal(""), isoDateSchema]).transform((value) => value || null).default(null),
    baseSalary: moneySchema.default(0),
    status: contractStatusSchema.default("active"),
    notes: notesSchema,
  })
  .refine((data) => !data.endDate || data.endDate >= data.startDate, {
    message: "تاريخ نهاية العقد يجب ألا يسبق بدايته.",
    path: ["endDate"],
  });

export const contractUpdateSchema = z.object({
  contractNo: z.string().trim().max(60, "رقم العقد طويل جداً.").optional(),
  contractType: contractTypeSchema.optional(),
  startDate: isoDateSchema.optional(),
  endDate: z.union([z.literal(""), isoDateSchema]).transform((value) => value || null).optional(),
  baseSalary: moneySchema.optional(),
  status: contractStatusSchema.optional(),
  notes: z.string().trim().max(2000).optional(),
});

export const archiveEmployeeSchema = z.object({
  reason: z.string().trim().min(3, "سبب الأرشفة مطلوب.").max(500),
  terminationDate: z.union([z.literal(""), isoDateSchema]).optional(),
});

export const employeeImportRowSchema = z.object({
  employeeNo: employeeNoSchema,
  fullName: personName,
  phone: phoneSchema,
  nationalId: nationalIdSchema,
  branchCode: z.string().trim().min(1, "كود الفرع مطلوب."),
  departmentName: z.string().trim().max(120).default(""),
  jobTitle: z.string().trim().max(120).default(""),
  hireDate: isoDateSchema,
  baseSalary: moneySchema.default(0),
  status: employeeStatusSchema.default("active"),
  notes: notesSchema,
});

export const dailyRowSchema = z
  .object({
    employeeId: z.union([z.uuid(), z.literal("")]).optional(),
    manualName: z.string().trim().max(120).optional(),
    status: attendanceStatusSchema.default("present"),
    checkIn: optionalTimeSchema.optional(),
    checkOut: optionalTimeSchema.optional(),
    lateMinutes: z.coerce.number().int().min(0).max(1440).default(0),
    workHours: z.coerce.number().min(0).max(24).default(0),
    reason: z.string().trim().max(300).default(""),
    notes: z.string().trim().max(500).default(""),
  })
  .refine((row) => Boolean(row.employeeId) !== Boolean(row.manualName?.trim()), {
    message: "كل صف يجب أن يرتبط بموظف مسجل أو باسم مؤقت واحد فقط.",
    path: ["employeeId"],
  });

export const saveDailySchema = z.object({
  rows: z.array(dailyRowSchema).max(500, "عدد الصفوف يتجاوز الحد المسموح."),
  notes: z.string().trim().max(1000).default(""),
});

export const submitReasonSchema = z.object({
  note: z.string().trim().max(1000).default(""),
});

export const rejectSchema = z.object({
  reason: z.string().trim().min(3, "سبب الإرجاع أو الرفض مطلوب.").max(1000),
});

export const monthlySaveSchema = z.object({
  notes: z.string().trim().max(1000).default(""),
  overrides: z
    .array(
      z.object({
        employeeId: z.uuid("معرّف موظف غير صالح."),
        day: z.coerce.number().int().min(1).max(31),
        status: attendanceStatusSchema,
        note: z.string().trim().max(300).default(""),
      }),
    )
    .max(5000)
    .default([]),
});

export const monthlySubmitSchema = z.object({
  missingDaysConfirmed: z.boolean().default(false),
  note: z.string().trim().max(1000).default(""),
});

export const leaveSchema = z
  .object({
    employeeId: z.uuid("يجب اختيار موظف صالح."),
    leaveType: z.enum(["annual", "sick", "unpaid", "emergency", "permission", "other"]),
    startDate: isoDateSchema,
    endDate: isoDateSchema,
    reason: z.string().trim().max(1000).default(""),
    notes: notesSchema,
  })
  .refine((data) => data.endDate >= data.startDate, { message: "تاريخ النهاية يجب ألا يسبق البداية.", path: ["endDate"] });

export const leaveDecisionSchema = z.object({
  reason: z.string().trim().max(1000).default(""),
});

export const transferSchema = z.object({
  employeeId: z.uuid("يجب اختيار موظف صالح."),
  toBranchId: z.uuid("يجب اختيار الفرع الجديد."),
  toDepartmentId: z.union([z.uuid(), z.literal("")]).transform((value) => value || null).optional(),
  effectiveDate: isoDateSchema,
  reason: z.string().trim().min(3, "سبب التحويل مطلوب.").max(1000),
  notes: notesSchema,
});

export const newHireSchema = z.object({
  fullName: personName,
  phone: phoneSchema,
  branchId: z.uuid("يجب اختيار فرع صالح."),
  departmentId: z.union([z.uuid(), z.literal("")]).transform((value) => value || null).optional(),
  jobTitle: z.string().trim().max(120).default(""),
  proposedSalary: moneySchema.default(0),
  startDate: isoDateSchema,
  notes: notesSchema,
});

export const advanceSchema = z.object({
  employeeId: z.uuid("يجب اختيار موظف صالح."),
  amount: z.coerce.number().positive("مبلغ السلفة يجب أن يكون أكبر من صفر.").max(99_999_999),
  reason: z.string().trim().min(3, "سبب السلفة مطلوب.").max(1000),
  requestDate: isoDateSchema,
  installments: z.coerce.number().int().min(1).max(60).default(1),
  deductionMethod: z.enum(["installments", "one_time"]).default("installments"),
  notes: notesSchema,
});

export const advanceDeductionSchema = z.object({
  amount: z.coerce.number().positive("مبلغ الاستقطاع يجب أن يكون أكبر من صفر.").max(99_999_999),
  transactionDate: isoDateSchema,
  notes: notesSchema,
});

export const payrollUpdateSchema = z.object({
  allowances: moneySchema.optional(),
  deductions: moneySchema.optional(),
  advanceDeduction: moneySchema.optional(),
  notes: z.string().trim().max(2000).optional(),
  reviewStatus: z.enum(["draft", "reviewed", "approved"]).optional(),
});

export const payrollGenerateSchema = z.object({
  branchId: z.union([z.uuid(), z.literal("")]).transform((value) => value || null).optional(),
  year: z.coerce.number().int().min(2000).max(2100),
  month: z.coerce.number().int().min(1).max(12),
});

export const departmentSchema = z.object({
  name: z.string().trim().min(2, "اسم القسم مطلوب.").max(120),
  active: z.boolean().default(true),
});

export const settingsSchema = z.object({
  company: z
    .object({
      name: z.string().trim().min(1).max(160),
      currency: z.string().trim().min(1).max(10),
      printFooter: z.string().trim().max(300).default(""),
    })
    .optional(),
  attendance: z
    .object({
      workStart: timeSchema,
      workEnd: timeSchema,
      lateGraceMinutes: z.coerce.number().int().min(0).max(240),
      weekendDays: z.array(z.coerce.number().int().min(0).max(6)).max(7),
    })
    .optional(),
});

export type DailyRowInput = z.infer<typeof dailyRowSchema>;
export type AttendanceStatus = z.infer<typeof attendanceStatusSchema>;
export type EmployeeStatus = z.infer<typeof employeeStatusSchema>;
