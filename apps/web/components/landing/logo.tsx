import { EntryMark } from "@/components/entry-mark";

export function Logo({ className }: { readonly className?: string }) {
  return (
    <span
      aria-label="Entry Agents"
      className={`inline-flex items-center gap-2 whitespace-nowrap text-sm font-semibold tracking-tight leading-none ${className ?? ""}`}
    >
      <EntryMark className="size-5 shrink-0" />
      <span>Entry Agents</span>
    </span>
  );
}
