import { getDay } from "@/lib/dal/logged-foods";
import { dateParamSchema } from "@/lib/validation/log";
import { NormalizeDate } from "./_redirect";
import { DateNav } from "./DateNav";
import { TodayView } from "./TodayView";
import { NutritionPanel } from "./NutritionPanel";

export default async function TodayPage({ searchParams }: { searchParams: Promise<{ date?: string }> }) {
  const { date } = await searchParams;
  const parsed = date ? dateParamSchema.safeParse(date) : null;
  if (!parsed?.success) return <NormalizeDate />; // no/invalid date → set local today client-side

  const day = await getDay(parsed.data);
  return (
    <main>
      <DateNav date={parsed.data} />
      <TodayView data={day} />
      <NutritionPanel totals={day.totals} />
    </main>
  );
}
