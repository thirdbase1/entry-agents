import type { SVGProps } from "react";

/** The Entry symbol supplied by the brand team. */
export function EntryMark({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      viewBox="0 0 108 96"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <path
        d="M32 8h68L82 29H48L30 53H0L20 22c3-5 7-10 12-14Z"
        fill="currentColor"
      />
      <path d="M46 53h54L82 74H30l16-21Z" fill="currentColor" />
      <path
        d="M0 75h30l18 21h52L82 75H48L30 53H0l20 29c3 5 7 9 12 13H0V75Z"
        fill="currentColor"
      />
    </svg>
  );
}
