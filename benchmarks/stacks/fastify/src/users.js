// User body validation: every field is checked and every problem reported together, one message per field.
import { invalidBody } from "./errors.js";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ROLES = new Set(["member", "admin"]);
const READ_ONLY = new Set(["id", "createdAt", "updatedAt"]);
const WRITABLE = new Set(["email", "name", "role", "age"]);

function checkEmail(value) {
  if (value === null) return "Cannot be null";
  if (typeof value !== "string") return "Must be a string";
  if (!EMAIL.test(value)) return "Must be a valid email";
}

function checkName(value) {
  if (value === null) return "Cannot be null";
  if (typeof value !== "string") return "Must be a string";
  if (value.length < 1) return "Must be at least 1 characters";
  if (value.length > 100) return "Must be at most 100 characters";
}

function checkRole(value) {
  if (value === null) return "Cannot be null";
  if (typeof value !== "string" || !ROLES.has(value)) return "Must be one of: member, admin";
}

function checkAge(value) {
  if (value === null) return;
  if (typeof value !== "number") return "Must be a number";
  if (!Number.isInteger(value)) return "Must be an integer";
  if (value < 0) return "Must be at least 0";
  if (value > 150) return "Must be at most 150";
}

const CHECKS = { email: checkEmail, name: checkName, role: checkRole, age: checkAge };

/**
 * Validates a create (`creating`) or update body and returns the given writable fields.
 * Throws 400 Invalid body with every problem.
 */
export function validateUser(body, creating) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw invalidBody([{ field: "", message: "Body must be a JSON object" }]);
  }
  const details = [];
  const data = {};
  for (const field of ["email", "name", "role", "age"]) {
    if (!Object.hasOwn(body, field)) {
      if (creating && (field === "email" || field === "name")) details.push({ field, message: "Is required" });
      continue;
    }
    const value = body[field];
    const message = CHECKS[field](value);
    if (message) details.push({ field, message });
    else data[field] = value;
  }
  for (const key of Object.keys(body)) {
    if (WRITABLE.has(key)) continue;
    details.push({ field: key, message: READ_ONLY.has(key) ? "Field is read-only" : "Unknown field" });
  }
  if (details.length > 0) throw invalidBody(details);
  return data;
}
