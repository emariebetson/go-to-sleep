import { signInPath } from "@/lib/auth";
import type { AppUser } from "@/lib/auth";

export function myNightsHref(user: AppUser | null) {
  return user ? "/library" : signInPath("/library");
}
