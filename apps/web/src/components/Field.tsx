import { useId } from "react";
import type { InputHTMLAttributes } from "react";

type FieldProps = {
  label: string;
  hint?: string;
  error?: string | undefined;
} & Omit<InputHTMLAttributes<HTMLInputElement>, "id">;

/** Labelled text input with hint and error wired through aria-describedby / aria-invalid. */
export function Field({ label, hint, error, ...input }: FieldProps) {
  const id = useId();
  const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(" ");
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
        {...input}
      />
      {hint && (
        <p className="hint hint--small" id={`${id}-hint`}>
          {hint}
        </p>
      )}
      {error && (
        <p className="field__error" id={`${id}-error`}>
          {error}
        </p>
      )}
    </div>
  );
}
