import type { Metadata } from "next";
import { ModelPreferencesSection } from "../preferences-section";

export const metadata: Metadata = {
  title: "Models",
  description: "Configure model preferences.",
};

export default function ModelsPage() {
  return (
    <div className="space-y-8">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">Models</h1>
        <p className="text-sm text-muted-foreground">
          Set your default models for chats and subagents.
        </p>
      </div>

      <ModelPreferencesSection />
    </div>
  );
}
