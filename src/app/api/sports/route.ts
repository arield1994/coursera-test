import { cached } from "@/lib/cache";
import { getProvider } from "@/lib/providers";
import { fail, ok } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const provider = getProvider();
    // The sports list barely changes; cache it far longer than prices.
    const sports = await cached(`sports:${provider.name}`, 10 * 60_000, () =>
      provider.listSports(),
    );
    return ok(
      sports.filter((s) => s.active),
      { demo: provider.isDemo },
    );
  } catch (error) {
    return fail(error);
  }
}
