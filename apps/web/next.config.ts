import type { NextConfig } from "next";
import { withBotId } from "botid/next/config";
import { withWorkflow } from "workflow/next";

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "avatars.githubusercontent.com",
      },
      {
        protocol: "https",
        hostname: "vercel.com",
      },
      {
        protocol: "https",
        hostname: "*.vercel.com",
      },
    ],
  },
  experimental: {
    // PERF 2026-09-15: @lobehub/icons added -- the model picker's
    // provider icons and the brand tool renderer import ~15 icons from
    // the package root; without this directive the whole icon index
    // (hundreds of brand marks) can be pulled into the client bundle.
    optimizePackageImports: ["lucide-react", "@lobehub/icons"],
  },
  // SECURITY FIX (2026-08-27, pentest finding): the app shipped with
  // zero security-response headers at all (no CSP, no X-Frame-Options,
  // no X-Content-Type-Options, no Referrer-Policy) -- confirmed live
  // via curl against the deployed prod URL. Biggest concrete risk was
  // clickjacking: with no frame-ancestors/X-Frame-Options, the whole
  // app (including real agent actions -- spending credits, deleting
  // sessions, connecting integrations) could be iframed on a
  // malicious page for a UI-redress attack against a logged-in user.
  // Kept deliberately conservative here: frame-ancestors/X-Frame-Options
  // + nosniff + referrer-policy + a minimal permissions-policy are all
  // safe additions that can't break existing functionality. NOT adding
  // a script-src/style-src CSP in this pass -- the app relies on an
  // inline theme-init <script> (app/layout.tsx) and Next's own inline
  // chunks, so a strict script CSP needs its own careful pass (nonces
  // or hashing the inline script) with real testing before shipping,
  // rather than risking breaking prod to add defense-in-depth for a
  // hypothetical future XSS that hasn't been found.
  async headers() {
    return [
      // `entry-agents.dev` is canonical. Vercel already noindexes previews,
      // but the stable production `.vercel.app` alias needs the same signal
      // to avoid competing with the custom domain in search results.
      {
        source: "/:path*",
        has: [
          {
            type: "host",
            value: "entry-agents-second-chance-v2\\.vercel\\.app",
          },
        ],
        headers: [{ key: "X-Robots-Tag", value: "noindex" }],
      },
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          {
            key: "Referrer-Policy",
            value: "strict-origin-when-cross-origin",
          },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
        ],
      },
    ];
  },
};

export default withWorkflow(withBotId(nextConfig));
