import { redirect } from "next/navigation";
import { verifySession } from "@/lib/dal/session";

export default async function Home() {
  const session = await verifySession();
  redirect(session ? "/today" : "/login");
}
