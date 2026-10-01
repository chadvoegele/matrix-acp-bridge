import type { MessageDelivery } from "./config.js";

export type MessageDeliverySelection =
  | { readonly kind: MessageDelivery; readonly payload: string }
  | { readonly kind: "reset" }
  | { readonly kind: "usage"; readonly delivery: MessageDelivery; readonly message: string };

/**
 * Select delivery from an authorized, normalized body. Check input byte limits
 * against that original body before selection. Only a recognized command and
 * its separating whitespace are removed; ordinary text is preserved verbatim.
 */
export function selectMessageDelivery(body: string, defaultDelivery: MessageDelivery): MessageDeliverySelection {
  if (body === "/reset") {
    return { kind: "reset" };
  }

  const command = /^\/(prompt|steer)(?:\s+|$)/u.exec(body);
  if (command === null) {
    return { kind: defaultDelivery, payload: body };
  }

  const delivery = command[1] === "prompt" ? "prompt" : "steer";
  const payload = body.slice(command[0].length);
  if (payload.length === 0) {
    return { kind: "usage", delivery, message: `Usage: /${delivery} <message>` };
  }
  return { kind: delivery, payload };
}
