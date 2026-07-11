import type { ThoughtArtifact } from "../types.js";

export class ArtifactParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactParseError";
  }
}

export function parseArtifact(raw: string): ThoughtArtifact {
  const text = stripFences(raw).trim();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    // try to extract first JSON object
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        data = JSON.parse(text.slice(start, end + 1));
      } catch {
        throw new ArtifactParseError("response is not valid JSON");
      }
    } else {
      throw new ArtifactParseError("response is not valid JSON");
    }
  }

  if (!data || typeof data !== "object") {
    throw new ArtifactParseError("artifact root must be object");
  }
  const obj = data as Record<string, unknown>;
  const monologue = typeof obj.monologue === "string" ? obj.monologue.trim() : "";
  if (!monologue) {
    throw new ArtifactParseError("monologue is required and non-empty");
  }

  const refined =
    typeof obj.refined_summary === "string" ? obj.refined_summary.trim() : undefined;
  const open_questions = Array.isArray(obj.open_questions)
    ? obj.open_questions.filter((q): q is string => typeof q === "string" && q.trim().length > 0)
    : undefined;

  const artifact: ThoughtArtifact = {
    monologue,
    refined_summary: refined || undefined,
    open_questions: open_questions && open_questions.length > 0 ? open_questions : undefined,
    felt_intensity:
      typeof obj.felt_intensity === "number" ? clamp01(obj.felt_intensity) : undefined,
  };

  if (obj.suggest_new_thread && typeof obj.suggest_new_thread === "object") {
    const s = obj.suggest_new_thread as Record<string, unknown>;
    if (typeof s.title === "string" && typeof s.seed_question === "string") {
      artifact.suggest_new_thread = {
        title: s.title,
        seed_question: s.seed_question,
      };
    }
  }

  if (Array.isArray(obj.taste_nudges)) {
    artifact.taste_nudges = obj.taste_nudges
      .filter((n): n is Record<string, unknown> => !!n && typeof n === "object")
      .map((n) => ({
        dimension: n.dimension === "aesthetic" ? ("aesthetic" as const) : ("value" as const),
        statement: String(n.statement ?? ""),
        reason: String(n.reason ?? ""),
      }))
      .filter((n) => n.statement.length > 0);
  }

  return artifact;
}

export function assertArtifactUseful(artifact: ThoughtArtifact): void {
  const hasSummary = !!(artifact.refined_summary && artifact.refined_summary.trim());
  const hasQuestions = !!(artifact.open_questions && artifact.open_questions.length > 0);
  if (!hasSummary && !hasQuestions) {
    throw new ArtifactParseError(
      "refined_summary or open_questions must be non-empty to avoid empty contemplation",
    );
  }
}

function stripFences(raw: string): string {
  const m = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (m?.[1]) return m[1];
  return raw;
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
