import { redirect } from "next/navigation";

/**
 * The plan catalog moved to /pricing (owner 2026-09-15: "make plan page
 * public and name to pricing"). Keep this route as a permanent redirect
 * so existing links -- the settings sidebar, in-chat upgrade CTAs,
 * Paystack callback flows, and anyone's bookmarks -- land correctly.
 */
export default function BillingPlansRedirect() {
  redirect("/pricing");
}
