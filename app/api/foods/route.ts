import { NextResponse } from "next/server";

// Reserved boundary for USDA FoodData Central (a later phase). The FDC_API_KEY
// will be read server-side ONLY here; it is never sent to the client.
export async function GET() {
  return NextResponse.json(
    { error: "Food search is not implemented yet." },
    { status: 501 },
  );
}
