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
  Type.Object({
    type: Type.Literal("Remember"),
    text: Type.String(),
    kind: Type.Union([
      Type.Literal("user_statement"),
      Type.Literal("external_fact"),
      Type.Literal("oren_judgment"),
      Type.Literal("oren_expression"),
    ]),
    confidence: Type.Optional(Type.Number()),
    reviewCondition: Type.Optional(Type.String()),
    threadId: Type.Optional(Type.String()),
  }, { additionalProperties: false }),
  Type.Object({
    type: Type.Literal("ReviseBelief"),
    memoryId: Type.String(),
    revisedText: Type.Optional(Type.String()),
    confidence: Type.Number(),
    reason: Type.String(),
  }, { additionalProperties: false }),
  Type.Object({
    type: Type.Literal("Forget"),
    memoryId: Type.String(),
    reason: Type.String(),
  }, { additionalProperties: false }),
]);

export const CommitSchema = Type.Object({
  proposals: Type.Array(ProposalSchema, { maxItems: 16 }),
}, { additionalProperties: false });
