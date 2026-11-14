# SageStrike Android APK

The app includes a matched Capacitor 7 toolchain and an Android configuration (`appId: com.sagestrike.arena`). The web UI is fully responsive and uses Android safe-area insets.

## Build the debug APK

Prerequisites: a current JDK and Android SDK, with `ANDROID_HOME` configured.

The Capacitor `android/` native project is already generated and synced with `dist/`. After any web edits, re-sync and compile the APK:

```bash
npm run build
npx cap sync android
cd android
./gradlew assembleDebug # Windows: gradlew.bat assembleDebug
```

Output: `android/app/build/outputs/apk/debug/app-debug.apk`.

For a release APK, create a signing keystore, configure signing in `android/app/build.gradle`, and run `./gradlew assembleRelease`.

## Optional: ship an on-device model inside the APK

The bundled helper model (Qwen3.5-0.8B — the fast hints/dual-mode companion) can go into the APK so the app works on-device with **no first-run download**:

```bash
npm run fetch:model        # downloads the model into public/models/ (resumes if interrupted)
npm run build              # copies it into dist/, then into the APK's web assets
npx cap sync android       # → rebuild gradlew as above
```

This grows the APK by the model's size (~700–900 MB; the exact size is printed). Models are dist assets and need no asset-pack plumbing — direct APK distribution has no size cap. Models *not* fetched simply keep the existing download-on-first-use behavior, so this step is optional per model. Re-run `fetch:model` after upgrading `@mlc-ai/web-llm` so weights match the bundled engine.

## Device notes

- The quiz, progression, and offline hints work without WebGPU.
- WebLLM requires a WebGPU-capable Android System WebView and enough free GPU memory/storage. Qwen3.5 4B is the stronger default helper; Qwen3.5 2B or 0.8B can be selected for lower-memory devices. Llama 3.1 8B is intended for high-memory devices.
- The first WebLLM load downloads real model artifacts over the network — unless the model was bundled into the APK (see above), in which case it loads locally with no download. Later loads reuse WebLLM's persistent Cache API storage. Data Saver disables automatic startup downloads.
- Puter sign-in and OpenRouter require network access. OpenRouter keys remain on the device and are sent only to OpenRouter.
