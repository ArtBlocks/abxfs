import { DocsLayout } from "@fumadocs/base-ui/layouts/docs";
import { source } from "@/lib/source";
import { baseOptions } from "@/lib/layout.shared";

/**
 * The landing page is the overview, so it keeps the docs sidebar rather than a
 * separate marketing chrome — browsing should not require leaving it.
 */
export default function Layout({ children }: LayoutProps<"/">) {
  return (
    <DocsLayout tree={source.getPageTree()} {...baseOptions()}>
      {children}
    </DocsLayout>
  );
}
