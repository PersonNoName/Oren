import type { CommitmentStatus, PanelSnapshot, ReachabilityPolicy } from "./panel-types.js";

async function readOkJson(res: Response, label: string): Promise<unknown> {
  if (!res.ok) {
    let detail = "";
    try {
      detail = ` ${JSON.stringify(await res.json())}`;
    } catch {
      /* ignore */
    }
    throw new Error(`${label} failed: ${res.status}${detail}`);
  }
  return res.json();
}

export async function fetchSnapshot(fetcher: typeof fetch = fetch): Promise<PanelSnapshot> {
  const res = await fetcher("/api/snapshot");
  return (await readOkJson(res, "snapshot")) as PanelSnapshot;
}

export async function postMessage(text: string, fetcher: typeof fetch = fetch): Promise<void> {
  const res = await fetcher("/api/message", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  await readOkJson(res, "message");
}

export async function updateCommitment(
  commitmentId: string,
  body: { status: CommitmentStatus; nextStep?: string; reason: string },
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const payload: Record<string, string> = { status: body.status, reason: body.reason };
  if (body.nextStep !== undefined) payload.nextStep = body.nextStep;
  const res = await fetcher(`/api/commitments/${encodeURIComponent(commitmentId)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  await readOkJson(res, "commitment");
}

export async function revokeGrant(
  grantId: string,
  reason: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const res = await fetcher(`/api/grants/${encodeURIComponent(grantId)}/revoke`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reason }),
  });
  await readOkJson(res, "revoke");
}

export async function updateReachability(
  policy: ReachabilityPolicy,
  reason: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const res = await fetcher("/api/reachability", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ policy, reason }),
  });
  await readOkJson(res, "reachability");
}
