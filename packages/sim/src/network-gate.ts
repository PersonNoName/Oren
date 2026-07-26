import type { ChannelPort, DeliverInput, DeliverResult } from "@oren/channel";
import type { WebPort } from "@oren/web";

export type NetworkGate = {
  failing: boolean;
  web: boolean;
  channel: boolean;
};

export class GatedWebPort implements WebPort {
  public constructor(
    private readonly inner: WebPort,
    private readonly gate: NetworkGate,
  ) {}

  public async search(input: { query: string; limit: number }) {
    if (this.gate.failing && this.gate.web) {
      throw new Error("sim_network_fault");
    }
    return this.inner.search(input);
  }

  public async read(input: { url: string }) {
    if (this.gate.failing && this.gate.web) {
      throw new Error("sim_network_fault");
    }
    return this.inner.read(input);
  }
}

export class GatedChannelPort implements ChannelPort {
  public constructor(
    private readonly inner: ChannelPort,
    private readonly gate: NetworkGate,
  ) {}

  public async deliver(input: DeliverInput): Promise<DeliverResult> {
    if (this.gate.failing && this.gate.channel) {
      return {
        ok: false,
        code: "sim_network_fault",
        message: "simulated channel network fault",
      };
    }
    return this.inner.deliver(input);
  }
}
