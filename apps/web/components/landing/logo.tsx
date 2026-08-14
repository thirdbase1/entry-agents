export function Logo({ className }: { readonly className?: string }) {
  return (
    <span
      aria-label="Entry Agent"
      className={`inline-flex items-center whitespace-nowrap text-sm font-semibold tracking-tight leading-none ${className ?? ""}`}
    >
      Entry Agent
    </span>
  );
}
