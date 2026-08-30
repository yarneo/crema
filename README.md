# Crema ☕

A skin for the [Decent DE1](https://decentespresso.com/) espresso machine that turns
every shot into a coaching session. Pull a shot, answer four taps about how it tasted,
and an AI barista reads your pressure/flow/weight curves and tells you exactly what to
change next — grind, dose, yield, temperature, or a whole new profile it can apply for
you in one tap.

It runs **entirely on the tablet**. You bring an API key from any major AI provider;
Crema talks to it directly over your wifi. No companion app, no server, no account.

> ⚠️ **Work in progress.** Crema is used daily on a real machine, but it's young and
> bugs still surface. If you hit one, please [open an issue](../../issues) — and if
> you'd like to help build it, see [Contributing](#contributing). PRs very welcome.

<table>
  <tr>
    <td width="33%" valign="top"><img src="docs/screenshots/1-brew.png" alt="Brew screen with live shot graph"><br><sub><b>1 · Pull a shot.</b> Calm home screen with your live graph, grind number, bean, and ratio.</sub></td>
    <td width="33%" valign="top"><img src="docs/screenshots/3-taste-check.png" alt="Taste questionnaire"><br><sub><b>2 · Rate it in ~10s.</b> Four taps: taste, body, flow look, finish, and a 1–5 score.</sub></td>
    <td width="33%" valign="top"><img src="docs/screenshots/4-ai-advice.png" alt="AI dial-in advice"><br><sub><b>3 · Get one clear move.</b> A diagnosis plus the single highest-payoff change — tap <b>Apply</b>.</sub></td>
  </tr>
</table>

## What it does

- **Beautiful shot visualization** — a dark, calm home screen with your live shot
  graph, grind number, bean, and ratio front and center.
- **Post-shot coaching** — a ≤10-second questionnaire (taste, body, flow look,
  finish, 1–5 score) feeds the AI along with the actual shot curves.
- **One clear instruction** — advice comes back as a diagnosis plus *one* concrete
  move, phrased in your grinder's own dial numbers. Tap to apply the grind change,
  recipe tweak, or profile switch; Crema updates the machine for you.
- **Custom profiles on demand** — when the fix is structural (bloom longer, decline
  pressure), the AI writes a full D-Flow profile and Crema installs it as its own
  bean-specific profile.
- **Shot history** — every shot, its taste notes, and the advice you got, stored
  locally on the tablet. The AI reads your history so its advice compounds over time.

## A quick tour

<table>
  <tr>
    <td width="50%" valign="top"><img src="docs/screenshots/2-live-shot.png" alt="Live shot in progress"><br><sub><b>Live shot</b> — pressure, flow, and weight drawn in real time against the profile target.</sub></td>
    <td width="50%" valign="top"><img src="docs/screenshots/7-beans-and-grind.png" alt="Beans and grind page"><br><sub><b>Beans &amp; grind</b> — a small bean library; each bean remembers its own grind, dose, and dialed-in profile.</sub></td>
  </tr>
  <tr>
    <td width="50%" valign="top"><img src="docs/screenshots/5-shot-history.png" alt="Shot history list"><br><sub><b>Shot history</b> — every shot with its taste score and the advice you were given.</sub></td>
    <td width="50%" valign="top"><img src="docs/screenshots/6-shot-detail.png" alt="Single shot detail"><br><sub><b>Shot detail</b> — replay any past shot's curves and re-read (or ask for) its advice.</sub></td>
  </tr>
  <tr>
    <td width="50%" valign="top"><img src="docs/screenshots/8-setup.png" alt="First-run setup wizard"><br><sub><b>Setup wizard</b> — two things on first launch: your grinder, and your AI provider + key.</sub></td>
    <td width="50%" valign="top"></td>
  </tr>
</table>

## Install (5 minutes)

You need: a Decent DE1 with the standard Android tablet, and an API key from one AI
provider (see [Choosing a provider](#choosing-a-provider)).

1. **Get the skin.** Download `Crema.zip` from the
   [latest release](../../releases/latest) (or run `./build.sh` to make it yourself).
2. **Copy it to the tablet.** Unzip so you have a `Crema` folder, then put it in the
   DE1 app's `skins/` directory. The easy way, with the tablet in USB-debugging mode:
   ```bash
   adb push Crema /sdcard/de1plus/skins/Crema
   ```
   (Or copy the folder over with a USB stick / file manager — see [DEPLOY.md](DEPLOY.md).)
3. **Select it.** In the DE1 app: **Settings → App → Skin → Crema**, then restart the app.
4. **Run the setup wizard.** On first launch Crema asks for two things — your grinder
   and your AI provider + key. That's it. Pull a shot.

## Choosing a provider

Crema works with any of these. Your key is stored only on your tablet.

| Provider | You need | Cost per shot | Notes |
|----------|----------|---------------|-------|
| **Anthropic (Claude)** | Key from [console.anthropic.com](https://console.anthropic.com) | ~1–2¢ | Default. Best-tasting advice in testing. |
| **OpenAI (GPT)** | Key from [platform.openai.com](https://platform.openai.com) | ~1–2¢ | |
| **OpenAI-compatible** | A base URL + model | Free if local | Ollama, LM Studio, OpenRouter, etc. Run a model on your own machine for zero cost. |
| **Local Mac server** | The bundled advisor server | Free w/ Claude Pro/Max | Advanced. Routes through the `claude` CLI on your Mac so shots draw on a Claude **Pro or Max** subscription instead of per-call billing. See [DEPLOY.md](DEPLOY.md). |

You can change provider or key any time in **Settings → AI setup**.

> **On subscriptions:** you don't need one — the normal path is a metered key (a cent or
> two per shot) or a free local model. The Mac-server mode is a bonus for people who
> already pay for **Claude Pro/Max**. It ships wired to the `claude` CLI today; other
> subscription CLIs (OpenAI's Codex with a ChatGPT plan, Gemini CLI, etc.) are a small
> adapter away — tracked in [#4](../../issues/4). Note a *ChatGPT Plus* subscription
> can't be used directly as a metered key; for OpenAI, use a pay-as-you-go API key.

### 💡 The model matters — a lot

The advice is only as good as the model behind it. In our testing the gap was large:
a top-tier model like **Claude Opus** (or GPT-5) gives noticeably sharper, better-reasoned
dial-in advice than a smaller or cheaper model like **o4-mini** — it reads the curve
shape more carefully, sizes the move to your grinder correctly, and knows when to *leave
the grind alone* and change something else instead. Smaller models still work and are
fine for quick daily tweaks, but if the advice ever feels generic or over-eager, **switch
to the strongest model your provider offers** before anything else. It's the single
biggest lever on advice quality.

## Privacy & cost

- **What leaves the tablet:** when you ask for advice, the shot's curves and your taste
  answers go to the provider you picked, to generate that one response. Nothing else is
  sent, and nothing is sent unless you tap **Get advice**.
- **What stays on the tablet:** your shot history, beans, grinder, and key never leave
  the device (except the key's use in each API call).
- **Cost** is whatever your provider charges per call — roughly a cent or two for the
  hosted options, free if you point Crema at a local model or your own Mac.

## Grinder support

Crema asks for your grinder by name in the wizard and phrases every adjustment in its
units. It was dialed in on a **Lagom 01 (102mm Mizen burrs)** — dial numbers, lower =
finer, 0.2–0.5 is a normal move — but any grinder works; the AI is told your grinder's
name and adapts its advice to it.

## Contributing

Crema is an early, actively-developed project — it does real work every morning, but
it's a work in progress and rough edges show up. **Help is genuinely wanted.**

- 🐛 **Found a bug?** [Open an issue](../../issues) with what you did, what happened, and
  (if you can) the DE1 app log from `/sdcard/de1plus/log.txt`. Bug reports from other
  grinders and providers are especially useful — Crema has mostly been tested on one rig.
- 💡 **Have an idea?** Open an issue to discuss it before a big PR.
- 🔧 **Want to code?** Small, focused PRs are the easiest to review. `./dev.sh` runs the
  whole thing in a desktop simulator, so you don't need a machine to hack on it (see
  [Building & developing](#building--developing)). Please run the self-test before
  submitting.

Good first areas: broader grinder presets, more provider defaults, questionnaire and
advice-copy polish, and any edge cases you hit on other grinders, providers, or tablets
(the [open issues](../../issues) track what's known so far).

## Building & developing

The skin lives in `skin/Crema/`. `build.sh` produces the clean public bundle in `dist/`
(stripping developer state so it boots into first-run defaults).

Development runs against a desktop checkout of
[de1app](https://github.com/decentespresso/de1app) in simulator mode:

```bash
./dev.sh                                       # launch the simulator with Crema
CREMA_SELFTEST=1 CREMA_STANDALONE=1 ./dev.sh   # run the full end-to-end self-test
```

The self-test pulls a simulated shot through questionnaire → AI advice → apply →
history and asserts each stage. See [DEPLOY.md](DEPLOY.md) for the tablet deploy loop
and the optional Mac-server mode.

## License & credits

GPLv3 (see [skin/Crema/LICENSE](skin/Crema/LICENSE)). Crema is a fork of the
MimojaCafe skin for de1app. Splash photo by
[Clint McKoy / Unsplash](https://unsplash.com/@clintmckoy).
