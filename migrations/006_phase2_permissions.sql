-- BATAWIL HRMS - Phase 2 permissions and role grants

INSERT INTO permissions (key, name_ar, sort_order) VALUES
  ('employees.view', 'عرض الموظفين', 100),
  ('employees.manage', 'إدارة الموظفين', 110),
  ('employees.import', 'استيراد الموظفين', 120),
  ('employees.export', 'تصدير الموظفين', 130),
  ('attendance.view', 'عرض الحضور والغياب', 200),
  ('attendance.manage', 'إدخال وتعديل التحضير', 210),
  ('attendance.submit', 'إرسال التحضير للاعتماد', 220),
  ('attendance.approve', 'اعتماد التحضير', 230),
  ('attendance.correct', 'تصحيح الحضور المعتمد', 240),
  ('leaves.view', 'عرض الإجازات والأذونات', 300),
  ('leaves.manage', 'إدارة طلبات الإجازات', 310),
  ('leaves.approve', 'اعتماد الإجازات', 320),
  ('transfers.view', 'عرض التحويلات الوظيفية', 400),
  ('transfers.manage', 'إدارة التحويلات', 410),
  ('transfers.approve', 'اعتماد التحويلات', 420),
  ('new_hires.view', 'عرض طلبات الموظفين الجدد', 500),
  ('new_hires.manage', 'إدارة طلبات الموظفين الجدد', 510),
  ('new_hires.approve', 'اعتماد الموظفين الجدد', 520),
  ('advances.view', 'عرض السلف المالية', 600),
  ('advances.manage', 'إدارة طلبات السلف', 610),
  ('advances.approve_hr', 'اعتماد السلف من الموارد البشرية', 620),
  ('advances.approve_finance', 'اعتماد السلف من المالية', 630),
  ('advances.disburse', 'صرف السلف وتسجيل الاستقطاعات', 640),
  ('payroll.view', 'عرض الرواتب وبيانات الاستحقاق', 700),
  ('payroll.manage', 'إدارة ومراجعة بيانات الاستحقاق', 710),
  ('reports.view', 'عرض التقارير', 800),
  ('reports.export', 'تصدير التقارير', 810),
  ('approvals.view', 'صندوق الاعتمادات', 900),
  ('settings.view', 'عرض إعدادات النظام', 950),
  ('settings.manage', 'إدارة إعدادات النظام', 960)
ON CONFLICT (key) DO UPDATE SET name_ar = EXCLUDED.name_ar, sort_order = EXCLUDED.sort_order;

-- HR director: full HR operations, no finance-only actions unless also granted separately.
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, p.key FROM roles r JOIN permissions p ON p.key IN (
  'employees.view', 'employees.manage', 'employees.import', 'employees.export',
  'attendance.view', 'attendance.manage', 'attendance.submit', 'attendance.approve', 'attendance.correct',
  'leaves.view', 'leaves.manage', 'leaves.approve',
  'transfers.view', 'transfers.manage', 'transfers.approve',
  'new_hires.view', 'new_hires.manage', 'new_hires.approve',
  'advances.view', 'advances.manage', 'advances.approve_hr',
  'payroll.view', 'payroll.manage',
  'reports.view', 'reports.export', 'approvals.view', 'settings.view', 'settings.manage'
) WHERE r.key = 'hr_director'
ON CONFLICT DO NOTHING;

-- HR officer: data entry and preparation within scope, no final approvals.
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, p.key FROM roles r JOIN permissions p ON p.key IN (
  'employees.view', 'employees.manage', 'employees.import', 'employees.export',
  'attendance.view', 'attendance.manage', 'attendance.submit',
  'leaves.view', 'leaves.manage',
  'transfers.view', 'transfers.manage',
  'new_hires.view', 'new_hires.manage',
  'advances.view', 'advances.manage',
  'payroll.view', 'payroll.manage',
  'reports.view', 'reports.export', 'approvals.view', 'settings.view'
) WHERE r.key = 'hr_officer'
ON CONFLICT DO NOTHING;

-- Executive: read-only oversight.
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, p.key FROM roles r JOIN permissions p ON p.key IN (
  'employees.view', 'attendance.view', 'leaves.view', 'transfers.view', 'new_hires.view',
  'advances.view', 'payroll.view', 'reports.view', 'reports.export', 'approvals.view', 'settings.view'
) WHERE r.key = 'executive'
ON CONFLICT DO NOTHING;

-- Branch manager: own-branch operations plus submitting requests and following their status.
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, p.key FROM roles r JOIN permissions p ON p.key IN (
  'employees.view', 'attendance.view', 'attendance.manage', 'attendance.submit',
  'leaves.view', 'leaves.manage', 'transfers.view', 'transfers.manage',
  'new_hires.view', 'new_hires.manage', 'advances.view', 'advances.manage',
  'reports.view', 'reports.export', 'approvals.view'
) WHERE r.key = 'branch_manager'
ON CONFLICT DO NOTHING;

-- Direct manager: same preparation scope, no branch administration.
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, p.key FROM roles r JOIN permissions p ON p.key IN (
  'employees.view', 'attendance.view', 'attendance.manage', 'attendance.submit',
  'leaves.view', 'leaves.manage', 'transfers.view', 'transfers.manage',
  'new_hires.view', 'new_hires.manage', 'advances.view', 'advances.manage',
  'reports.view', 'approvals.view'
) WHERE r.key = 'direct_manager'
ON CONFLICT DO NOTHING;

-- Finance: advances and payroll only (plus read access to employees needed for selection).
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, p.key FROM roles r JOIN permissions p ON p.key IN (
  'employees.view', 'advances.view', 'advances.manage', 'advances.approve_finance', 'advances.disburse',
  'payroll.view', 'payroll.manage', 'reports.view', 'reports.export', 'approvals.view'
) WHERE r.key = 'finance'
ON CONFLICT DO NOTHING;

-- Employee account: no HR module permissions; personal account only.
