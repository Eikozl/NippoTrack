import type { CapacitorConfig } from '@capacitor/cli';

// Native Android shell for NippoTrack (sideloaded APK, no Play Store).
// The shell loads the production web build; all data and auth stay remote.
// - androidScheme https keeps the WebView on a secure origin so
//   Secure-context APIs behave like the browser build.
// - The API base URL comes from the Capacitor web build env
//   (client/.env.capacitor), never from this file.
const config: CapacitorConfig = {
  appId: 'app.nippotrack.tracker',
  appName: 'NippoTrack',
  webDir: 'dist',
  android: {
    allowMixedContent: false
  },
  server: {
    androidScheme: 'https',
    hostname: 'nippotrack.app'
  }
};

export default config;
