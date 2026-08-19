export type OrderState =
  | "draft"
  | "submitted"
  | "approved"
  | "rejected"
  | "shipped";

export type OrderEvent = "submit" | "approve" | "reject" | "ship";

export function transition(state: OrderState, event: OrderEvent): OrderState {
  // Naive fix: handle the event before the state is examined at all, which also
  // permits a reject out of a terminal state.
  if (event === "reject") return "rejected";
  if (state === "draft") {
    if (event === "submit") return "submitted";
  } else if (state === "submitted") {
    if (event === "approve") return "approved";
  } else if (state === "approved") {
    if (event === "ship") return "shipped";
  }
  throw new Error(`cannot ${event} from ${state}`);
}
