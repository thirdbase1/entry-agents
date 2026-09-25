import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Analytics } from "@vercel/analytics/next";
import { Providers } from "./providers";
import { SITE_URL } from "@/lib/site";
import {
  LEGACY_THEME_STORAGE_KEY,
  THEME_STORAGE_KEY,
} from "@/lib/theme-storage";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const themeInitializationScript = `
(() => {
  const storageKey = "${THEME_STORAGE_KEY}";
  const legacyStorageKey = "${LEGACY_THEME_STORAGE_KEY}";
  const darkModeMediaQuery = "(prefers-color-scheme: dark)";

  // One-time migration off the pre-rename key, so an existing light/dark
  // choice survives the rename (runs before hydration, ahead of React).
  let storedTheme = window.localStorage.getItem(storageKey);
  if (storedTheme === null) {
    storedTheme = window.localStorage.getItem(legacyStorageKey);
    if (storedTheme !== null) {
      window.localStorage.setItem(storageKey, storedTheme);
      window.localStorage.removeItem(legacyStorageKey);
    }
  }

  const theme =
    storedTheme === "light" || storedTheme === "dark" || storedTheme === "system"
      ? storedTheme
      : "system";

  const resolvedTheme =
    theme === "system"
      ? window.matchMedia(darkModeMediaQuery).matches
        ? "dark"
        : "light"
      : theme;

  document.documentElement.classList.toggle("dark", resolvedTheme === "dark");
})();
`;

const isPreviewDeployment = process.env.VERCEL_ENV === "preview";
const faviconPath = isPreviewDeployment
  ? "/favicon-preview.svg"
  : "/favicon.ico";
const metadataBase =
  process.env.VERCEL_ENV === "production" &&
  process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? new URL(`https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`)
    : process.env.VERCEL_URL
      ? new URL(`https://${process.env.VERCEL_URL}`)
      : new URL(SITE_URL);

export const metadata: Metadata = {
  metadataBase,
  title: {
    // The exact-match phrase first: "entry agent" / "entry agents" is the
    // query this domain is meant to own, and a bare product name gave
    // crawlers nothing about what the product is.
    default: "Entry Agents — AI coding agents that ship real code",
    template: "%s | Entry Agents",
  },
  description:
    "Entry Agents is a cloud platform for AI coding agents. Each agent gets an isolated sandbox with filesystem, network and runtime access, and works autonomously until the job is done — no local setup.",
  applicationName: "Entry Agents",
  icons: {
    icon: faviconPath,
    shortcut: faviconPath,
  },
  openGraph: {
    type: "website",
    siteName: "Entry Agents",
    url: SITE_URL,
    title: "Entry Agents — AI coding agents that ship real code",
    description:
      "Entry Agents is a cloud platform for AI coding agents. Each one gets an isolated sandbox and ships real code autonomously.",
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: "Entry Agents — AI coding agents that ship real code",
    description:
      "Entry Agents is a cloud platform for AI coding agents. Each one gets an isolated sandbox and ships real code autonomously.",
  },
};

/**
 * Structured data so crawlers can tell what this is.
 *
 * There was none before. Job boards (Indeed, FlexJobs) own the plain
 * phrase "entry agent" because it reads as a job title; declaring the
 * entity as software is the on-page signal that it is a product instead.
 * No SearchAction: the site has no query endpoint to point one at, and
 * markup that promises a URL Google cannot load is worse than none.
 */
const structuredData = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      name: "Entry Agents",
      url: SITE_URL,
      logo: `${SITE_URL}/entry-logo.svg`,
    },
    {
      "@type": "WebSite",
      name: "Entry Agents",
      url: SITE_URL,
    },
    {
      "@type": "SoftwareApplication",
      name: "Entry Agents",
      applicationCategory: "DeveloperApplication",
      applicationSubCategory: "AI coding agent platform",
      operatingSystem: "Web",
      url: SITE_URL,
      featureList: [
        "AI coding agents for repository tasks",
        "Isolated cloud sandboxes",
        "Git branches, commits, and pull requests",
        "Durable multi-step agent workflows",
      ],
      description:
        "Cloud platform for AI coding agents: each agent runs in an isolated sandbox with filesystem, network and runtime access and ships code autonomously.",
    },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} font-sans overflow-x-hidden antialiased`}
      >
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
        />
        <script
          dangerouslySetInnerHTML={{ __html: themeInitializationScript }}
        />
        <Providers>{children}</Providers>
        <Analytics />
      </body>
    </html>
  );
}
