import { ValidateBy } from 'class-validator';

/** Local part atoms: letters, digits and `._+'-` only (D84.1), dots only between atoms. */
const LOCAL = /^[A-Za-z0-9_+'-]+(?:\.[A-Za-z0-9_+'-]+)*$/;
/** One LDH label, 1-63 characters, no leading/trailing hyphen. */
const LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

/**
 * Run 84 D84.1 (DEBT-550/556): the only address shape that may lead to a mail or to a new/linked
 * account: ASCII `local@domain`, deliberately narrower than RFC 5322 so the mailbox a verify/reset
 * mail reaches never depends on how the SMTP library parses quotes, comments, groups or `%`/`!`
 * relays. The raw value must match as is (no trim). IDN only as A-labels (`xn--`, DEBT-560).
 */
export function isDeliverableEmail(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 254) return false;
  const at = value.indexOf('@');
  if (at < 1 || at !== value.lastIndexOf('@')) return false;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (local.length > 64 || !LOCAL.test(local) || domain.length > 253) return false;
  const labels = domain.split('.');
  return (
    labels.length >= 2 &&
    labels.every((label) => LABEL.test(label)) &&
    /^[A-Za-z]/.test(labels[labels.length - 1])
  );
}

/** Fixed: a validation message never carries the submitted value. */
export const DELIVERABLE_EMAIL_MESSAGE = 'email must be a plain address like name@example.com';

/** class-validator form of {@link isDeliverableEmail}; used next to `@IsEmail()`, never instead. */
export function IsDeliverableEmail(): PropertyDecorator {
  return ValidateBy({
    name: 'isDeliverableEmail',
    validator: {
      validate: (value) => isDeliverableEmail(value),
      defaultMessage: () => DELIVERABLE_EMAIL_MESSAGE,
    },
  });
}
