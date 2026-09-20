import { Transform } from 'class-transformer';

/* Decorator chuẩn hoá input cho Request DTO — dùng chung để mọi module ghi email/boolean query giống nhau. */

/* Email: trim + lowercase (unique index trên lower(email)). Không phải string thì để validator báo lỗi. */
export const NormalizeEmail = () => Transform(({ value }): unknown => (typeof value === 'string' ? value.trim().toLowerCase() : value));

/* Query string 'true'/'false' → boolean; giá trị khác giữ nguyên để @IsBoolean báo lỗi. */
export const ToBoolean = () =>
  Transform(({ value }): unknown => (value === 'true' || value === true ? true : value === 'false' || value === false ? false : value));
