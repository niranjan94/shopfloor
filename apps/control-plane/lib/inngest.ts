import { Inngest } from "inngest";

/** Shared Inngest client for enqueue + serve. */
export const inngest = new Inngest({
  id: "shopfloor-control-plane",
  name: "Shopfloor control plane",
});
