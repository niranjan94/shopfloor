import { serve } from "inngest/next";
import { inngest } from "../../../lib/inngest";
import { inngestFunctions } from "../../../lib/inngest-functions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Inngest serve endpoint. Register this URL in the Inngest dashboard
 * (or rely on auto-discovery via INNGEST_SIGNING_KEY on Vercel).
 *
 * Max duration must cover the longest stage step. Vercel Pro fluid/max
 * duration still won't hold 60m implement alone — implement should run
 * inside E2B (SHOPFLOOR_E2B_TEMPLATE) while this function awaits the sandbox.
 */
export const maxDuration = 300;

const handler = serve({
  client: inngest,
  functions: inngestFunctions,
});

export const GET = handler.GET;
export const POST = handler.POST;
export const PUT = handler.PUT;
