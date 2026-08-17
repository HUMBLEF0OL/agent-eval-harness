export type OrderState =
  | "draft"
  | "submitted"
  | "approved"
  | "rejected"
  | "shipped";

export type OrderEvent = "submit" | "approve" | "reject" | "ship";

export function transition(state: OrderState, event: OrderEvent): OrderState {
  if (state === "draft") {
    if (event === "submit") return "submitted";
    if (event === "reject") return "rejected";
  } else if (state === "submitted") {
    if (event === "approve") return "approved";
    if (event === "reject") return "rejected";
  } else if (state === "approved") {
    if (event === "ship") return "shipped";
  }
  throw new Error(`cannot ${event} from ${state}`);
}
