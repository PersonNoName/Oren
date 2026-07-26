"use client";

import { useEffect, useState, type FormEvent } from "react";
import { updateReachability } from "@/lib/panel-api";
import type { ReachabilityPolicy } from "@/lib/panel-types";

type Props = {
  reachability: ReachabilityPolicy;
  onSuccess: () => void | Promise<void>;
};

export function ReachabilityForm({ reachability, onSuccess }: Props) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [maxProactivePerDay, setMaxProactivePerDay] = useState(
    reachability.maxProactivePerDay,
  );
  const [disableQuietHours, setDisableQuietHours] = useState(
    reachability.quietHours === null,
  );

  useEffect(() => {
    setMaxProactivePerDay(reachability.maxProactivePerDay);
    setDisableQuietHours(reachability.quietHours === null);
  }, [reachability]);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setError(null);
    const form = e.currentTarget;
    const fd = new FormData(form);
    const reason = String(fd.get("reason"));
    const policy = {
      ...reachability,
      maxProactivePerDay: Number(fd.get("maxProactivePerDay")),
      quietHours: disableQuietHours ? null : reachability.quietHours,
    };

    try {
      await updateReachability(policy, reason);
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
          Max proactive per day
          <input
            name="maxProactivePerDay"
            type="number"
            min={0}
            required
            value={maxProactivePerDay}
            onChange={(e) => setMaxProactivePerDay(Number(e.target.value))}
          />
        </label>
        <label className="action-form-checkbox">
          <input
            name="disableQuietHours"
            type="checkbox"
            checked={disableQuietHours}
            onChange={(e) => setDisableQuietHours(e.target.checked)}
          />
          Disable quiet hours
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
