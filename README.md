# fitted-agents

Takes a capture of a body part (hand, wrist, elbow, knee, ankle, or anything
else by tape measure) and produces printable assistive devices sized to it. Each device comes with the reason for every size, the sources behind it,
a review, and a note in Obsidian. A person approves each design before it's
printed.

> **Early prototype, not a medical device.** Sizing rules are drafts, and the
> trackers haven't been tested on the bodies this is for. Have a clinician
> review anything worn for long periods or that bears weight.

## Install

You need:
- A Mac (Linux probably works; untested) with [Node.js](https://nodejs.org) 20 or newer
- Google Chrome (for the 3D renders)
- [Claude Code](https://claude.com/claude-code) installed and signed in with a
  Claude Pro or Max subscription. The agents run on your subscription. They
  refuse to run if an API key is set or extra usage is on, so nothing is
  billed per token.

Both repos go side by side in your home folder:

    git clone https://github.com/applicationsshobhit-commits/fitted.git ~/fitted
    git clone https://github.com/applicationsshobhit-commits/fitted-agents.git ~/fitted-agents

    cd ~/fitted && npm install && npm run setup     # setup downloads the tracking models (~17 MB)
    cd ~/fitted-agents && npm install
    npm run research     # once: builds the research library (~10 min, uses your Claude plan)
    npm start            # → open http://localhost:7790

To keep `~/fitted` somewhere else, set `FITTED_DIR` to its path.

## How a run works

1. **Start a run** on the dashboard: who it's for, which body part and side,
   and the goal.
2. **Capture.** The dashboard shows a link and a QR code. Anyone on the same
   Wi-Fi opens it, picks a video, fills in the tape measurements the page asks
   for, and taps *Send to Fitted*. Only the measurements are sent. The video
   stays on the phone.
3. **The agents run.** This takes about 7 minutes. Every stage writes its
   files to `data/runs/<id>/`.
4. **Review.** The dashboard shows each design in 3D, with its sizes and
   reasons, sources, risks, and the Supervisor's verdict. Flags come with a
   suggested fix, and the Supervisor picks the easiest next step.
5. **Approve or redo.** Approve the designs you want, or redo any stage with
   a note for the agent ("make the cuff 4 mm wider"), or capture the hand
   again. When you approve a new device type, it joins `devices/` so later
   runs can size it for other hands.

## Body parts

All defined in `~/fitted/capture/bodyparts.js`. The capture page, checks,
agents and vault notes all read that file, so adding a body part is one entry.

| Body part | Camera tracks | Tape measures |
|---|---|---|
| Hand | Hand tracker: finger lengths, opening, finger curl | Wrist (optional) |
| Wrist & forearm | Body tracker: forearm length, wrist bend | Wrist, forearm, hand breadth |
| Elbow | Upper arm, forearm, elbow bend | Upper arm, elbow, forearm |
| Knee | Thigh, shin, knee bend | Thigh, knee, calf |
| Ankle & foot | Shin, foot length, shin-to-foot angle | Calf, ankle, foot length and width |
| Other | Nothing: you describe it | Up to six measurements you name |

A camera measures joint angles well and lengths reasonably well (with a card
to calibrate). It can't measure around a limb, so those readings come from
the tape. Where both measure the same thing, the tape wins and the camera's
value is kept for comparison.

The three built-in devices are hand-only. For every other body part, the
Designer writes new device types, which build up in `devices/` as you approve
them.

## The seven roles

| Role | What it is | Model |
|---|---|---|
| Orchestrator | `lib/pipeline.js`. The stage order is fixed, so this is code | none |
| Capture | `~/fitted/capture` plus a capture link per run. A person films and measures | none |
| Researcher | `agents/researcher.md`. Reads the corpus, returns needs, principles and device ideas, with sources | Sonnet |
| Designer | `agents/designer.md`. Sizes built-in devices, writes new device types as code, and tests each one | Opus |
| Archivist | `lib/archivist.js`. Fills Obsidian templates. The Designer already wrote the reasons | none |
| Supervisor | `lib/checks.js` for rule checks, and `agents/supervisor.md` to judge fit, reasons, sources, renders and safety | Sonnet |
| Budget keeper | `lib/budget.js`. Logs tokens per agent and warns past a limit. Never stops a run | none |

AI runs only where judgment is needed. One run cost about 330k fresh tokens
in the first test (researcher 114k, designer 95k, supervisor 123k).

## Safety boundaries

- **Billing.** Agents only run on the Pro subscription. API keys are removed
  from the agent's environment, and a run is refused if billing isn't
  subscription-backed (copied from herd).
- **Files.** Each agent can write only inside its own run folder, and read only
  that folder plus the paths it's given. A PreToolUse hook enforces this on
  every tool call.
- **Commands.** The Designer can run exactly one command (`lib/try-device.js`),
  with no chaining. The other agents have no shell at all.
- **Device code** written by the Designer is built in a child process with a
  time limit, so a bad module can't hang the server.
- **Network.** The dashboard, API and run files are reachable from this Mac
  only. From the Wi-Fi, only the capture page and its token-checked upload
  work. A capture link stops working once its capture arrives.

## Research corpus

`research/sources.json` sets the sources and the licence policy:

| Use | Licences | What's stored |
|---|---|---|
| adapt | CERN-OHL, Apache, MIT, BSD, CC BY, CC BY-SA, CC0 | Full text; designs may build on it, with credit |
| cite | CC BY-NC, WHO | Metadata and a summary; designs may cite it, not copy it |
| link | No clear licence | Title and link only |

Sources currently fetched: Makers Making Change (GitHub, 153 repos) and
Zenodo (8 searches). `research/extract.js` has Haiku turn each document into a
searchable record and drops off-topic ones (116 relevant as of 2026-10-14).
Re-running either script only fetches what changed.

CANLAB, OpenXwalk and OpenMedTech Lab couldn't be found online under those
names. Add their GitHub org or repo to `sources.json` once you have a link.

Designs that adapt a CC BY-SA source must be shared under CC BY-SA if they're
distributed. The Archivist records every source on every design note.

## Obsidian

Notes go to `~/Fitted Vault`: People, Designs, Runs, Devices, and the renders
and STLs under attachments. It's outside `~/Documents` because macOS blocks
background processes from reading Documents without saying so. Open it in
Obsidian with *Open folder as vault*.

## Files

| Path | What |
|---|---|
| `server.js` | Dashboard, API, and the capture mount |
| `lib/pipeline.js` | Orchestrator: stages, retries, approval |
| `lib/agent.js` | Runs one agent: billing, file boundaries, watchdog, usage |
| `lib/devices.js` | Built-in and new device types → geometry, STL, measurements |
| `lib/checks.js` | Rule checks with suggested fixes |
| `lib/archivist.js` | Obsidian notes |
| `lib/budget.js` | Token ledger (`data/ledger.jsonl`), limits in `data/budget.json` |
| `lib/render.js` | Headless Chrome renders of the actual STL |
| `devices/API.md` | How a new device type is written |
| `agents/*.md` | Agent prompts. The frontmatter sets model, effort, tools and time limit |
| `data/` | Runs, corpus, ledger. Gitignored: it holds people's hand data |

## Known limits

- **Sizing rules are drafts.** The built-in baselines in `~/fitted` are
  placeholders until an occupational therapist sets them. The Designer and
  Supervisor are told this.
- **The body tracker is untested on real video.** Its maths is tested on
  synthetic limbs, and the model loads and runs, but it hasn't seen a real
  knee or elbow yet. Like the hand tracker, tight or unusual joints are the
  biggest risk; tape measurements are the fallback.
- **The wrist bend is one number.** The tracker can't tell bending up from
  bending down, so the range covers both directions.
- **The Wi-Fi link means no live camera on phones.** Browsers allow cameras
  only on https, so phones upload a recorded video instead. The live camera
  works on the Mac itself.
- **The server runs only while `npm start` runs.** It isn't a LaunchAgent yet.

## Licence

MIT, see `LICENSE`. The research library is built on your machine from
openly licensed sources; designs that adapt a CC BY-SA source carry that
licence when shared (the vault notes record which sources each design used).
