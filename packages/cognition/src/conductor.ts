import { createLifeFrame, type CreateFrameInput } from "./life-frame.js";

export class Conductor {
  public createFrame(input: CreateFrameInput) {
    return createLifeFrame(input);
  }
}
