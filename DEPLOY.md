# Deploying Crema

Crema runs entirely on the DE1 tablet — you do **not** need a server or a Mac. This
guide covers the normal tablet install, the desktop dev loop, and (for advanced users)
the optional local-server mode.

## 1. Build the bundle

```bash
./build.sh
```

This writes a clean `dist/Crema/` and `dist/Crema.zip`, stripping developer-only state
(the maintainer's settings, the desktop screen-size cache, and the test rigs) so the
skin boots into first-run defaults: standalone mode, dark theme, setup wizard.

## 2. Install on the DE1 tablet

The skin is one folder: `dist/Crema/`. Copy it into the DE1 app's skins directory
(`de1plus/skins/Crema/`). On stock Decent tablets the app's data folder is on internal
storage, e.g. `/sdcard/de1plus/` — find the folder that contains `skins/Insight`.

Easiest paths:
- **adb** (enable USB debugging in Android settings):
  ```bash
  adb push dist/Crema /sdcard/de1plus/skins/Crema
  ```
- or copy the folder via a file-manager app / USB stick.

Then in the DE1 app: **Settings → App → Skin → Crema**, and restart the app.

## 3. First run

On first launch Crema shows the **Set up Crema** wizard:

1. **Grinder** — your grinder's name (e.g. `Lagom 01`, `DF64`, `Encore ESP`). The AI
   phrases advice in its units.
2. **AI provider** — pick one and enter its key (or base URL). See the provider table
   in [README.md](README.md#choosing-a-provider). The key is stored only on this tablet.

Tap **Save & continue**. You can change any of this later in **Settings → AI setup**.

## 4. Everyday flow

1. Pull a shot. When it ends, the **How was that shot?** card appears — four taps
   (taste / body / flow / finish + a 1–5 score), then **Get advice**.
2. The advice card shows the AI's diagnosis ~15–60s later. One tap applies the grind
   change, recipe tweak, or profile switch.
3. **Shots** on the home screen shows your recent history: grind, time, ratio, taste,
   score, and what the advisor said — all stored locally on the tablet.

If a request fails (bad key, no network), the questionnaire still works and the shot is
still saved; the advice card shows the error instead of blocking.

## 5. Desktop dev loop

The skin is developed against a desktop checkout of
[de1app](https://github.com/decentespresso/de1app). `skins/Crema` in that checkout is a
symlink to this repo's `skin/Crema`.

```bash
./dev.sh                                        # launch the simulator with Crema
CREMA_SELFTEST=1 CREMA_STANDALONE=1 ./dev.sh    # full end-to-end self-test
CREMA_DEVSHOT=setup ./dev.sh                    # capture wizard screenshots to /tmp/crema_pages
```

The standalone self-test needs a mock provider endpoint on `localhost:8877` (the
bundled server doubles as one — see below). Results land in `../de1app/de1plus/log.txt`:

```bash
grep -E 'CREMA-SELFTEST|CREMA-DEVSHOT' ../de1app/de1plus/log.txt
```

## 6. Optional: local Mac-server mode (advanced)

If you have a Claude **Pro or Max** subscription and would rather not pay per API call,
Crema can route advice through the `claude` CLI running on your own Mac. In the setup
wizard pick **Local Mac server** and set the advisor URL to your Mac's LAN address.
(It's wired to the `claude` CLI today; routing other subscription CLIs like OpenAI's
Codex or the Gemini CLI is a small adapter away — see issue #4.)

Run the server:

```bash
cd server
uv run uvicorn advisor.main:app --host 0.0.0.0 --port 8877
```

For a persistent install, a LaunchAgent plist template is provided at
`server/com.crema.advisor.plist`. **Edit it first** and replace the three
placeholders with your own paths: `__UV_PATH__` (run `which uv`),
`__INSTALL_DIR__` (where you cloned this repo), and `__HOME__` (`echo $HOME`).
Then:

```bash
cp server/com.crema.advisor.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.crema.advisor.plist
curl -s localhost:8877/health          # {"ok":true,...}
```

Headless `claude -p` needs auth without a login session: run `claude setup-token` once
and put `CLAUDE_CODE_OAUTH_TOKEN=...` in `server/.env` (gitignored). Find the Mac's LAN
IP with `ipconfig getifaddr en0`. If macOS firewall prompts about incoming connections
for `uv`/`python`, allow it. Stop the service with
`launchctl bootout gui/$(id -u)/com.crema.advisor`.

The same server also exposes `/v1/messages` and `/v1/chat/completions` mock endpoints
(backed by the `claude` CLI) used by the standalone self-test, so the direct-provider
code path can be exercised without spending on a metered key.
