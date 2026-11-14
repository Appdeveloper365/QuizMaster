/* Shared haptics helper — fires native haptic feedback on Android/iOS and is a
 * silent no-op on the web so it can be called from any shared code path. */
import { Capacitor } from "@capacitor/core";
import { Haptics, ImpactStyle, NotificationType } from "@capacitor/haptics";

export type HapticKind = "good" | "bad" | "click" | "win" | "tick" | "warning";

export function haptic(kind: HapticKind): void {
  if (!Capacitor.isNativePlatform()) return;
  try {
    if (kind === "good" || kind === "win") {
      void Haptics.notification({ type: NotificationType.Success });
    } else if (kind === "bad" || kind === "warning") {
      void Haptics.notification({ type: NotificationType.Error });
    } else {
      // click / tick
      void Haptics.impact({ style: ImpactStyle.Light });
    }
  } catch {
    /* haptics unavailable — ignore */
  }
}