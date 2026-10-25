import { z } from "zod";

export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(
    z
      .string()
      .min(3, "اسم المستخدم يجب أن يتكون من 3 أحرف على الأقل.")
      .max(32, "اسم المستخدم يجب ألا يتجاوز 32 حرفاً.")
      .regex(/^[a-z0-9][a-z0-9._-]*$/, "اسم المستخدم يسمح بالحروف الإنجليزية الصغيرة والأرقام والنقطة والشرطة فقط."),
  );

export const fullNameSchema = z
  .string()
  .trim()
  .min(2, "الاسم الكامل مطلوب.")
  .max(100, "الاسم الكامل طويل جداً.");

export const emailSchema = z
  .union([z.literal(""), z.email("البريد الإلكتروني غير صالح.")])
  .transform((value) => (value === "" ? null : value.toLowerCase()))
  .nullable()
  .optional();

export const passwordSchema = z.string().min(1, "كلمة المرور مطلوبة.").max(128, "كلمة المرور طويلة جداً.");

export const branchIdsSchema = z.array(z.uuid("معرّف فرع غير صالح.")).max(200).default([]);

export const roleKeySchema = z.string().trim().min(1).max(50);
