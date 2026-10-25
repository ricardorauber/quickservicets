/** One line of the audit log, written after each committed user change. */
export type AuditEntry = {
  type: string;
  recordId: string;
  changed: string[];
};
