import { useRef, useState } from "react";
import { revalidateLogic, useForm } from "@tanstack/react-form";
import type { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useActionNotice } from "@/components/feedback/confirm-action";
import { fieldMessages, textareaClass } from "@/components/feedback/form-feedback";

type FieldName = "resourceId" | "identifier" | "scopes";
type Values = Partial<Record<FieldName, string>>;

export type ResourceSubmitOutcome<V> = { error: string } | { info: string } | { saved: V; info: string };

const FIELDS: Record<FieldName, { label: string; hint: string }> = {
  resourceId: {
    label: "Resource ID",
    hint: "Lowercase letters, digits, '.', '_' or '-' (up to 64). Cannot be changed later.",
  },
  identifier: {
    label: "Identifier",
    hint: "Absolute URI without a fragment, e.g. https://api.example.com/ — the token audience. Cannot be changed later.",
  },
  scopes: {
    label: "Scopes",
    hint: "Separated by spaces or new lines. Informational: token scopes are bounded by each client's scopes.",
  },
};
const ORDER: FieldName[] = ["resourceId", "identifier", "scopes"];
const fieldId = (name: string) => `resource-${name}`;

interface ResourceFormProps<V extends Values> {
  /** Section heading: gets the focus when a result is announced (DEBT-319 pattern). */
  title: string;
  /** Read at mount only (a draft restore remounts via `key`); the form never follows a refetch. */
  initial: V;
  /** Edit: the server values the form was loaded from (diff base). Defaults to `initial`. */
  base?: V;
  /** zod mirror of the BE rules (validation only: the caller parses the values it sends). */
  schema: z.ZodType<unknown, V>;
  /** Values come from a step-up draft: ask for a review, never submit by itself. */
  restored: boolean;
  submitLabel: string;
  onSubmit: (values: V, base: V) => Promise<ResourceSubmitOutcome<V> | null>;
}

/**
 * Create / edit form of a resource (run 46 A6.2): the fields are the keys of `initial` (an edit
 * holds `scopes` only). Validation on submit, then on change; errors are attached to their field and
 * the first invalid field gets focus. Result regions (`status` / `alert`) are always rendered.
 */
export function ResourceForm<V extends Values>({ title, initial, base, schema, restored, submitLabel, onSubmit }: ResourceFormProps<V>) {
  const [defaults, setDefaults] = useState(initial);
  const baseRef = useRef(base ?? initial);
  const [error, setError] = useState("");
  const [showRestored, setShowRestored] = useState(restored);
  const { notice, headingRef, announce } = useActionNotice();
  const names = ORDER.filter((n) => n in initial);
  const form = useForm({
    defaultValues: defaults as Values,
    validationLogic: revalidateLogic(),
    validators: { onDynamic: schema as z.ZodType<unknown, Values> },
    onSubmit: async ({ value, formApi }) => {
      setError("");
      const result = await onSubmit(value as V, baseRef.current);
      if (!result) return;
      setShowRestored(false);
      if ("error" in result) return setError(result.error);
      if ("saved" in result) {
        baseRef.current = result.saved;
        setDefaults(result.saved);
        formApi.reset(result.saved);
      }
      announce(result.info);
    },
    onSubmitInvalid: ({ formApi }) => {
      const first = names.find((name) => (formApi.getFieldMeta(name)?.errors.length ?? 0) > 0);
      if (first) document.getElementById(fieldId(first))?.focus();
    },
  });

  return (
    <div className="space-y-3">
      <h2 ref={headingRef} tabIndex={-1} className="text-lg font-semibold outline-none">
        {title}
      </h2>
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
        {names.map((name) => (
          <form.Field key={name} name={name}>
            {(field) => {
              const id = fieldId(name);
              const errors = fieldMessages(field.state.meta.errors);
              const props = {
                id,
                value: field.state.value ?? "",
                "aria-invalid": errors.length > 0,
                "aria-describedby": [`${id}-hint`, errors.length && `${id}-error`].filter(Boolean).join(" "),
                onBlur: field.handleBlur,
              };
              return (
                <div className="space-y-1.5">
                  <label htmlFor={id} className="block text-sm font-medium">
                    {FIELDS[name].label}
                  </label>
                  {name === "scopes" ? (
                    <textarea
                      {...props}
                      rows={3}
                      className={textareaClass}
                      onChange={(e) => field.handleChange(e.target.value)}
                    />
                  ) : (
                    <Input {...props} className="font-mono" onChange={(e) => field.handleChange(e.target.value)} />
                  )}
                  <p id={`${id}-hint`} className="text-xs text-muted-foreground">
                    {FIELDS[name].hint}
                  </p>
                  {errors.length > 0 && (
                    <ul id={`${id}-error`} className="space-y-0.5 text-sm text-destructive">
                      {errors.map((m) => (
                        <li key={m}>{m}</li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            }}
          </form.Field>
        ))}
        <p
          role="alert"
          className={error ? "rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive" : undefined}
        >
          {error}
        </p>
        <p role="status" className="text-sm">
          {notice}
        </p>
        <form.Subscribe selector={(s) => s.isSubmitting}>
          {(submitting) => (
            <Button type="submit" disabled={submitting}>
              {submitting ? "Saving…" : submitLabel}
            </Button>
          )}
        </form.Subscribe>
      </form>
    </div>
  );
}
