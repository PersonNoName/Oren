"use client";

import { useState, type FormEvent } from "react";
import { updateCommitment } from "@/lib/panel-api";
import type { CommitmentStatus } from "@/lib/panel-types";

type Props = {
  onSuccess: () => void | Promise<void>;
};

export function CommitmentForm({ onSuccess }: Props) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setError(null);
    const form = e.currentTarget;
    const fd = new FormData(form);
    const commitmentId = String(fd.get("commitmentId"));
    const status = fd.get("status") as CommitmentStatus;
    const reason = String(fd.get("reason"));
    const nextStepRaw = fd.get("nextStep");
    const body: { status: CommitmentStatus; reason: string; nextStep?: string } = {
      status,
      reason,
    };
    if (nextStepRaw) body.nextStep = String(nextStepRaw);

    try {
      await updateCommitment(commitmentId, body);
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
          Commitment ID
          <input name="commitmentId" placeholder="Commitment ID" required />
        </label>
        <label>
          Status
          <select name="status" defaultValue="active">
            <option value="active">active</option>
            <option value="paused">paused</option>
            <option value="done">done</option>
          </select>
        </label>
        <label>
          Next step (optional)
          <input name="nextStep" placeholder="Next step (optional)" />
        </label>
        <label>
          Reason
          <input name="reason" placeholder="Reason" required />
        </label>
        <button type="submit" disabled={pending}>
          {pending ? "Updating…" : "Update"}
        </button>
      </form>
      {error ? <p className="form-error">{error}</p> : null}
    </div>
  );
}
