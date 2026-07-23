import { Type } from "typebox";

export const ProposalSchema = Type.Union([
  Type.Object({
    type: Type.Literal("NoAction"),
    reason: Type.String(),
  }, { additionalProperties: false }),
  Type.Object({
    type: Type.Literal("AdvanceThread"),
    threadId: Type.String(),
    summary: Type.String(),
  }, { additionalProperties: false }),
  Type.Object({
    type: Type.Literal("UpdateDisposition"),
    disposition: Type.String(),
    reason: Type.String(),
  }, { additionalProperties: false }),
  Type.Object({
    type: Type.Literal("ExpressToUser"),
    text: Type.String(),
    reason: Type.String(),
  }, { additionalProperties: false }),
  Type.Object({
    type: Type.Literal("ScheduleWake"),
    scheduleId: Type.String(),
    at: Type.String(),
    purpose: Type.String(),
  }, { additionalProperties: false }),
]);

export const CommitSchema = Type.Object({
  proposals: Type.Array(ProposalSchema, { maxItems: 16 }),
}, { additionalProperties: false });
