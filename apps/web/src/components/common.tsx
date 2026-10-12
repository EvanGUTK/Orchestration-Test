import type { ReactNode } from "react";
import { describeError } from "../api/client.ts";

export function Spinner(props: { label?: string }) {
  return (
    <div className="status-line" role="status">
      <span className="spinner" aria-hidden="true" />
      <span>{props.label ?? "Loading"}</span>
    </div>
  );
}

export function ErrorPanel(props: { error: unknown; onRetry?: () => void; retryLabel?: string; extra?: ReactNode }) {
  const info = describeError(props.error);
  return (
    <div className="panel panel-error" role="alert">
      <h2 className="panel-title">{info.title}</h2>
      <p>{info.detail}</p>
      <p className="muted">{info.action}</p>
      <div className="row">
        {props.onRetry ? (
          <button type="button" className="btn" onClick={props.onRetry}>
            {props.retryLabel ?? "Try again"}
          </button>
        ) : null}
        {props.extra}
      </div>
    </div>
  );
}

export function EmptyState(props: { title: string; children?: ReactNode }) {
  return (
    <div className="panel empty">
      <h2 className="panel-title">{props.title}</h2>
      {props.children ? <div className="muted">{props.children}</div> : null}
    </div>
  );
}

export function Field(props: { id: string; label: string; hint?: string; error?: string | null; children: ReactNode }) {
  return (
    <div className="field">
      <label htmlFor={props.id}>{props.label}</label>
      {props.children}
      {props.hint ? (
        <p className="hint" id={`${props.id}-hint`}>
          {props.hint}
        </p>
      ) : null}
      {props.error ? (
        <p className="field-error" id={`${props.id}-error`} role="alert">
          {props.error}
        </p>
      ) : null}
    </div>
  );
}

export function PageHeading(props: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="page-heading">
      <div>
        <h1 tabIndex={-1} data-page-heading>
          {props.title}
        </h1>
        {props.subtitle ? <p className="muted">{props.subtitle}</p> : null}
      </div>
      {props.actions ? <div className="row">{props.actions}</div> : null}
    </div>
  );
}
