import type { Channel } from "@pa/shared-types";
import type { Deliverer } from "@pa/intervention-service";

/**
 * Stub push deliverer (spec §23.8 MessagingService). Stands in for the real
 * APNs/FCM adapter: it does NOT talk to Apple — it records each delivery in
 * memory and returns a synthetic delivery id. This is what lets the whole
 * usage → engine → alarm path run and be tested end-to-end without device
 * infrastructure or secrets. The real APNs integration replaces this class with
 * an identical `Deliverer` surface (see NG-2 of COD-1).
 */
export interface DeliveryRecord {
  channel: Channel;
  text: string;
  sessionId: string;
  deliveryId: string;
  at: string; // ISO — when this stub accepted the delivery
}

export class PushDeliverer implements Deliverer {
  private deliveries: DeliveryRecord[] = [];
  private seq = 0;

  async deliver(input: {
    channel: Channel;
    text: string;
    sessionId: string;
  }): Promise<{ deliveryId: string }> {
    const deliveryId = `push_${++this.seq}`;
    this.deliveries.push({
      channel: input.channel,
      text: input.text,
      sessionId: input.sessionId,
      deliveryId,
      at: new Date().toISOString(),
    });
    return { deliveryId };
  }

  /** Read helper for tests / telemetry — not part of the `Deliverer` port. */
  all(): DeliveryRecord[] {
    return [...this.deliveries];
  }
}
