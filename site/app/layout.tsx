import type { Metadata } from "next";
import { RootProvider } from "fumadocs-ui/provider/next";
import { Banner } from "fumadocs-ui/components/banner";
import { Manrope, Red_Hat_Mono } from "next/font/google";
import "./global.css";

// The brand's two families (SIL Open Font License), downloaded at build and served from this origin.
const sans = Manrope({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-sans-face", display: "swap" });
const mono = Red_Hat_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-mono-face", display: "swap" });

export const metadata: Metadata = {
  metadataBase: new URL("https://docs.fs.abx.io"),
  title: { default: "ABX FS | A place for files, on chain", template: "%s · ABX FS" },
  description:
    "A permissionless, content-addressed file system stored entirely on-chain. " +
    "Drop a folder, put it on chain, and serve it back out of contract storage.",
};

export default function Layout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${sans.variable} ${mono.variable}`}
      suppressHydrationWarning
    >
      <body className="flex min-h-screen flex-col">
        {/* Light (paper) or dark (ink) as the visitor's system prefers, with the toggle to override it; the app is
            dark only, in the same dark palette. */}
        <RootProvider theme={{ defaultTheme: "system" }}>
          {/* No `id`, so it cannot be dismissed: prerelease and unaudited is the standing state of the protocol. */}
          <Banner>
            <span>
              <strong>Prerelease.</strong> ABX FS is early, unaudited software. It may have bugs, and we do not
              guarantee it is bug-free. What you publish is public and permanent, and on production chains real funds
              are at risk.{" "}
              <a href="/docs/reference/deployments" className="underline underline-offset-2">
                Details
              </a>
            </span>
          </Banner>
          {children}
        </RootProvider>
      </body>
    </html>
  );
}
