import { PasswordInput } from "@g2048/contracts";
import { DatabaseWriter, prepareDatabase } from "@g2048/database";
import { AppError, parseWith } from "./http/errors.js";
import { PasswordHasher } from "./security/passwords.js";
import { AuthService } from "./services/auth-service.js";

/**
 * Explicit local owner password reset (PROJECT_SCOPE "Password recovery is an explicit local owner
 * reset"). Only reachable from the CLI on the machine that holds the database file; there is no HTTP
 * route and no hidden credential. Every session of the account is revoked.
 */
export async function ownerResetPassword(
  databasePath: string,
  username: string,
  newPassword: string,
  hasher: PasswordHasher = new PasswordHasher(),
): Promise<{ revokedSessions: number }> {
  if (!PasswordInput.safeParse(newPassword).success) {
    throw new Error("New password must be 12-128 characters");
  }
  const password = parseWith(PasswordInput, newPassword);
  const { db } = await prepareDatabase(databasePath);
  const writer = new DatabaseWriter(db);
  try {
    const auth = new AuthService({ db, writer, clock: () => new Date() }, { hasher });
    return await auth.ownerResetPassword(username, password);
  } catch (error) {
    if (error instanceof AppError) throw new Error(error.message, { cause: error });
    throw error;
  } finally {
    await writer.close();
    db.close();
  }
}
