type Tone = "protein" | "carbs" | "fat" | "default";
const TONES: Record<Tone, string> = {
  protein: "text-protein", carbs: "text-carbs", fat: "text-fat", default: "text-text",
};

export function StatTile({ label, value, tone = "default" }: { label: string; value: string; tone?: Tone }) {
  return (
    <div className="flex-1 rounded-md bg-surface border border-border px-2 py-2 text-center">
      <div className={`text-lg font-bold ${TONES[tone]}`}>{value}</div>
      <div className="text-[9px] uppercase tracking-wide text-muted">{label}</div>
    </div>
  );
}
