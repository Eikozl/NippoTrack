# NippoTrack Android release (sideload APK, no Play Store)

How the installable Android app is built, signed, published, and updated.
Start here before touching anything Android-related.

## 1. How it works (30 seconds)

- The APK is a Capacitor shell around the production web build. Same
  account, same data, same backend — the server cannot tell the APK apart
  from a browser tab.
- A GitHub Release (tag `vX.Y.Z`) triggers `android-release.yml`, which
  builds the web bundle, syncs it into `client/android`, compiles a signed
  release APK, and attaches `nippotrack-vX.Y.Z.apk` (+ `.sha256`) to the
  release. The landing page and the in-app Settings banner link there.
- No Play Store involvement at any point.

## 2. One-time setup (owner only, ~1 hour)

### 2.1 Keystore — do this first, do it once, back it up
The keystore signs every APK. **Losing it means no future update can ever
be installed over the current app** — Android rejects differently-signed
updates and users would have to reinstall from scratch (losing nothing
server-side, but losing the seamless path).

On your own PC (needs Java 21 installed — the Capacitor 8 libraries compile
with source release 21, so JDK 17 is not enough):

```powershell
keytool -genkeypair -v -keystore nippotrack-release.keystore `
  -alias nippotrack -keyalg RSA -keysize 2048 -validity 10950 `
  -storepass <STORE_PASSWORD> -keypass <KEY_PASSWORD> `
  -dname "CN=NippoTrack"
```

What each thing is and why:
- `nippotrack-release.keystore` — the private signing key file. NEVER
  commit it (it is git-ignored via `*.keystore`). Copy it to a USB drive
  kept offline, plus one encrypted backup elsewhere.
- `-validity 10950` — 30 years, so the key never expires mid-product.
- `alias nippotrack` — must match `KEY_ALIAS` below, exactly.
- The two passwords go to GitHub Secrets, never to chat, docs, or code.

Convert it for GitHub (PowerShell):

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("nippotrack-release.keystore")) | Set-Content keystore.b64
```

### 2.2 GitHub Secrets (repository Settings → Secrets → Actions)
| Secret | Value | Why |
|---|---|---|
| `ANDROID_KEYSTORE_BASE64` | contents of `keystore.b64` | CI decodes it back into the signing key at build time |
| `KEYSTORE_PASSWORD` | `<STORE_PASSWORD>` | unlocks the keystore file |
| `KEY_ALIAS` | `nippotrack` | selects the key inside the file |
| `KEY_PASSWORD` | `<KEY_PASSWORD>` | unlocks the private key |

### 2.3 Vercel env var (dashboard → project → Environment Variables)
| Variable | Value | Why |
|---|---|---|
| `JLT_ALLOWED_ORIGINS` | `https://nippotrack.vercel.app,capacitor://localhost` | The APK's WebView sends `Origin: capacitor://localhost`; without this entry every API preflight gets 403. Redeploy after adding it. |

> If the Capacitor hostname ever changes in `client/capacitor.config.ts`
> (`server.hostname`), this variable must change with it. They are a pair.

## 3. Releasing a version (recurring, ~10 minutes of your time)

1. Bump nothing by hand: the workflow derives `versionName`/`versionCode`
   from the tag. Tags MUST be `vX.Y.Z` (e.g. `v1.0.0`); anything else fails
   the build loudly on purpose.
2. GitHub → Releases → Draft a new release → tag `vX.Y.Z` → Publish.
3. Wait for the `Android release` workflow to go green (~10–15 min first
   run: Android SDK download dominates; later runs are faster via cache).
4. Download the APK from the release page, verify it installs over the
   previous version keeping session + data, spot-check login → review
   with sound → avatar upload → tutorial video.
5. Announce in-app automatically: Settings → Account shows the banner once
   the release is published (the app polls the public releases API).

## 4. Sideload copy for users (shown on the landing page)

> Open the downloaded file and allow installs from this source when Android
> asks. To update later, download the new version and install it over the
> current one — your data is kept.

Play Protect may show a warning ("unknown developer") — expected without
Play Store; the SHA-256 published next to each APK lets anyone verify the
file byte-for-byte.

## 5. Auth behavior on the APK (v1 scope)

- Email + password login works fully inside the app (session in WebView
  localStorage, same as browsers).
- Confirmation / recovery email links open the system browser. The user
  confirms there, then signs in inside the app. No code change was needed
  for v1; native deep links (`app://`) are a documented future upgrade.
- No push notifications exist in the product, so none are lost.

## 6. Troubleshooting

| Symptom | Likely cause |
|---|---|
| API 403s only inside the APK | `JLT_ALLOWED_ORIGINS` missing the WebView origin (§2.3) |
| Workflow fails on tag step | tag is not `vX.Y.Z` |
| `INSTALL_FAILED_UPDATE_INCOMPATIBLE` on update | APK signed with a different keystore — stop and find the original key (§2.1); never ship this build |
| SHA-256 mismatch on download | re-download (proxy/antivirus mangling); if it persists, treat the file as untrusted |
| White screen on old devices | Android System WebView outdated — update it from Play Store (works without a Play account for system components on most devices) |

## 7. What lives where (maintainers)

- `client/capacitor.config.ts` — shell identity (`app.nippotrack.tracker`), secure scheme + hostname.
- `client/android/` — generated native project (committed except `app/src/main/assets`, regenerated by `cap sync`).
- `client/.env.capacitor` — documents the APK build env (`VITE_API_BASE_URL`, `APP_VERSION`); values flow via CI env, the file itself only pins the contract.
- `client/public/{manifest.webmanifest,sw.js,offline.html,icons/}` — PWA layer (also used by plain mobile browsers).
- `client/src/appUpdate.js` — version compare + release check (unit-tested).
- `client/src/landing/androidRelease.js` — landing hydration (fail-open).
- `.github/workflows/android-release.yml` — the release machine.
