# Educational Video Generation Process

This process creates a continuous whiteboard/motion-graphics lesson, not a slideshow. Remotion owns deterministic typography, diagrams, animation, captions, and timing. Image models create only illustrative assets that benefit from generative art.

## Change control

This is a governing document under [`AGENTS.md`](../AGENTS.md). Any request to alter a required stage, its ordering, or its parallelism rules must be explained and explicitly confirmed with the question tool when available before implementation. Update the benchmark and model-recommendation documents in the same approved change whenever this workflow changes their requirements.

## Dependency map

```text
Input + audience settings
  -> risk route -> source-backed fact pack -> lesson blueprint -> approved script
                                                          -> visual bible
Approved script + visual bible
  -> [parallel: SVG diagram assets | illustration assets | music/SFX plan]
  -> full-script voiceover -> word timings
  -> timeline assembly -> Remotion composition -> automated QA -> review -> render/export
```

Parallel work begins only after its inputs are locked. A scene may not generate images before the visual bible is approved, and Remotion may not finalize timing before the voice track is available.

## Sub-processes

### 1. Intake and risk routing — sequential

Collect topic, target learner level, language, duration, aspect ratio, brand/style profile, and destination. Classify the domain as standard, engineering, medical, or client-production.

**Why:** a primary-school photosynthesis lesson and a medical-school pharmacology lesson cannot share the same source, safety, or review policy.

### 2. Research and fact pack — sequential

Retrieve authoritative, topic-appropriate sources. Extract only the facts, definitions, calculations, caveats, and citations required for the stated learning objective. Record claim-to-source links.

**Why:** the script must be written from evidence, rather than asking a model to remember science or medicine from training data.

### 3. Lesson blueprint — sequential

Create the measurable learning objective, learner prerequisites, hook, explanation arc, recap, and optional knowledge-check. Divide the explanation into scenes and visual beats; each beat introduces one idea and one meaningful canvas change.

**Why:** this is where the system becomes a teacher rather than a generic story generator.

### 4. Script and storyboard approval — sequential

Write spoken narration from the fact pack, then attach each line to a scene purpose, on-screen text, visual action, and source claims. Validate factual claims, reading level, duration, and safety policy before the script becomes immutable.

**Why:** changing the script after audio, captions, and scene assets exist causes needless cost and sync errors.

### 5. Visual bible — sequential

Create one project-level specification: canvas texture, marker/line style, palette, typography, character/object sheets, icon rules, camera behavior, caption design, and prohibited visual patterns. Define persistent entities such as the same leaf, sun, molecule, circuit, or patient diagram.

**Why:** it prevents visual drift and lets scenes feel like one evolving whiteboard.

### 6. Asset production — parallel by scene after the visual bible locks

- **SVG/Remotion diagrams:** Build molecules, arrows, charts, labels, equations, and annotated processes as editable vector components.
- **Illustrations:** Generate only scene illustrations, characters, or textures; provide the visual bible and relevant reference assets with every prompt.
- **Sound plan:** Select minimal music and sound effects, leaving narration intelligible.

**Why:** these outputs have no dependency on one another once scene direction is fixed. Vectors protect factual accuracy; illustrations add warmth and context.

### 7. Voiceover and captions — sequential, then derivation

Generate one voiceover for the complete approved narration with pronunciation notes. Obtain word/character alignment from the TTS response, derive phrase captions, and reserve short pauses for diagram inspection.

**Why:** one voice track preserves tone, pacing, and transitions. Captions must come from the rendered narration, not an independently paraphrased script.

### 8. Timeline assembly and composition — sequential

Convert scene durations, audio timings, captions, camera moves, asset references, and transitions into a typed project manifest. Remotion renders the sequence as a persistent canvas: draw/reveal paths, retain established objects, pan/zoom to the next concept, and use explicit transitions only where the teaching context changes.

**Why:** a manifest makes renders reproducible and lets the renderer remain deterministic even when upstream AI output varies.

### 9. Quality assurance — parallel checks after preview render

Run independent checks concurrently:

- schema and source-claim validation;
- visual continuity, diagram semantics, safe-area, and caption-overlap inspection;
- audio duration, pronunciation, word-timing, loudness, and music-ducking checks;
- render integrity, asset availability, and export-profile tests.

**Why:** each validator sees a different failure class; a single model cannot reliably judge its own output.

### 10. Approval, render, and feedback loop — sequential

Require the correct approval level, then render the MP4 and optional SRT/transcript. Save the prompt/version, sources, model versions, asset provenance, QA report, cost, and final output. Feed viewer retention, quiz results, and reviewer feedback into the regression suite.

**Why:** reproducibility and measured learning outcomes are necessary to improve the system safely.

## Required parallelism rules

| May run in parallel | Must wait for |
| --- | --- |
| Per-scene SVG assets, illustrations, and sound planning | Approved script and visual bible |
| Independent factual, pedagogy, visual, and audio QA | Preview render and its manifest |
| Multiple image candidates for one approved scene | Scene asset brief and references |
| Multiple render resolutions/formats | Approved master composition |

| Must remain sequential | Reason |
| --- | --- |
| Research -> lesson blueprint -> script approval | Prevents unsupported narration. |
| Script approval -> complete voiceover -> caption timing | Prevents visual/audio/caption drift. |
| Visual bible -> persistent asset generation | Preserves scene continuity. |
| Asset/timing completion -> final timeline -> final render | Keeps the composition deterministic. |
| QA approval -> publication | Prevents known errors from reaching learners. |
