import { useRef, useState, type ReactNode } from "react";
import { revalidateLogic, useForm } from "@tanstack/react-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { fieldMessages, textareaClass } from "@/components/feedback/form-feedback";
import { GRANT_TYPES } from "@/features/admin-api/inputs";
import {
  ClientFieldsSchema,
  hasHttpLocalhost,
  type ClientFields,
  type ClientFormValues,
} from "./client-form-schema";

/** A resource the client may be allowed (`listResources`). */
export interface ResourceOption {
  resourceId: string;
  identifier: string;
  adminCapable: boolean;
}

export type SubmitOutcome = { error: string } | { info: string } | { saved: ClientFormValues };

const FIELD_ORDER = [
  "grantTypes",
  "redirectUris",
  "postLogoutRedirectUris",
  "frontchannelLogoutUri",
  "allowedCorsOrigins",
  "allowedResources",
  "scopes",
] as const;
const fieldId = (name: string) => `client-${name}`;

const GRANT_LABELS: Record<(typeof GRANT_TYPES)[number], string> = {
  authorization_code: "Authorization code",
  refresh_token: "Refresh token",
};

export const ADMIN_RESOURCE_WARNING =
  "Grants admin API access: super_admin only, the client must be confidential, and saving revokes every existing secret.";

interface ClientFormProps {
  initial: ClientFormValues;
  /**
   * Edit: the server values this form was loaded from (without a draft). Defaults to `initial`.
   * `initial` and `base` are read at mount only (a draft restore remounts via `key`) and both move
   * to the saved values after a save. The form never follows a refetch (frozen `defaultValues`), so
   * what it shows and the diff base stay together: a diff is what this admin changed (DEBT-307).
   */
  base?: ClientFormValues;
  resources: { options?: ResourceOption[]; failed: boolean };
  /** The values come from a step-up draft: ask for a review, never submit by itself. */
  restored: boolean;
  submitLabel: string;
  /** Create-only fields (type / auth method), rendered first. */
  children?: ReactNode;
  onSubmit: (fields: ClientFields, values: ClientFormValues, base: ClientFormValues) => Promise<SubmitOutcome | null>;
}

/**
 * Create/edit form for the editable client fields (run 44 A6.1). Validation runs on submit, then
 * on change (zod mirror of the BE rules); errors are attached to their field (`aria-invalid`,
 * `aria-describedby`) and the first invalid field gets focus. A BE refusal is a form-level alert.
 */
export function ClientForm({ initial, base, resources, restored, submitLabel, children, onSubmit }: ClientFormProps) {
  // Frozen snapshot: `useForm` calls `formApi.update(opts)` on every render and an untouched form
  // would take new `defaultValues` (a refetch) while the diff base stays put => lost update.
  const [defaults, setDefaults] = useState(initial);
  const baseRef = useRef(base ?? initial);
  const [outcome, setOutcome] = useState<{ error?: string; info?: string } | null>(null);
  const [showRestored, setShowRestored] = useState(restored);
  const form = useForm({
    defaultValues: defaults,
    validationLogic: revalidateLogic(),
    validators: { onDynamic: ClientFieldsSchema },
    onSubmit: async ({ value, formApi }) => {
      setOutcome(null);
      const result = await onSubmit(ClientFieldsSchema.parse(value), value, baseRef.current);
      if (!result) return;
      setShowRestored(false);
      if ("saved" in result) {
        // Same object as `reset` writes to `options.defaultValues`: the next `update` is a no-op
        // (set in the same batch as the outcome, so no render passes the old snapshot back).
        baseRef.current = result.saved;
        setDefaults(result.saved);
        formApi.reset(result.saved);
        setOutcome({ info: "Saved." });
      } else {
        setOutcome(result);
      }
    },
    onSubmitInvalid: ({ formApi }) => {
      const first = FIELD_ORDER.find((name) => (formApi.getFieldMeta(name)?.errors.length ?? 0) > 0);
      if (first) document.getElementById(fieldId(first))?.focus();
    },
  });

  return (
    <form
      noValidate
      className="max-w-2xl space-y-6"
      onSubmit={(e) => {
        e.preventDefault();
        void form.handleSubmit();
      }}
    >
      {showRestored && (
        <p role="status" className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
          You just confirmed your identity. Check the values, then submit again.
        </p>
      )}
      {children}

      <form.Field name="grantTypes">
        {(field) => (
          <Group label="Grant types" name={field.name} errors={fieldMessages(field.state.meta.errors)}>
            {GRANT_TYPES.map((grant, i) => (
              <Check
                key={grant}
                id={i === 0 ? fieldId(field.name) : undefined}
                label={GRANT_LABELS[grant]}
                checked={field.state.value.includes(grant)}
                invalid={field.state.meta.errors.length > 0}
                onChange={(on) =>
                  field.handleChange(GRANT_TYPES.filter((g) => (g === grant ? on : field.state.value.includes(g))))
                }
              />
            ))}
          </Group>
        )}
      </form.Field>

      {(
        [
          ["redirectUris", "Redirect URIs", "One absolute https URL per line. No wildcard, no fragment."],
          ["postLogoutRedirectUris", "Post-logout redirect URIs", "One absolute https URL per line."],
        ] as const
      ).map(([name, label, hint]) => (
        <form.Field key={name} name={name}>
          {(field) => (
            <TextField
              name={field.name}
              label={label}
              hint={hint}
              warning={hasHttpLocalhost(field.state.value) ? LOCALHOST_WARNING : undefined}
              errors={fieldMessages(field.state.meta.errors)}
            >
              {(props) => (
                <textarea
                  {...props}
                  rows={3}
                  className={textareaClass}
                  value={field.state.value}
                  onChange={(e) => field.handleChange(e.target.value)}
                  onBlur={field.handleBlur}
                />
              )}
            </TextField>
          )}
        </form.Field>
      ))}

      <form.Field name="frontchannelLogoutUri">
        {(field) => (
          <TextField
            name={field.name}
            label="Front-channel logout URI"
            hint="Optional. Leave empty for none."
            warning={hasHttpLocalhost(field.state.value) ? LOCALHOST_WARNING : undefined}
            errors={fieldMessages(field.state.meta.errors)}
          >
            {(props) => (
              <Input
                {...props}
                type="url"
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
                onBlur={field.handleBlur}
              />
            )}
          </TextField>
        )}
      </form.Field>

      <form.Field name="allowedCorsOrigins">
        {(field) => (
          <TextField
            name={field.name}
            label="Allowed CORS origins"
            hint="One exact origin per line, e.g. https://app.example.com (no path, no trailing slash)."
            warning={hasHttpLocalhost(field.state.value) ? LOCALHOST_WARNING : undefined}
            errors={fieldMessages(field.state.meta.errors)}
          >
            {(props) => (
              <textarea
                {...props}
                rows={2}
                className={textareaClass}
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
                onBlur={field.handleBlur}
              />
            )}
          </TextField>
        )}
      </form.Field>

      <form.Field name="allowedResources">
        {(field) => {
          const known = resources.options ?? [];
          // Keep resources the client already has even when they are not in the first page.
          const extra = field.state.value.filter((id) => !known.some((r) => r.resourceId === id));
          const options = [...known, ...extra.map((id) => ({ resourceId: id, identifier: "", adminCapable: false }))];
          return (
            <Group label="Allowed resources" name={field.name} errors={fieldMessages(field.state.meta.errors)}>
              {resources.failed && <p className="text-sm text-destructive">The resource list could not be loaded.</p>}
              {!resources.failed && !resources.options && <p className="text-sm text-muted-foreground">Loading resources…</p>}
              {resources.options && options.length === 0 && (
                <p className="text-sm text-muted-foreground">No resources.</p>
              )}
              {options.map((r, i) => (
                <Check
                  key={r.resourceId}
                  id={i === 0 ? fieldId(field.name) : undefined}
                  label={r.resourceId}
                  detail={r.identifier || undefined}
                  warning={r.adminCapable ? ADMIN_RESOURCE_WARNING : undefined}
                  checked={field.state.value.includes(r.resourceId)}
                  invalid={field.state.meta.errors.length > 0}
                  onChange={(on) =>
                    field.handleChange(
                      on ? [...field.state.value, r.resourceId] : field.state.value.filter((id) => id !== r.resourceId),
                    )
                  }
                />
              ))}
            </Group>
          );
        }}
      </form.Field>

      <form.Field name="scopes">
        {(field) => (
          <TextField
            name={field.name}
            label="Scopes"
            hint="Separated by spaces, e.g. openid profile email."
            errors={fieldMessages(field.state.meta.errors)}
          >
            {(props) => (
              <Input
                {...props}
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
                onBlur={field.handleBlur}
              />
            )}
          </TextField>
        )}
      </form.Field>

      {outcome?.error && (
        <p role="alert" className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
          {outcome.error}
        </p>
      )}
      {outcome?.info && (
        <p role="status" className="text-sm">
          {outcome.info}
        </p>
      )}
      <form.Subscribe selector={(s) => s.isSubmitting}>
        {(submitting) => (
          <Button type="submit" disabled={submitting}>
            {submitting ? "Saving…" : submitLabel}
          </Button>
        )}
      </form.Subscribe>
    </form>
  );
}

const LOCALHOST_WARNING = "http://localhost is only accepted outside production (the server decides).";

/** No `name`: a submit before hydration must not put the values in the URL (native GET). */
interface ControlProps {
  id: string;
  "aria-invalid": boolean;
  "aria-describedby": string;
}

/** Label + hint + warning + errors for one text control; the control gets the ARIA wiring. */
function TextField({
  name,
  label,
  hint,
  warning,
  errors,
  children,
}: {
  name: string;
  label: string;
  hint: string;
  warning?: string;
  errors: string[];
  children: (props: ControlProps) => ReactNode;
}) {
  const id = fieldId(name);
  const describedBy = [`${id}-hint`, warning && `${id}-warning`, errors.length && `${id}-error`].filter(Boolean).join(" ");
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      {children({
        id,
        "aria-invalid": errors.length > 0,
        "aria-describedby": describedBy,
      })}
      <p id={`${id}-hint`} className="text-xs text-muted-foreground">
        {hint}
      </p>
      {warning && (
        <p id={`${id}-warning`} className="text-xs text-amber-700 dark:text-amber-400">
          {warning}
        </p>
      )}
      <FieldErrors id={`${id}-error`} errors={errors} />
    </div>
  );
}

function FieldErrors({ id, errors }: { id: string; errors: string[] }) {
  if (errors.length === 0) return null;
  return (
    <ul id={id} className="space-y-0.5 text-sm text-destructive">
      {errors.map((m) => (
        <li key={m}>{m}</li>
      ))}
    </ul>
  );
}

/** A group of checkboxes (fieldset + legend); its error describes the group. */
function Group({ label, name, errors, children }: { label: string; name: string; errors: string[]; children: ReactNode }) {
  const errorId = `${fieldId(name)}-error`;
  return (
    <fieldset className="space-y-2" aria-describedby={errors.length ? errorId : undefined}>
      <legend className="text-sm font-medium">{label}</legend>
      {children}
      <FieldErrors id={errorId} errors={errors} />
    </fieldset>
  );
}

function Check({
  id,
  label,
  detail,
  warning,
  checked,
  invalid,
  onChange,
}: {
  id?: string;
  label: string;
  detail?: string;
  warning?: string;
  checked: boolean;
  invalid: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-2 text-sm">
      <input
        id={id}
        type="checkbox"
        className="mt-0.5 size-4"
        checked={checked}
        aria-invalid={invalid}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>
        <span className="font-medium">{label}</span>
        {detail && <span className="block break-all text-xs text-muted-foreground">{detail}</span>}
        {warning && <span className="block text-xs text-amber-700 dark:text-amber-400">{warning}</span>}
      </span>
    </label>
  );
}
