export type ErrorCode =
  | "AUTH_MISSING_TOKEN"
  | "AUTH_INVALID_TOKEN"
  | "AUTH_EXPIRED_TOKEN"
  | "AUTH_INVALID_CREDENTIALS"
  | "AUTH_EMAIL_NOT_VERIFIED"
  | "AUTH_OTP_REQUIRED"
  | "AUTH_OTP_INVALID"
  | "AUTH_OTP_EXPIRED"
  | "AUTH_EMAIL_SEND_FAILED"
  | "AUTH_USER_NOT_FOUND"
  | "AUTH_EMAIL_TAKEN"
  | "AUTH_USERNAME_TAKEN"
  | "AUTH_PERMISSION_DENIED"
  | "VALIDATION_MISSING_FIELDS"
  | "VALIDATION_INVALID_FORMAT"
  | "VALIDATION_TOO_SHORT"
  | "DB_ERROR"
  | "DB_NOT_FOUND"
  | "DB_DUPLICATE"
  | "TASK_ALREADY_SUBMITTED"
  | "TASK_NOT_FOUND"
  | "PROJECT_NOT_FOUND"
  | "PROJECT_NOT_ENROLLED"
  | "VAULT_NOT_FOUND"
  | "WALLET_NOT_FOUND"
  | "EMAIL_NOT_CONFIGURED"
  | "RATE_LIMIT"
  | "INTERNAL"
  | "NOT_FOUND"
  | "EXTERNAL_API_ERROR";

export interface ErrorMeta {
  code: ErrorCode;
  message: string;
  solution: string;
  httpStatus: number;
}

export const ERROR_LIBRARY: Record<ErrorCode, ErrorMeta> = {
  AUTH_MISSING_TOKEN: {
    code: "AUTH_MISSING_TOKEN",
    message: "Authorization token is required",
    solution: "Include an Authorization: Bearer <token> header in your request",
    httpStatus: 401,
  },
  AUTH_INVALID_TOKEN: {
    code: "AUTH_INVALID_TOKEN",
    message: "Token is invalid or unrecognized",
    solution: "Log in again to obtain a fresh token",
    httpStatus: 401,
  },
  AUTH_EXPIRED_TOKEN: {
    code: "AUTH_EXPIRED_TOKEN",
    message: "Token has expired",
    solution: "Call POST /api/auth/refresh with your refreshToken to get a new token",
    httpStatus: 401,
  },
  AUTH_INVALID_CREDENTIALS: {
    code: "AUTH_INVALID_CREDENTIALS",
    message: "Invalid email or password",
    solution: "Double-check your credentials. Use the forgot-password flow if needed.",
    httpStatus: 401,
  },
  AUTH_EMAIL_NOT_VERIFIED: {
    code: "AUTH_EMAIL_NOT_VERIFIED",
    message: "Email address not verified",
    solution: "Check your inbox for the verification code and call POST /api/auth/send-otp first",
    httpStatus: 403,
  },
  AUTH_OTP_REQUIRED: {
    code: "AUTH_OTP_REQUIRED",
    message: "Email verification code is required",
    solution: "Call POST /api/auth/send-otp with your email to receive a verification code",
    httpStatus: 400,
  },
  AUTH_OTP_INVALID: {
    code: "AUTH_OTP_INVALID",
    message: "Invalid verification code",
    solution: "Make sure you entered the code exactly as received. Request a new code if needed.",
    httpStatus: 400,
  },
  AUTH_OTP_EXPIRED: {
    code: "AUTH_OTP_EXPIRED",
    message: "Verification code has expired",
    solution: "Request a new code via POST /api/auth/send-otp (codes expire after 10 minutes)",
    httpStatus: 400,
  },
  AUTH_EMAIL_SEND_FAILED: {
    code: "AUTH_EMAIL_SEND_FAILED",
    message: "Could not send verification email",
    solution: "Check RESEND_API_KEY is configured and the sender domain is verified on Resend",
    httpStatus: 503,
  },
  AUTH_USER_NOT_FOUND: {
    code: "AUTH_USER_NOT_FOUND",
    message: "User not found",
    solution: "Verify the user ID or email. The account may have been deleted.",
    httpStatus: 404,
  },
  AUTH_EMAIL_TAKEN: {
    code: "AUTH_EMAIL_TAKEN",
    message: "Email address is already registered",
    solution: "Log in with existing credentials or use the forgot-password flow",
    httpStatus: 409,
  },
  AUTH_USERNAME_TAKEN: {
    code: "AUTH_USERNAME_TAKEN",
    message: "Username is already taken",
    solution: "Choose a different username",
    httpStatus: 409,
  },
  AUTH_PERMISSION_DENIED: {
    code: "AUTH_PERMISSION_DENIED",
    message: "Insufficient permissions",
    solution: "This endpoint requires admin privileges. Contact your administrator.",
    httpStatus: 403,
  },
  VALIDATION_MISSING_FIELDS: {
    code: "VALIDATION_MISSING_FIELDS",
    message: "Required fields are missing",
    solution: "Include all required fields in the request body",
    httpStatus: 400,
  },
  VALIDATION_INVALID_FORMAT: {
    code: "VALIDATION_INVALID_FORMAT",
    message: "Invalid field format",
    solution: "Check the API documentation for the expected format of each field",
    httpStatus: 400,
  },
  VALIDATION_TOO_SHORT: {
    code: "VALIDATION_TOO_SHORT",
    message: "Field value is too short",
    solution: "Ensure the value meets the minimum length requirement",
    httpStatus: 400,
  },
  DB_ERROR: {
    code: "DB_ERROR",
    message: "Database operation failed",
    solution: "Check DATABASE_URL is set correctly and the database is reachable",
    httpStatus: 500,
  },
  DB_NOT_FOUND: {
    code: "DB_NOT_FOUND",
    message: "Record not found in database",
    solution: "Verify the ID or lookup field exists in the database",
    httpStatus: 404,
  },
  DB_DUPLICATE: {
    code: "DB_DUPLICATE",
    message: "Duplicate record — unique constraint violated",
    solution: "The record already exists. Use PATCH to update or supply a unique value.",
    httpStatus: 409,
  },
  TASK_ALREADY_SUBMITTED: {
    code: "TASK_ALREADY_SUBMITTED",
    message: "Task already submitted",
    solution: "You have already submitted this task. Wait for review or check your submissions.",
    httpStatus: 409,
  },
  TASK_NOT_FOUND: {
    code: "TASK_NOT_FOUND",
    message: "Task not found",
    solution: "Verify the task ID exists and you have access to the project",
    httpStatus: 404,
  },
  PROJECT_NOT_FOUND: {
    code: "PROJECT_NOT_FOUND",
    message: "Project not found",
    solution: "Verify the project ID is correct and the project is still active",
    httpStatus: 404,
  },
  PROJECT_NOT_ENROLLED: {
    code: "PROJECT_NOT_ENROLLED",
    message: "You are not enrolled in this project",
    solution: "Call POST /api/projects/:id/join to enroll before accessing project tasks",
    httpStatus: 403,
  },
  VAULT_NOT_FOUND: {
    code: "VAULT_NOT_FOUND",
    message: "Vault entry not found",
    solution: "Verify the vault entry ID belongs to your account",
    httpStatus: 404,
  },
  WALLET_NOT_FOUND: {
    code: "WALLET_NOT_FOUND",
    message: "Wallet not found",
    solution: "Verify the wallet ID belongs to your account",
    httpStatus: 404,
  },
  EMAIL_NOT_CONFIGURED: {
    code: "EMAIL_NOT_CONFIGURED",
    message: "Email service not configured",
    solution: "Set RESEND_API_KEY environment variable, or configure SMTP in Admin → Settings",
    httpStatus: 503,
  },
  RATE_LIMIT: {
    code: "RATE_LIMIT",
    message: "Too many requests",
    solution: "Wait before retrying. Implement exponential backoff in your client.",
    httpStatus: 429,
  },
  INTERNAL: {
    code: "INTERNAL",
    message: "Internal server error",
    solution: "Check server logs. If the issue persists, contact support at support@ayzen.tech",
    httpStatus: 500,
  },
  NOT_FOUND: {
    code: "NOT_FOUND",
    message: "Endpoint not found",
    solution: "Check the URL path and HTTP method. See GET /api/functions for all available endpoints.",
    httpStatus: 404,
  },
  EXTERNAL_API_ERROR: {
    code: "EXTERNAL_API_ERROR",
    message: "External API call failed",
    solution: "Check that the relevant API key is configured (GROQ_API_KEY, OPENROUTER_API_KEY, etc.)",
    httpStatus: 502,
  },
};

export class AppError extends Error {
  public readonly code: ErrorCode;
  public readonly httpStatus: number;
  public readonly solution: string;
  public readonly details?: unknown;

  constructor(code: ErrorCode, details?: unknown) {
    const meta = ERROR_LIBRARY[code];
    super(meta.message);
    this.name = "AppError";
    this.code = code;
    this.httpStatus = meta.httpStatus;
    this.solution = meta.solution;
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  toJSON() {
    return {
      error: this.message,
      code: this.code,
      solution: this.solution,
      ...(this.details !== undefined ? { details: this.details } : {}),
    };
  }
}

export function appError(code: ErrorCode, details?: unknown): AppError {
  return new AppError(code, details);
}
