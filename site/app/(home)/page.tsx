import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { appUrl } from "@/lib/shared";

const ENTRY_POINTS = [
  {
    href: "/docs/using-abxfs/quickstart",
    title: "Quickstart",
    body: "Upload a folder from the CLI and read it back through the gateway.",
  },
  {
    href: "/docs/using-abxfs/projects",
    title: "Projects",
    body: "A project is an NFT. Its owner publishes the versions; nobody else can.",
  },
  {
    href: "/docs/protocol",
    title: "Protocol",
    body: "How bytes become a CID, and why that CID is the same everywhere.",
  },
  {
    href: "/docs/reference/deployments",
    title: "Deployments",
    body: "Canonical addresses. Use these or your CIDs will not match anyone else's.",
  },
];

export default function HomePage() {
  return (
    <main className="relative isolate flex flex-1 flex-col">
      <section className="mx-auto w-full max-w-3xl px-6 pt-20 pb-16">
        <p className="font-mono text-xs uppercase tracking-[0.08em] text-fd-primary">A place for files. On chain.</p>
        <h1 className="mt-5 text-4xl font-medium sm:text-5xl">Drop a folder. Put it on chain.</h1>
        <p className="mt-5 max-w-xl text-lg text-fd-muted-foreground">
          ABX FS is a permissionless, content-addressed file system built and stored entirely on
          chain.
        </p>

        <div className="mt-8 flex flex-wrap items-center gap-3">
          <a
            href={appUrl}
            className="inline-flex items-center gap-2 rounded-md bg-fd-primary px-4 py-2 text-sm font-semibold text-fd-primary-foreground transition-opacity hover:opacity-90"
          >
            Open the app <ArrowRight className="size-4" aria-hidden />
          </a>
          <Link
            href="/docs/using-abxfs/quickstart"
            className="inline-flex items-center gap-2 rounded-md border border-fd-border px-4 py-2 text-sm font-semibold transition-colors hover:bg-fd-muted"
          >
            Quickstart
          </Link>
        </div>
      </section>

      <section className="mx-auto mb-20 grid w-full max-w-3xl gap-px overflow-hidden rounded-lg border border-fd-border bg-fd-border px-0 sm:grid-cols-2">
        {ENTRY_POINTS.map((entry) => (
          <Link
            key={entry.href}
            href={entry.href}
            className="group bg-fd-background p-5 transition-colors hover:bg-fd-muted"
          >
            <span className="flex items-center gap-1.5 font-semibold">
              {entry.title}
              <ArrowRight
                className="size-3.5 opacity-0 transition-opacity group-hover:opacity-70"
                aria-hidden
              />
            </span>
            <span className="mt-1.5 block text-sm text-fd-muted-foreground">{entry.body}</span>
          </Link>
        ))}
      </section>

      {/*
        Infrastructure credit, per ABX's brand kit. Both lockups ship and CSS picks one, because
        this site has a light and a dark theme and the guidance is to use whichever has the
        stronger contrast. Served from this origin rather than hotlinked, as the kit asks.
      */}
      <footer className="mx-auto mt-14 mb-20 flex w-full max-w-3xl px-6">
        <a
          href="https://abx.io"
          target="_blank"
          rel="noreferrer"
          aria-label="Built on ABX"
          className="transition-opacity hover:opacity-80"
        >
          <img
            src="/brand/built-on-abx-light.svg"
            alt="Built on ABX"
            width={180}
            height={56}
            className="h-10 w-auto dark:hidden"
          />
          <img
            src="/brand/built-on-abx-dark.svg"
            alt="Built on ABX"
            width={180}
            height={56}
            className="hidden h-10 w-auto dark:block"
          />
        </a>
      </footer>

    </main>
  );
}
