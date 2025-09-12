import { AuditLog } from "./model.js";

export async function writeAudit(entry: ConstructorParameters<typeof AuditLog>[0]) {
  try {
    await AuditLog.create(entry as any);
  } catch {
    // non-fatal; avoid breaking admin ops due to audit log failure
  }
}
