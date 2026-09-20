import type { AuthenticatedActor } from '@common/security/authenticated-actor';

/*
 * Command của feature auth — controller map Request DTO → Command (+ actor/ip/ua lấy từ ngữ cảnh).
 * Service chỉ nhận Command, không nhận Request DTO của HTTP.
 */
export interface RegisterCommand {
  email: string;
  password: string;
  fullName: string;
  phone: string | null;
}

export interface GoogleLoginCommand {
  idToken: string;
}

export interface LoginCommand {
  email: string;
  password: string;
  deviceName: string | null;
}

export interface RefreshCommand {
  refreshToken: string;
}

export interface LogoutCommand {
  actor: AuthenticatedActor;
  refreshToken: string | null;
  accessExp: number | undefined;
}

export interface ChangePasswordCommand {
  actor: AuthenticatedActor;
  currentPassword: string;
  newPassword: string;
  accessExp: number | undefined;
}

export interface ForgotPasswordCommand {
  email: string;
}

export interface ResetPasswordCommand {
  email: string;
  otp: string;
  newPassword: string;
}
