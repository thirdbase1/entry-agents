import { ExternalLink } from "lucide-react";
import { BENCHMARK_TRACKS } from "./benchmark-catalog";

export function BenchmarkOverview() {
  return (
    <div className="grid gap-px overflow-hidden border border-(--l-border) bg-(--l-border) sm:grid-cols-2 lg:grid-cols-4">
      {BENCHMARK_TRACKS.map((track) => (
        <a
          key={track.key}
          href={track.source}
          target="_blank"
          rel="noreferrer"
          className="group bg-(--l-bg) p-5 transition-colors hover:bg-(--l-fg-6)"
        >
          <div className="mb-5 flex items-center justify-between">
            <span
              className="size-2 rounded-full"
              style={{ backgroundColor: track.color }}
            />
            <ExternalLink className="size-3.5 text-(--l-fg-3) transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
          </div>
          <div className="text-sm font-medium">{track.name}</div>
          <p className="mt-2 min-h-10 text-xs leading-relaxed text-(--l-fg-3)">
            {track.description}
          </p>
          <div className="mt-4 text-[10px] font-medium uppercase tracking-wider text-(--l-fg-3)">
            {track.metric}
          </div>
        </a>
      ))}
    </div>
  );
}
