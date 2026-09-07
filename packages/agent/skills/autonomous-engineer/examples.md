# Autonomous Engineer Examples

## Feature

> Build GitHub issue importing and verify the complete flow.

Use the full loop: inspect existing GitHub integration, implement the smallest compatible change, add regression coverage, run checks, exercise the flow when possible, then prepare delivery.

## Bug

> The session stream sometimes duplicates messages after reconnecting. Find and fix the root cause.

Use Forensics mode: reproduce or trace the reconnect path, identify the lifecycle problem, fix the cause, add a regression test, and verify reconnection behavior.

## UI

> Improve the settings page without redesigning it.

Audit the existing visual language first. Fix concrete usability/accessibility/responsive issues and preserve established components, spacing, typography, and interaction patterns.

## Audit

> Audit authentication and fix any high-confidence security issues you find.

Inspect the authentication boundary, input handling, session lifecycle, authorization checks, and relevant tests. Prioritize evidence-backed issues and verify every fix.

## Production readiness

> Make this endpoint production-ready.

Inspect validation, authorization, errors, retries, observability, tests, and failure modes. Implement only changes justified by the endpoint's actual behavior and surrounding conventions.