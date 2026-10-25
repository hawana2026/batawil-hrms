import {
  alertBox,
  api,
  avatar,
  confirmDialog,
  copyText,
  el,
  errorBlock,
  formatDateTime,
  formatNumber,
  formatRelative,
  icon,
  loadingBlock,
  openModal,
  pageHeader,
  setButtonLoading,
  statusBadge,
  toast,
} from "../core.js";
import { can, refreshMeta, state } from "../state.js";
import {
  actionButton,
  branchScopeTags,
  friendlyError,
  pageEnter,
  tablePagination,
  userStatus,
} from "../ui.js";

function optionsMarkup(items, selectedValue, placeholder) {
  const options = [];
  if (placeholder) options.push(el("option", { value: "" }, placeholder));
  for (const item of items) {
    options.push(
      el("option", { value: item.value, selected: item.value === selectedValue }, item.label),
    );
  }
  return options;
}

function filterForm(onApply) {
  const filters = state.users.filters;
  const branches = state.meta?.branches ?? state.user.branches ?? [];
  const roles = state.meta?.roles ?? [];

  const search = el("input", {
    class: "input",
    type: "search",
    name: "q",
    value: filters.q,
    placeholder: "الاسم، اسم المستخدم، البريد…",
    "aria-label": "بحث في المستخدمين",
  });
  const branch = el(
    "select",
    { class: "select", name: "branchId", "aria-label": "الفرع" },
    ...optionsMarkup(
      branches.map((item) => ({ value: item.id, label: `${item.name}${item.active ? "" : " (معطل)"}` })),
      filters.branchId,
      "كل الفروع",
    ),
  );
  const role = el(
    "select",
    { class: "select", name: "roleKey", "aria-label": "الدور" },
    ...optionsMarkup(
      roles.map((item) => ({ value: item.key, label: item.nameAr })),
      filters.roleKey,
      "كل الأدوار",
    ),
  );
  const status = el(
    "select",
    { class: "select", name: "status", "aria-label": "حالة الحساب" },
    ...optionsMarkup(
      [
        { value: "active", label: "نشط" },
        { value: "inactive", label: "معطل" },
        { value: "locked", label: "مقفل مؤقتاً" },
      ],
      filters.status === "all" ? "" : filters.status,
      "كل الحالات",
    ),
  );

  const form = el(
    "form",
    {
      class: "card filter-bar",
      onsubmit: async (event) => {
        event.preventDefault();
        state.users.filters = {
          q: search.value.trim(),
          branchId: branch.value,
          roleKey: role.value,
          status: status.value || "all",
        };
        state.users.page = 1;
        await onApply();
      },
    },
    el("div", { class: "form-field" }, el("label", { class: "form-label", text: "بحث" }), search),
    el("div", { class: "form-field" }, el("label", { class: "form-label", text: "الفرع" }), branch),
    el("div", { class: "form-field" }, el("label", { class: "form-label", text: "الدور" }), role),
    el("div", { class: "form-field" }, el("label", { class: "form-label", text: "الحالة" }), status),
    el(
      "div",
      { class: "filter-actions" },
      el("button", { class: "btn btn-primary", type: "submit" }, icon("search"), "بحث"),
      el(
        "button",
        {
          class: "btn btn-ghost",
          type: "button",
          onclick: async () => {
            search.value = "";
            branch.value = "";
            role.value = "";
            status.value = "";
            state.users.filters = { q: "", branchId: "", roleKey: "", status: "all" };
            state.users.page = 1;
            await onApply();
          },
        },
        "مسح",
      ),
    ),
  );
  return form;
}

function userRow(row, reload) {
  const status = userStatus(row);
  const cells = [
    el(
      "td",
      {},
      el(
        "div",
        { class: "cell-person" },
        avatar(row.fullName),
        el(
          "div",
          {},
          el("strong", {}, row.fullName, row.isSelf ? el("span", { class: "row-self-tag", text: "أنت" }) : null),
          el("span", { text: row.username }),
        ),
      ),
    ),
    el(
      "td",
      {},
      el(
        "div",
        { class: "cell-role" },
        el("strong", { text: row.role.nameAr }),
        row.role.allPermissions ? el("span", { class: "tag purple", text: "صلاحيات كاملة" }) : null,
      ),
    ),
    el("td", {}, el("div", { class: "tag-row", style: "margin-top:0" }, branchScopeTags(row, 2))),
    el("td", {}, statusBadge(status.label, status.tone, status.iconName)),
    el(
      "td",
      { class: "nowrap" },
      el("span", { class: "tiny muted", title: formatDateTime(row.lastLoginAt), text: formatRelative(row.lastLoginAt) }),
    ),
  ];

  if (can("users.manage")) {
    let actions;
    if (row.manageable) {
      actions = [
        actionButton("pencil", "تعديل بيانات المستخدم", () => openUserForm(row, reload)),
        actionButton("key", "إعادة تعيين كلمة المرور", () => resetPassword(row, reload)),
        actionButton("refresh", "إنهاء جميع جلسات المستخدم", () => revokeSessions(row, reload)),
      ];
    } else if (row.isSelf) {
      actions = [el("span", { class: "tag", text: "حسابك" })];
    } else {
      actions = [
        el(
          "span",
          { class: "tag", title: "هذا المستخدم خارج نطاق الإدارة الكامل لصلاحياتك" },
          icon("lock"),
          "خارج النطاق",
        ),
      ];
    }
    cells.push(el("td", {}, el("div", { class: "cell-actions" }, actions)));
  }

  return el("tr", {}, cells);
}

function buildTable(listHost, token, reload) {
  const { items, page, pageSize, total } = state.users;
  const card = el("div", { class: "card table-card" });
  if (items.length === 0) {
    card.append(
      el(
        "div",
        { class: "empty-state" },
        el("span", { class: "empty-icon" }, icon("users")),
        el("h3", { class: "empty-title", text: "لا توجد نتائج مطابقة" }),
        el("p", { class: "empty-text", text: "جرّب تغيير كلمة البحث أو مرشحات الفرع والدور والحالة." }),
        can("users.manage")
          ? el("button", { class: "btn btn-primary", type: "button", onclick: () => openUserForm(null, reload) }, icon("user-plus"), "إضافة مستخدم")
          : null,
      ),
    );
    return card;
  }

  const headers = ["المستخدم", "الدور", "نطاق الفروع", "الحالة", "آخر دخول"];
  if (can("users.manage")) headers.push("إجراءات");

  const table = el(
    "table",
    {},
    el("thead", {}, el("tr", {}, headers.map((label) => el("th", { text: label })))),
    el("tbody", {}, items.map((row) => userRow(row, reload))),
  );
  card.append(
    el("div", { class: "table-wrap" }, table),
    tablePagination({
      page,
      pageSize,
      total,
      onPage: (nextPage) => {
        if (nextPage < 1) return;
        state.users.page = nextPage;
        loadUserList(listHost, token, reload);
      },
    }),
  );
  card.append(
    el(
      "div",
      { class: "card-footer" },
      el("span", { text: `إجمالي الحسابات في نطاقك: ${formatNumber(total)}` }),
      el("span", { class: "tag", text: "تُعرض البيانات وفق صلاحياتك" }),
    ),
  );
  return card;
}

async function loadUserList(listHost, token, reload = () => loadUserList(listHost, token)) {
  listHost.replaceChildren(loadingBlock("جارٍ تحميل المستخدمين…"));
  const params = new URLSearchParams();
  const filters = state.users.filters;
  if (filters.q) params.set("q", filters.q);
  if (filters.branchId) params.set("branchId", filters.branchId);
  if (filters.roleKey) params.set("roleKey", filters.roleKey);
  if (filters.status !== "all") params.set("status", filters.status);
  params.set("page", String(state.users.page));
  params.set("pageSize", String(state.users.pageSize));

  try {
    const data = await api(`/api/users?${params.toString()}`);
    if (token !== state.renderToken) return;
    state.users.items = data.items;
    state.users.total = data.total;
    state.users.page = data.page;
    state.users.pageSize = data.pageSize;
    listHost.replaceChildren(buildTable(listHost, token, reload));
  } catch (error) {
    if (token !== state.renderToken) return;
    listHost.replaceChildren(errorBlock(friendlyError(error), () => loadUserList(listHost, token)));
  }
}

function showTemporaryPassword({ username, password, isReset }) {
  const secretCode = el("code", { text: password });
  let controller;
  const copyButton = el(
    "button",
    { class: "btn btn-secondary btn-sm", type: "button" },
    icon("copy"),
    "نسخ",
  );
  copyButton.addEventListener("click", async () => {
    const ok = await copyText(password);
    if (ok) toast("تم نسخ كلمة المرور المؤقتة.", "success");
    else toast("تعذر النسخ تلقائياً. انسخ الكلمة يدوياً.", "warning");
  });
  const body = el(
    "div",
    {},
    el("p", { class: "confirm-text", text: `تم ${isReset ? "إعادة تعيين" : "إنشاء"} الحساب: ${username}` }),
    el("div", { class: "temp-secret" }, secretCode, copyButton),
    el(
      "div",
      { class: "secret-note" },
      icon("alert-triangle"),
      el("span", {
        text: "ستظهر كلمة المرور هذه مرة واحدة فقط. سلّمها للمستخدم عبر قناة آمنة، وسيُطلب منه تغييرها عند أول دخول. لا تحتفظ بها في ملف أو محادثة.",
      }),
    ),
  );
  controller = openModal({
    title: isReset ? "كلمة مرور مؤقتة جديدة" : "تم إنشاء المستخدم",
    description: "بيانات الدخول المؤقتة للحساب",
    size: "sm",
    body,
    footer: [
      el(
        "button",
        {
          class: "btn btn-primary",
          type: "button",
          onclick: () => controller.close(),
        },
        "تم، فهمت",
      ),
    ],
  });
}

async function resetPassword(row, reload) {
  const confirmed = await confirmDialog({
    title: "إعادة تعيين كلمة المرور",
    message: `سيتم إنشاء كلمة مرور مؤقتة جديدة للمستخدم "${row.fullName}" وإنهاء جميع جلساته الحالية. سيُطلب منه تغييرها عند أول دخول.`,
    confirmLabel: "إعادة التعيين",
    danger: true,
  });
  if (!confirmed) return;
  try {
    const data = await api(`/api/users/${row.id}/reset-password`, { method: "POST" });
    showTemporaryPassword({ username: row.username, password: data.temporaryPassword, isReset: true });
    await reload();
  } catch (error) {
    toast(friendlyError(error), "error");
  }
}

async function revokeSessions(row, reload) {
  const confirmed = await confirmDialog({
    title: "إنهاء جميع جلسات المستخدم",
    message: `سيتم إخراج "${row.fullName}" من جميع الأجهزة فوراً. يمكنه تسجيل الدخول مجدداً بكلمة المرور الحالية.`,
    confirmLabel: "إنهاء الجلسات",
    danger: true,
  });
  if (!confirmed) return;
  try {
    await api(`/api/users/${row.id}/revoke-sessions`, { method: "POST" });
    toast("تم إنهاء جميع جلسات المستخدم.", "success");
    await reload();
  } catch (error) {
    toast(friendlyError(error), "error");
  }
}

function scrollableError(message) {
  return el("div", { class: "mb-16" }, alertBox(message, "error"));
}

async function openUserForm(row, reload) {
  if (!state.meta?.roles?.length) {
    try {
      await refreshMeta();
    } catch (error) {
      toast(friendlyError(error), "error");
      return;
    }
  }
  const isEdit = Boolean(row);
  const roles = state.meta?.roles ?? [];
  const branches = state.meta?.branches ?? state.user.branches ?? [];
  const currentRolePresent = row ? roles.some((role) => role.key === row.role.key) : true;
  if (row && !currentRolePresent) {
    roles.unshift({ ...row.role, descriptionAr: "الدور الحالي للمستخدم", permissionKeys: [] });
  }
  if (roles.length === 0) {
    toast("لا توجد أدوار متاحة لإنشاء حساب.", "error");
    return;
  }

  const usernameInput = el("input", {
    class: "input",
    id: "user-username",
    name: "username",
    value: row?.username ?? "",
    placeholder: "مثال: ahmed.ali",
    autocomplete: "off",
    dir: "ltr",
    required: true,
    pattern: "[a-z0-9][a-z0-9._-]{2,31}",
    disabled: isEdit,
    readonly: isEdit,
  });
  const fullNameInput = el("input", {
    class: "input",
    id: "user-fullname",
    name: "fullName",
    value: row?.fullName ?? "",
    placeholder: "الاسم الكامل",
    autocomplete: "off",
    required: true,
    maxlength: 100,
  });
  const emailInput = el("input", {
    class: "input",
    id: "user-email",
    name: "email",
    type: "email",
    value: row?.email ?? "",
    placeholder: "اختياري",
    autocomplete: "off",
    dir: "ltr",
    maxlength: 254,
  });
  const defaultRoleKey = row
    ? row.role.key
    : roles.some((role) => role.key === "employee")
      ? "employee"
      : roles[0]?.key ?? "";
  const roleSelect = el(
    "select",
    { class: "select", id: "user-role", name: "roleKey", required: true },
    ...roles.map((role) => el("option", { value: role.key, selected: role.key === defaultRoleKey }, role.nameAr)),
  );

  const roleNote = el("div");
  const refreshRoleNote = () => {
    const selected = roles.find((role) => role.key === roleSelect.value);
    roleNote.replaceChildren();
    if (selected?.allPermissions) {
      roleNote.append(
        el("div", { class: "form-note" }, icon("shield-check"), el("span", { text: "هذا الدور يمنح كل صلاحيات النظام. امنحه فقط لمن يحتاج إدارة كاملة." })),
      );
    }
  };
  roleSelect.addEventListener("change", refreshRoleNote);

  const activeToggle = row
    ? el(
        "label",
        { class: "checkbox-row" },
        el("input", { type: "checkbox", id: "user-active", checked: row.active }),
        el("span", {}, el("strong", { text: "الحساب نشط" }), el("br"), el("span", { class: "tiny muted", text: "تعطيل الحساب ينهي جميع جلساته الحالية." })),
      )
    : null;

  const allBranchesToggle = state.user.allBranches
    ? el("input", { type: "checkbox", id: "user-all-branches", checked: row?.allBranches ?? false })
    : null;
  const branchInputs = [];
  const branchGrid = el(
    "div",
    { class: "branch-select" },
    branches.length === 0
      ? el("span", { class: "form-hint", text: "لا توجد فروع ضمن نطاقك. أنشئ فرعاً أولاً." })
      : branches.map((branch) => {
          const isAssigned = row?.branches?.some((item) => item.id === branch.id) ?? false;
          const checkbox = el("input", {
            type: "checkbox",
            value: branch.id,
            checked: isAssigned || (!row && branch.active && branches.filter((item) => item.active).length === 1),
            disabled: !branch.active,
          });
          branchInputs.push(checkbox);
          const option = el(
            "label",
            { class: `branch-option${branch.active ? "" : " disabled"}`, title: branch.active ? branch.name : "فرع معطل" },
            checkbox,
            el("span", {}, el("strong", { text: branch.name }), el("small", { text: branch.code })),
          );
          return option;
        }),
  );

  const syncBranchState = () => {
    const all = Boolean(allBranchesToggle?.checked);
    for (const checkbox of branchInputs) {
      if (all) {
        checkbox.checked = false;
        checkbox.disabled = true;
      } else {
        checkbox.disabled = checkbox.closest(".branch-option")?.classList.contains("disabled") ?? false;
      }
    }
  };
  if (allBranchesToggle) {
    allBranchesToggle.addEventListener("change", syncBranchState);
    syncBranchState();
  }

  const allBranchesRow = allBranchesToggle
    ? el(
        "label",
        { class: "checkbox-row", style: "margin-bottom:10px" },
        allBranchesToggle,
        el("span", {}, el("strong", { text: "الوصول إلى كل الفروع" }), el("br"), el("span", { class: "tiny muted", text: "يمنح هذا المستخدم رؤية جميع الفروع بما فيها الفروع المستقبلية." })),
      )
    : null;

  const errorHost = el("div");

  const form = el(
    "form",
    { id: "user-form", novalidate: true },
    el(
      "div",
      { class: "form-grid" },
      el(
        "div",
        { class: "form-field" },
        el("label", { class: "form-label", for: "user-username", text: "اسم المستخدم" }),
        usernameInput,
        el("span", { class: "form-hint", text: isEdit ? "لا يمكن تغيير اسم المستخدم بعد الإنشاء." : "حروف إنجليزية صغيرة وأرقام (3–32 حرفاً)." }),
      ),
      el(
        "div",
        { class: "form-field" },
        el("label", { class: "form-label", for: "user-fullname", text: "الاسم الكامل" }),
        fullNameInput,
      ),
      el(
        "div",
        { class: "form-field" },
        el("label", { class: "form-label", for: "user-email", text: "البريد الإلكتروني" }),
        emailInput,
      ),
      el(
        "div",
        { class: "form-field" },
        el("label", { class: "form-label", for: "user-role", text: "الدور" }),
        roleSelect,
      ),
      activeToggle ? el("div", { class: "form-field span-2" }, activeToggle) : null,
      el(
        "div",
        { class: "form-field span-2" },
        el("span", { class: "section-label" }, "نطاق الفروع", el("span", { class: "tiny muted", text: "يُطبق على البيانات والصلاحيات" })),
        allBranchesRow,
        branchGrid,
        el("span", { class: "form-hint", text: "لا يمكن إسناد المستخدم إلى فرع معطل. الفروع المتاحة بحسب نطاق صلاحيتك." }),
      ),
      roleNote,
      errorHost,
    ),
  );

  let submitButton;
  const footer = [
    el("button", { class: "btn btn-ghost", type: "button", onclick: () => controller.close() }, "إلغاء"),
    (submitButton = el(
      "button",
      { class: "btn btn-primary", type: "submit", form: "user-form" },
      icon(isEdit ? "check" : "user-plus"),
      isEdit ? "حفظ التغييرات" : "إنشاء المستخدم",
    )),
  ];

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    errorHost.replaceChildren();

    const fullName = fullNameInput.value.trim();
    const email = emailInput.value.trim();
    const roleKey = roleSelect.value;
    const active = activeToggle ? activeToggle.querySelector("input").checked : true;
    const allBranches = Boolean(allBranchesToggle?.checked);
    const branchIds = branchInputs.filter((checkbox) => checkbox.checked).map((checkbox) => checkbox.value);

    if (!isEdit && !/^[a-z0-9][a-z0-9._-]{2,31}$/.test(usernameInput.value.trim().toLowerCase())) {
      errorHost.append(scrollableError("اسم المستخدم يجب أن يبدأ بحرف أو رقم، ويتكون من 3–32 حرفاً إنجليزياً صغيراً أو رقماً أو . _ -"));
      usernameInput.focus();
      return;
    }
    if (fullName.length < 2) {
      errorHost.append(scrollableError("الاسم الكامل مطلوب."));
      fullNameInput.focus();
      return;
    }
    if (!allBranches && branchIds.length === 0) {
      errorHost.append(scrollableError("حدد فرعاً واحداً على الأقل، أو فعّل الوصول إلى كل الفروع."));
      return;
    }

    setButtonLoading(submitButton, true, isEdit ? "جارٍ الحفظ…" : "جارٍ الإنشاء…");
    try {
      if (!isEdit) {
        const data = await api("/api/users", {
          method: "POST",
          body: {
            username: usernameInput.value.trim().toLowerCase(),
            fullName,
            email,
            roleKey,
            allBranches,
            branchIds,
          },
        });
        controller.close();
        state.users.page = 1;
        await reload();
        toast("تم إنشاء المستخدم بنجاح.", "success");
        showTemporaryPassword({ username: data.user.username, password: data.temporaryPassword, isReset: false });
      } else {
        const body = { fullName, email: email || null };
        if (roleKey !== row.role.key) body.roleKey = roleKey;
        if (active !== row.active) body.active = active;
        const initialBranches = [...(row.branches ?? []).map((branch) => branch.id)].sort();
        const selectedBranches = [...branchIds].sort();
        const scopeChanged =
          allBranches !== row.allBranches ||
          JSON.stringify(initialBranches) !== JSON.stringify(selectedBranches);
        if (scopeChanged) {
          body.allBranches = allBranches;
          if (!allBranches) body.branchIds = selectedBranches;
        }
        await api(`/api/users/${row.id}`, { method: "PATCH", body });
        controller.close();
        toast("تم تحديث بيانات المستخدم.", "success");
        await reload();
      }
    } catch (error) {
      errorHost.append(scrollableError(friendlyError(error)));
      setButtonLoading(submitButton, false);
    }
  });

  const controller = openModal({
    title: isEdit ? "تعديل المستخدم" : "إضافة مستخدم",
    description: isEdit ? `تحديث بيانات "${row.fullName}" وصلاحياته.` : "سيُنشأ الحساب بكلمة مرور مؤقتة تُعرض مرة واحدة.",
    size: "lg",
    body: form,
    footer,
    onClose: () => {},
  });
  refreshRoleNote();
  usernameInput.focus();
}

export async function renderUsers(host, token) {
  if (!state.meta) {
    try {
      await refreshMeta();
    } catch {
      // Filters fall back to the signed-in user's branch scope.
    }
  }
  if (token !== state.renderToken) return;

  let listHost = null;
  let reload = null;
  const header = pageHeader({
    title: "إدارة المستخدمين",
    subtitle: "حسابات الدخول والأدوار ونطاق الفروع، ضمن صلاحياتك فقط.",
    actions: [
      el(
        "button",
        { class: "btn btn-secondary", type: "button", onclick: () => reload?.() },
        icon("refresh"),
        "تحديث",
      ),
      can("users.manage")
        ? el("button", { class: "btn btn-primary", type: "button", onclick: () => openUserForm(null, reload) }, icon("user-plus"), "إضافة مستخدم")
        : null,
    ].filter(Boolean),
  });

  const node = pageEnter(header);
  const filters = filterForm(async () => loadUserList(listHost, token, reload));
  listHost = el("div");
  reload = () => loadUserList(listHost, token, reload);
  node.append(filters, listHost);
  host.replaceChildren(node);
  await loadUserList(listHost, token, reload);
}
