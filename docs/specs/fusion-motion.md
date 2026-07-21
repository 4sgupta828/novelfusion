# Spec: fusion motion — information as creative expression (PROPOSED, phased)

**Status:** Proposed · **Origin:** research distillation (data-video / narrative-viz literature +
data humanism) · **Feature:** the experimental fusion-video generator (`NF_FLAG_FUSION_VIDEO`).

The fusion generator today renders each scene as a **static PNG + a ffmpeg ken-burns pan**. That caps
it at "narrated slideshow." This spec is the roadmap to move it to **data video** — information
expressed *as motion* — grounded in the research and mapped to what our exact stack (`@napi-rs/canvas`
+ `ffmpeg` + OpenAI TTS + an LLM storyboard) can actually do.

## 1. What the research says (the principles we build to)
- **Data video is a genre.** Segel & Heer's narrative-visualization taxonomy lists *video* alongside
  annotated-chart/slideshow/comic; the "data video" line (animated data-driven transitions, DataTV,
  Calliope) treats the animated explainer as first-class — not slides with a voiceover.
- **Motion is meaning, staged.** Heer & Robertson: animated transitions *measurably* improve
  perception, but only when **staged** — separate an axis rescale from a value change; don't animate
  everything at once.
- **Stagger + easing are the primitives.** Distribute element entrances over time so the viewer
  processes in chunks; ease in/out (never linear) to mimic physics.
- **Creative expression = the human layer** (Giorgia Lupi, *data humanism*): "embrace complexity,
  move beyond standards, sneak context in, data is imperfect." Annotations, context, organic marks,
  pictographs — the counterweight to sterile charts.
- **Director's craft.** Arc, pacing, camera, emphasis — the skills of film, applied to data.

## 2. The architectural unlock (the thing everything depends on)
Replace the static per-scene PNG with a **frame sequence**. Refactor:
```
renderScene(scene, sc)            →  renderSceneFrame(scene, sc, tSec)   // draws the scene AT time t
```
Per scene, emit N frames (≈30 fps × scene-seconds) to `tmp/sN/f_%05d.png`; ffmpeg encodes the
sequence with the voiceover:
```
ffmpeg -framerate 30 -i f_%05d.png -i voice.mp3 -filter_complex "fps=30,<fades>,<captions>,format=yuv420p" ...
```
`@napi-rs/canvas` renders any frame; stagger/easing/count-up/bar-grow/ring-sweep are just math on `t`.
Backward-compatible: `renderScene(scene, sc)` becomes `renderSceneFrame(scene, sc, ∞)` (fully settled)
so unit tests and any static use keep working.

**Perf:** animation lives in the first ~1.4s; frames after the scene *settles* are identical, so we
render distinct frames only during the animation window and **copy the settled frame** for the hold.
Internal element animation replaces the ffmpeg ken-burns on animated scenes (the content moving IS
the motion). Expect longer renders (a frame sequence + encode per scene vs one image) — the honest
cost of it being motion design rather than a slideshow.

## 3. Roadmap (prioritized, feasibility-tagged to our stack)

### Tier 1 — the static→motion leap (BUILD FIRST; fully feasible now)
1. **Frame-animation engine** — `renderSceneFrame(scene, sc, tSec)` + the ffmpeg frame-sequence path.
2. **Staggered, eased entrances** — bullets, comparison cards, big-numbers, chart bars, timeline
   steps enter one-by-one (delay = i·stagger) with ease-out.
3. **Data-driven motion (staged)** — bars **grow from 0**, the donut **sweeps**, numbers **count up**
   (odometer), the timeline rail **draws on**.
4. **Kinetic title** — headline reveal (fade + slide-up, word stagger); accent underline draws in.

### Tier 2 — cinematic polish (feasible, medium lift)
5. **Meaningful transitions** — `slide`/`push`/`wipe`/`dissolve` (native ffmpeg `xfade` types) chosen
   by the director per cut (continuation vs contrast), on top of today's crossfade/dip/cut.
6. **Emphasis beats** — pulse/scale the hero element when the narration hits it.
7. **Sound design** — a music bed with **ducking under narration** (ffmpeg `sidechaincompress`) + soft
   transition whooshes. Biggest "feels produced" jump after animation. (Needs bundled royalty-free
   audio.)
8. **Pictograph / unit charts** — 100-dot arrays, X filled (the data-humanism move; more human than a
   bar).

### Tier 3 — advanced / bigger lift
9. **Word-synced captions + reveals** — word timestamps via OpenAI transcription (whisper) so captions
   pop word-by-word and reveals land *on the spoken word* (CapCut/ngram-class polish).
10. **Parallax camera / focus-pull** — multi-layer depth; rack-focus blur.
11. **"Data humanism" expressive theme** — organic/annotated aesthetic, hand-drawn marks, context
    callouts.
12. **New scene grammars** — line-over-time (draw-on), scatter, simple maps.

## 4. Tier 1 delivery contract (what the first build ships)
- `renderSceneFrame(scene, sc, tSec)` with a small easing/reveal toolkit (`easeOutCubic`,
  `reveal(t,start,dur)`); every scene type animates its entrance + its data.
- `fusion.ts` renders each scene as a frame sequence (animation window at 30 fps + copied settled
  frames), encodes with voiceover; fades / captions / transitions unchanged.
- No new flag, schema, or endpoint change — it's a rendering upgrade inside the existing generator.
- Held to the same bar: the unit test asserts a valid frame for every scene type × theme at several
  `t` values; a live render confirms a real animated mp4.

## 5. Open questions
- Frame budget vs render time — cap fps (24 vs 30) and animation window if renders get slow.
- Whether to keep a *subtle* global drift under the internal animation, or go fully static-camera.
- Music licensing/bundling for Tier 2 sound design.
