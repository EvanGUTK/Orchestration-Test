import {
  DISPLAY_NAME_MAX,
  DISPLAY_NAME_MIN,
  PASSWORD_MAX,
  PASSWORD_MIN,
  USERNAME_PATTERN,
} from "@g2048/contracts";

/** Unicode code points, as the contract counts display names and passwords (not UTF-16 units). */
export function codePointLength(value: string): number {
  return [...value].length;
}

/** Contract normalization: ASCII-only lowercase (non-ASCII letters are left alone and then rejected). */
export function normalizeUsername(value: string): string {
  return value.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

export function usernameError(value: string): string | null {
  const normalized = normalizeUsername(value);
  if (normalized.length === 0) return "Enter a username.";
  if (!USERNAME_PATTERN.test(normalized)) {
    return "Use 3–24 characters: letters a–z, digits 0–9 and underscore.";
  }
  return null;
}

export function displayNameError(value: string): string | null {
  const n = codePointLength(value);
  if (n < DISPLAY_NAME_MIN) return "Enter a display name.";
  if (n > DISPLAY_NAME_MAX) return `Display names are at most ${DISPLAY_NAME_MAX} characters (now ${n}).`;
  return null;
}

export function passwordError(value: string): string | null {
  const n = codePointLength(value);
  if (n < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters (now ${n}).`;
  if (n > PASSWORD_MAX) return `Passwords are at most ${PASSWORD_MAX} characters.`;
  return null;
}

export type RegisterErrors = Partial<Record<"username" | "displayName" | "password" | "confirm", string>>;

export function validateRegistration(input: {
  username: string;
  displayName: string;
  password: string;
  confirm: string;
}): RegisterErrors {
  const errors: RegisterErrors = {};
  const u = usernameError(input.username);
  if (u) errors.username = u;
  const d = displayNameError(input.displayName);
  if (d) errors.displayName = d;
  const p = passwordError(input.password);
  if (p) errors.password = p;
  if (input.password !== input.confirm) errors.confirm = "Passwords don't match.";
  return errors;
}
