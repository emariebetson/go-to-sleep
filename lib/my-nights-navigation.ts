import type { AppUser } from "@/lib/auth";
import { signInPath } from "@/lib/auth-navigation";

export function myNightsHref(user: AppUser | null) {
  return user ? "/library" : signInPath("/library");
}
