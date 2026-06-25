export type InstallState = "hidden" | "ios-hint" | "chromium-button";

/** Decide which install affordance (if any) to show. Pure → unit-testable.
 *  Precedence: installed/dismissed win; a captured prompt beats the iOS hint. */
export function getInstallState(env: {
  standalone: boolean;   // display-mode standalone OR iOS navigator.standalone
  isIosSafari: boolean;  // iOS + Safari (no beforeinstallprompt support)
  canPrompt: boolean;    // a beforeinstallprompt event was captured
  dismissed: boolean;    // user dismissed our affordance (persisted)
}): InstallState {
  if (env.standalone || env.dismissed) return "hidden";
  if (env.canPrompt) return "chromium-button";
  if (env.isIosSafari) return "ios-hint";
  return "hidden";
}
