import type { ResponseMode } from "./config.js";
import type { MatrixEventId, MatrixRoomId } from "./matrix-client.js";

/** Session ownership only. An identity never grants sender or room access. */
export type ConversationIdentity =
  | { readonly kind: "room"; readonly roomId: MatrixRoomId }
  | { readonly kind: "thread"; readonly roomId: MatrixRoomId; readonly threadRootEventId: MatrixEventId };

/** Metadata shared by validated inbound routing and turn-related output. */
export interface ThreadRoutingMetadata {
  readonly threadRootEventId?: MatrixEventId;
}

/** Call only after authorization; top-level events become their own roots. */
export function conversationIdentityForEvent(
  event: ThreadRoutingMetadata & { readonly roomId: MatrixRoomId; readonly eventId: MatrixEventId },
  responseMode: ResponseMode,
): ConversationIdentity {
  return responseMode === "room"
    ? { kind: "room", roomId: event.roomId }
    : { kind: "thread", roomId: event.roomId, threadRootEventId: event.threadRootEventId ?? event.eventId };
}

/** A tuple encoding keeps mode, room and opaque event IDs unambiguous. */
export function conversationKey(identity: ConversationIdentity): string {
  return JSON.stringify(
    identity.kind === "room"
      ? [identity.kind, identity.roomId]
      : [identity.kind, identity.roomId, identity.threadRootEventId],
  );
}
