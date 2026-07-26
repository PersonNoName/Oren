export type DeliverInput = {
  readonly deliveryId: string;
  readonly text: string;
  readonly reason: string;
  readonly proactive: boolean;
};

export type DeliverResult =
  | { readonly ok: true; readonly deliveredAt: string }
  | { readonly ok: false; readonly code: string; readonly message: string };

export interface ChannelPort {
  deliver(input: DeliverInput): Promise<DeliverResult>;
}

export type InboxMessage = DeliverInput & { readonly deliveredAt: string };
