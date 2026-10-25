-- BATAWIL HRMS - Phase 1 roles and permissions
-- Permissions cover only modules delivered in Phase 1.

INSERT INTO permissions (key, name_ar, sort_order) VALUES
  ('users.view', 'عرض المستخدمين', 10),
  ('users.manage', 'إدارة المستخدمين', 20),
  ('branches.view', 'عرض الفروع', 30),
  ('branches.manage', 'إدارة الفروع', 40),
  ('roles.view', 'عرض الأدوار والصلاحيات', 50),
  ('audit.view', 'عرض سجل التدقيق', 60)
ON CONFLICT (key) DO UPDATE SET name_ar = EXCLUDED.name_ar, sort_order = EXCLUDED.sort_order;

INSERT INTO roles (id, key, name_ar, description_ar, all_permissions, sort_order) VALUES
  ('00000000-0000-4000-8000-000000000001', 'admin', 'مدير النظام', 'صلاحيات كاملة على النظام وإدارة الحسابات والفروع والتدقيق.', true, 10),
  ('00000000-0000-4000-8000-000000000002', 'hr_director', 'مدير الموارد البشرية', 'إدارة مستخدمي النظام والفروع ومراجعة سجل التدقيق.', false, 20),
  ('00000000-0000-4000-8000-000000000003', 'hr_officer', 'موظف شؤون الموظفين', 'إدارة حسابات المستخدمين ضمن نطاق الفروع المسموح.', false, 30),
  ('00000000-0000-4000-8000-000000000004', 'executive', 'المدير التنفيذي', 'اطلاع على المستخدمين والفروع وسجل التدقيق.', false, 40),
  ('00000000-0000-4000-8000-000000000005', 'branch_manager', 'مدير الفرع', 'اطلاع على مستخدمي الفرع ضمن نطاق الصلاحية.', false, 50),
  ('00000000-0000-4000-8000-000000000006', 'direct_manager', 'المدير المباشر', 'اطلاع على مستخدمي الفرع ضمن نطاق الصلاحية.', false, 60),
  ('00000000-0000-4000-8000-000000000007', 'finance', 'مسؤول الإدارة المالية', 'حساب مخصص للمرحلة الأولى دون صلاحيات إدارية إضافية.', false, 70),
  ('00000000-0000-4000-8000-000000000008', 'employee', 'الموظف', 'حساب أساسي للاطلاع على الحساب الشخصي فقط.', false, 80)
ON CONFLICT (key) DO UPDATE SET
  name_ar = EXCLUDED.name_ar,
  description_ar = EXCLUDED.description_ar,
  all_permissions = EXCLUDED.all_permissions,
  sort_order = EXCLUDED.sort_order;

INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, p.key
FROM roles r
JOIN permissions p ON p.key IN ('users.view', 'users.manage', 'branches.view', 'branches.manage', 'roles.view', 'audit.view')
WHERE r.key = 'hr_director'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, p.key
FROM roles r
JOIN permissions p ON p.key IN ('users.view', 'users.manage', 'branches.view', 'roles.view')
WHERE r.key = 'hr_officer'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, p.key
FROM roles r
JOIN permissions p ON p.key IN ('users.view', 'branches.view', 'roles.view', 'audit.view')
WHERE r.key = 'executive'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, p.key
FROM roles r
JOIN permissions p ON p.key IN ('users.view', 'branches.view')
WHERE r.key IN ('branch_manager', 'direct_manager')
ON CONFLICT DO NOTHING;
