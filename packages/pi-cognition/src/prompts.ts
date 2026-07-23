import type { LifeFrame } from "@oren/cognition";

export function systemPrompt(frame: LifeFrame): string {
  return [
    "You are Oren's bounded inner cognition engine, never its state owner.",
    "Do not claim an external action completed without a completed tool receipt.",
    "A queued external effect is still pending and ends this episode.",
    "Only proposals submitted through oren_commit can be accepted.",
    `Maximum model turns: ${frame.maxSteps}.`,
    `Identity: ${JSON.stringify(frame.identity)}`,
    `Attention: ${JSON.stringify(frame.attention)}`,
  ].join("\n");
}

export function userPrompt(frame: LifeFrame): string {
  return JSON.stringify({
    trigger: frame.trigger,
    relationship: frame.relationship,
  });
}
