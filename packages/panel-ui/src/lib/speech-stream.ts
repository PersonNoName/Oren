import type {
  LiveUtterance,
  SpeechEvent,
} from "./panel-types.js";

export function reduceSpeechEvent(
  current: readonly LiveUtterance[],
  event: SpeechEvent,
): readonly LiveUtterance[] {
  const index = current.findIndex(({ messageId }) => messageId === event.messageId);
  if (event.type === "speech.started") {
    if (index >= 0) return current;
    return [...current, {
      messageId: event.messageId,
      episodeId: event.episodeId,
      text: "",
      status: "streaming",
    }];
  }
  if (index < 0) return current;
  const existing = current[index]!;
  if (event.type === "speech.delta") {
    if (existing.status !== "streaming") return current;
    return current.map((item, candidate) =>
      candidate === index ? { ...item, text: item.text + event.text } : item);
  }
  if (existing.status !== "streaming") return current;
  return current.map((item, candidate) =>
    candidate === index ? { ...item, status: event.status } : item);
}
