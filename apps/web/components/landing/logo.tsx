import { EntryMark } from "@/components/entry-mark";

export function Logo({ className }: { readonly className?: string }) {
  return (
    <span
      aria-label="Entry Agent"
      className={`inline-flex items-center gap-2 whitespace-nowrap text-sm font-semibold tracking-tight leading-none ${className ?? ""}`}
    >
      <EntryMark className="h-full w-auto" />
      <span>Entry Agent</span>
    </span>
  );
}
