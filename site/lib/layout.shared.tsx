import Image from "next/image";
import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { appUrl, repoUrl } from "./shared";

/** Shared chrome for every layout. */
export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        // The ABX | FS lockup, black on the light theme and white on the dark (142 x 32 units, 22px high here).
        <span className="flex items-center">
          <Image src="/brand/abx-fs-lockup-black.svg" alt="ABX FS" width={142} height={32} unoptimized className="h-[22px] w-auto dark:hidden" />
          <Image src="/brand/abx-fs-lockup-white.svg" alt="ABX FS" width={142} height={32} unoptimized className="hidden h-[22px] w-auto dark:block" />
        </span>
      ),
    },
    githubUrl: repoUrl,
    links: [{ type: "main", text: "App", url: appUrl, external: true }],
  };
}
