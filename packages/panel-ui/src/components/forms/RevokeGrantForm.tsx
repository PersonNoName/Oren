"use client";

import { useState, type FormEvent } from "react";
import { revokeGrant } from "@/lib/panel-api";

type Props = {
  onSuccess: () => void | Promise<void>;
};

export function RevokeGrantForm({ onSuccess }: Props) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setError(null);
    const form = e.currentTarget;
    const fd = new FormData(form);
    const grantId = String(fd.get("grantId"));
    const reason = String(fd.get("reason"));

    try {
      await revokeGrant(grantId, reason);
      form.reset();
      await onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="action-form-wrap">
      <form className="action-form" onSubmit={handleSubmit}>
        <label>
          Grant ID
          <input name="grantId" placeholder="Grant ID" required />
        </label>
        <label>
          Reason
          <input name="reason" placeholder="Reason" required />
        </label>
        <button type="submit" disabled={pending}>
          {pending ? "Revoking…" : "Revoke"}
        </button>
      </form>
      {error ? <p className="form-error">{error}</p> : null}
    </div>
  );
}
