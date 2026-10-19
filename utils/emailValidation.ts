/** Shared email format checks for form inputs before accept/submit. */

export const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(value: string): boolean {
  return EMAIL_REGEX.test((value || '').trim());
}

/** Split comma / newline / semicolon lists into trimmed non-empty tokens. */
export function parseEmailList(text: string): string[] {
  return (text || '')
    .split(/[,\n\r;]/)
    .map((email) => email.trim())
    .filter((email) => email.length > 0);
}

export function findInvalidEmails(emails: string[]): string[] {
  return emails.filter((email) => !isValidEmail(email));
}

export function invalidEmailsMessage(invalid: string[]): string {
  if (invalid.length === 0) return '';
  return `Invalid email${invalid.length > 1 ? 's' : ''}: ${invalid.join(', ')}`;
}
