# React-to-MP4 rendering and deterministic spatial compositing

## Decision

Use React/Remotion as the **deterministic compositor and MP4 renderer**, but do
not use Remotion Studio as part of production. A worker can bundle the
composition once, pass a locked manifest as input props, and render headlessly
with `@remotion/renderer`. This removes the manual Studio adjustment loop; it
does **not** remove rendering work. An MP4 still requires a renderer to turn
each React frame into pixels and encode/mux audio. The official
[`renderMedia()` API](https://www.remotion.dev/docs/renderer/render-media) is
designed for this programmatic use and accepts a bundle, a selected composition,
JSON input props, and an output path.

This note is an implementation design, not a change to the governing pipeline.
It preserves the required order: locked script and visual bible, assets, one
full-script voice track, timings/captions, locked timeline, preview QA,
approval, final render. In particular, it does not replace the required
deterministic Remotion composition with an AI video generator.

## What the two reference checkouts do

`reference/template-prompt-to-video` is a mirror of
`reference/remotion/packages/template-prompt-to-video` (apart from its Git
metadata and `package.json`). The useful mechanism is:

1. The CLI creates story text, one illustration and one TTS clip per story
   item.
2. `generateVoice()` calls ElevenLabs' timestamped TTS endpoint and writes both
   the MP3 and character start/end times to `descriptor.json`. ElevenLabs
   documents this endpoint as returning the audio plus character-level
   alignment specifically for audio/text synchronisation.
   [ElevenLabs: Create speech with timing](https://elevenlabs.io/docs/api-reference/text-to-speech/convert-with-timestamps)
3. `createTimeLineFromStoryWithDetails()` accumulates each clip duration into
   absolute `startMs`/`endMs` values. It converts aligned characters back into
   short text chunks.
4. `AIVideo.tsx` converts the very same millisecond intervals to frames and
   mounts a background, caption, and `<Audio>` in `<Sequence>` components.
   Therefore the spoken clip and its caption start from the same timeline
   clock. `Root.tsx` derives composition duration from that timeline.
5. A headless `npx remotion render` (or the renderer API) loads the React
   composition frame by frame and encodes the MP4.

The core lesson is: **audio is the clock**. Captions must be a pure derivation
of the alignment of the actual rendered narration, not a separately generated
or paraphrased subtitle.

## Why the reference template cannot solve precise overlays

| Reference behaviour | Consequence |
| --- | --- |
| `Background.tsx` makes every generated image a centred, full-screen, zoomed background. | It stores neither an object's position nor a point such as an eye centre. The same image is also cropped differently while zooming. |
| `TimelineSchema` has backgrounds, text and audio only. The text `position` field is not consumed by `Subtitle.tsx`. | There is no typed scene graph, z-order, safe area, transform, anchor, or collision rule. |
| The source image is 1024×1792 while the target is 1080×1920, and the background component starts from a width of the video height (`1920`). | The fixed cover/crop and 1–1.5× zoom can move a face far from its intended visual location even when the source asset looked correct. |
| Captions are reconstructed by splitting the source string and walking character indices. | This is fragile for punctuation, repeated whitespace, Unicode, and TTS text normalisation; it also produces very short caption chunks instead of word-level emphasis. |
| The CLI makes several per-scene TTS requests and `getTextAnimations()` uses `Math.random()`. | Per-scene speech conflicts with the required single full-script voice track; unseeded randomness conflicts with reproducible manifest rendering. |

The prompt is not the missing coordinate system. Asking an image model for
“put object B exactly on object A” can influence a single raster, but it cannot
create reusable coordinates shared by independently generated or reused assets.
Practitioner reports reach the same practical conclusion: detailed placement
instructions drift without spatial conditioning; a control image, depth/line-art
guide, or compositing is needed. See the discussion
[on spatial consistency](https://www.reddit.com/r/comfyui/comments/1ul0ii6/how_do_you_maintain_spatial_and_detail/)
and the [layered-composition workflow discussion](https://www.reddit.com/r/comfyui/comments/1gu16so).
Those reports are useful experience, not release-quality evidence.

## Proposed solution: a constraint-based spatial scene graph

Treat each scene as a small, versioned scene graph in a canonical coordinate
space, rather than as a stack of images described in prose.

```text
approved base portrait --landmark detection--> face.leftEye / face.rightEye
                                                 |
locked camera transform ------------------------+--> deterministic EyeBeam SVG
full voice audio --word alignment--> captions ---+--> same frame clock
```

The LLM may choose *semantic* relationships—`beam originates from
character.face.leftEye`, `callout points to circuit.resistor.R1`, or
`reaction icon enters above product-card.logo`—but it must not invent raw
production `x`/`y` values. A deterministic layout compiler resolves those
relationships after the selected assets are known, then applies the same
cover/crop/camera matrix that React uses for every related layer. Thus, if an
image pans or zooms, any object attached to it stays attached on every frame.

For the eye-beam example, generate one approved portrait with enough headroom;
detect its face landmarks; and render the red beam as a procedural SVG/React
effect, not as a second generated bitmap. A beam is a visual effect, so SVG
gives exact origin, direction, width, glow, and timing. It is also cheaper and
does not risk a mismatched eye-sized PNG. The same contract supports a character
holding a generated item, a label attached to a machine part, a sticker on a
phone, a foreground cutout behind a desk, particles emitting from a rocket, or
an illustrative image constrained to a caption-safe region. This is compatible
with the policy that factual diagrams, labels, equations, charts, and captions
are deterministic SVG/Remotion components.

MediaPipe Face Landmarker is a suitable validator/resolver candidate: it
returns normalised 3-D face landmarks and transformation matrices intended for
effects rendering, including in a Web/JavaScript integration.
[MediaPipe Face Landmarker for Web](https://developers.google.com/edge/mediapipe/solutions/vision/face_landmarker/web_js)
Use it in an asset-validation worker, **not inside the per-frame React render**.
Persist its result with the asset hash and detector/model version.

### The four coordinate spaces

Every layer must declare which coordinate space it uses. Mixing these spaces is
the usual reason an overlay looked correct at one frame and drifted after a crop
or camera move.

| Space | Unit | Purpose | Example |
| --- | --- | --- | --- |
| Asset-local | Normalised `(0..1, 0..1)` in the uncropped source asset | Persistent detected/authored anchors | `face.leftEye`, `product.logoCentre`, object-mask bounds |
| Layer-local | Normalised within an overlay's own bounds | The point on the overlay that attaches to its target | Beam emitter at `(0.05, 0.5)`; speech-bubble tail tip |
| Scene/world | Canonical `1920×1080` or `1080×1920` design plane | Constraint solving and z-order before camera motion | A cutout is left of a chart by one chart width |
| Output screen | Integer output pixels at a specific frame | Final React/CSS/SVG render and visual QA | `(613, 427)` at frame 184 |

An asset anchor never becomes a screen pixel directly. The layout compiler maps
it through asset fitting, its parent group transform, and the scene camera in
that order. Captions and other screen UI live in a `screen-ui` group which the
camera does not transform.

### Layer types and anchor providers

The asset record must specify usable geometry, not merely its file URL.

| Layer type | Required geometry | Typical placement use |
| --- | --- | --- |
| Background image | Source dimensions and `cover`/`contain` crop transform | Full scene context under camera motion |
| Subject cutout | Verified alpha or segmentation mask, visible bounds, subject anchors | Place character/product in front of another layer without rectangular edges |
| Generated illustrative image | Source dimensions, safe-region result, optional detected object boxes/keypoints | A self-contained scene element; do not use it as a precise attachment target unless validation finds its target anchor |
| Procedural SVG/effect | Local attachment point(s), scalable dimensions, optional path | Beams, arrows, glows, highlights, callouts, particles, masks |
| Deterministic diagram/text/caption | Typed component bounds and named ports/labels | Exact factual visuals and caption-safe layout |

Anchor providers are ordered by reliability: authored vector port or SVG ID;
deterministic component bounds; validated alpha-mask boundary; specialised vision
landmarks (face/hand/pose); validated object detection; and finally an explicitly
reviewed manual anchor. A prose description or an LLM-proposed pixel coordinate
is never an anchor provider.

### A generated image's dimensions are not its placement contract

The LLM should request an aspect ratio, enough resolution for the largest
displayed size, visible-subject/safe-region requirements, and required anchors.
It should **not** attempt to make two independently generated assets “the same
size” so that they will happen to align. Source pixels are only sampling quality;
the resolved display size comes from the target's measured geometry at render
time.

An independently generated overlay must be delivered as one of the following:

- an RGBA cutout with a verified alpha boundary and at least one local anchor;
- a source image plus a persisted segmentation mask and visible bounds; or
- a self-contained illustration that is not expected to align to another asset.

For example, an attached helmet can use its mask's bottom-centre as
`localAnchor`, then attach to a detected head-top/face anchor and scale from the
head width. A generated flat rectangular "helmet image" with no mask, no anchor,
and a human-written `left/top` is an invalid attachment asset. Effects, arrows,
glows, labels, brackets, lines, and highlights should normally be deterministic
components rather than generated overlays.

### Two locked artifacts, not one vague timeline

Keep both artifacts below. The second is derived deterministically and is the
only geometry React consumes.

1. **`scene-plan/v1`**: LLM-produced semantic intent such as `left-of`,
   `attach`, `behind-mask`, safe area, required subject/anchor names, visual
   purpose, asset-role briefs, and timing references to narration words.
2. **`resolved-layout/v1`**: compiler output after the selected asset hashes,
   source dimensions, masks, landmark/detection results, canvas, and camera
   keyframes are locked. It holds the matrix/bounds/clip-path for each sampled
   placement interval and records every constraint decision.

The final video manifest references hashes for both artifacts. A replacement
image invalidates and recompiles `resolved-layout/v1`; it cannot reuse geometry
from a different candidate image.

### Manifest shape

This abbreviated TypeScript-like manifest shows the required separation of
semantic intent, detected anchors, and deterministic display transforms.

```ts
type Point = {x: number; y: number}; // normalised [0, 1] in source-image space

type Asset = {
  id: string;
  sha256: string;
  mimeType: "image/png" | "image/webp" | "audio/wav";
  sourceWidth?: number;
  sourceHeight?: number;
  provenance: {role: "illustration" | "voice"; promptVersion?: string};
  anchors?: Record<"face.leftEye" | "face.rightEye", Point>;
};

type Layer = {
  id: string;
  kind: "image" | "cutout" | "svg-effect" | "diagram" | "caption";
  assetId?: string;
  zIndex: number;
  startMs: number;
  endMs: number;
  parentId: "world" | "camera" | "screen-ui" | string;
  placement: Placement;
  occlusion?: {mode: "front" | "behind-mask" | "clip-to-mask"; targetLayerId?: string};
  effect?: {type: "eye-beam"; lengthEyeWidths: number; widthEyeWidths: number};
};

type Placement =
  | {kind: "fit"; fit: "cover" | "contain"; focalAnchor?: string}
  | {kind: "absolute"; origin: Point; size: {w: number; h: number}; reviewId: string}
  | {
      kind: "attach";
      target: {layerId: string; anchor: string};
      localAnchor: Point;
      offset: {x: number; y: number; unit: "target-width" | "target-height" | "anchor-distance"};
      size: {value: number; basis: "target-width" | "target-height" | "anchor-distance"};
      rotation: "inherit-target" | "outward" | {degrees: number};
    }
  | {
      kind: "relative";
      relation: "left-of" | "right-of" | "above" | "below" | "centered-in";
      targetLayerId: string;
      gap: {value: number; unit: "target-width" | "target-height"};
    };

type Word = {text: string; startMs: number; endMs: number};
type VideoManifestV1 = {
  schemaVersion: "video-manifest/v1";
  fps: 30;
  canvas: {width: 1080; height: 1920; safeArea: {top: 120; right: 72; bottom: 280; left: 72}};
  narration: {assetId: string; words: Word[]; alignmentSource: "tts" | "forced-alignment"};
  scenes: Array<{id: string; claimIds: string[]; layers: Layer[]}>;
};
```

`absolute` placement is deliberately exceptional: it must name a review/author
decision and is useful only for brand locks or composition templates. Normal
scene planning uses `attach` and `relative` placement. `CameraKeyframe` must be
fully specified and seeded; it contains pan, zoom and rotation in time, not an
ad-hoc CSS adjustment. The resolver records the resolved pixel anchor at each
camera keyframe or resolves it mathematically at render time from the same
keyframes.

### Constraint compilation and collision policy

The scene planner produces a graph of relationships; a deterministic compiler
then resolves it topologically. It first resolves base asset fit/crop, then
intrinsic anchors, relative placements, attachment transforms, parent camera
transforms, and finally screen-ui. It must fail on an anchor cycle, a missing
target, incompatible coordinate space, out-of-bounds required anchor, or
unsatisfiable safe-area/collision constraint.

Each layer also declares a bounding box (or alpha-mask bounds) and one of these
policies:

- `must-not-overlap`: captions, brand marks, labels, or independent subjects;
- `may-overlap`: decorative layers where z-index decides the appearance;
- `attach-overlap`: an effect deliberately overlaps its target at its anchor;
- `behind-mask` / `clip-to-mask`: the target's validated mask creates true
  foreground/background occlusion.

Collision is checked at all placement keyframes and sampled intermediate frames,
not only at frame zero. The compiler may use deterministic alternatives stated
in the visual bible (move a callout to another named side, reduce it within a
bounded range, or pick another approved scene layout). It must never make a
silent, arbitrary move.

### Generic example: several overlays, not a face-specific special case

```text
Scene world
  ├─ lab-photo            fit: cover, focalAnchor: microscope.stage
  ├─ specimen-cutout      relative: right-of(lab-photo.subjectBounds), gap: 0.06 target-width
  ├─ magnifier-svg        attach: specimen-cutout.subject.centre, localAnchor: lens.centre
  ├─ pointer-arrow-svg    attach: lab-photo.microscope.stage, localAnchor: arrow.tip
  ├─ annotation-card      relative: below(specimen-cutout), must-not-overlap: captions
  └─ captions             parent: screen-ui, constrained to bottom safe area
```

If the camera pushes into `lab-photo`, the arrow follows the microscope stage,
because both use the camera parent. The specimen and annotation remain in the
world layout unless their parent says otherwise. Captions remain legible at the
screen safe area because they are deliberately outside the camera group. This is
the same system that places a human, eye beam, product, logo, callout, mask, or
any number of arbitrary layers.

### Coordinate math that prevents drift

Let source dimensions be `(Sw, Sh)` and canvas dimensions be `(Cw, Ch)`. For a
`cover` image, first calculate:

```text
s = max(Cw / Sw, Ch / Sh)
drawW = Sw * s                 drawH = Sh * s
offsetX = (Cw - drawW) / 2     offsetY = (Ch - drawH) / 2
```

An asset landmark `(u, v)` is normalised in its *uncropped source image*. Its
canvas point before camera motion is:

```text
p = (offsetX + u * drawW, offsetY + v * drawH)
```

Apply the exact same affine camera transform `M(t)` to both the image and `p`.
An attached overlay's transform is `M(t) × parentTransform × targetAnchor ×
attachmentOffset × inverse(localAnchor)`. The beam's SVG is then translated to
the resulting point, scaled from the eye width, and rotated according to the
chosen outward eye direction. Do not put independent `left`, `top`, `scale`,
or zoom values on an attached overlay. They will eventually drift.

When there are no reliable anchors (profile face, occlusion, multiple faces,
or detector confidence below the declared threshold), the asset fails the scene
contract. Regenerate the **base asset**, use a valid preapproved alternative,
switch to an approved self-contained layout, or require review; never silently
guess a nearby coordinate.

### Asset brief and prompt contract

The LLM should create an image brief, not a final layout guess. Example:

```json
{
  "role": "character-base-portrait",
  "canvas": {"aspectRatio": "9:16", "safeRegion": [0.08, 0.10, 0.92, 0.72]},
  "requiredAnchors": ["face.leftEye", "face.rightEye"],
  "acceptance": [
    "exactly one unobstructed frontal face",
    "both eyes visible and inside the safe region",
    "head and shoulders; leave clean space to the subject's left",
    "no text, labels, glasses glare, eye effects, or crop through the face"
  ],
  "styleRefIds": ["locked-visual-bible-character-sheet"]
}
```

If the image provider supports a layout/reference image, create a deterministic
SVG guide with the safe region and simple face/eye placeholders, and use it as
spatial conditioning or an edit input. This can improve the candidate rate,
but it is still only an aid: detector validation and deterministic compositing
remain the authority. Community examples similarly use depth maps or collage
layers as structural guidance rather than trusting prose placement.
[NVIDIA/ComfyUI depth-map example](https://www.reddit.com/r/comfyui/comments/1kbjlq3/)

## Captions and audio: one clock, quantised once

1. Generate the complete approved narration once. Persist audio bytes, hash,
   actual measured duration, TTS model/voice/settings, and the provider's
   alignment response.
2. Convert character alignment to word tokens by offsets in the exact text sent
   to TTS. Preserve punctuation and whitespace offsets; do not rediscover words
   using `split(" ")`.
3. Independently run forced alignment against the saved audio and locked script
   when the provider alignment is unavailable or as the QA verifier. ElevenLabs'
   forced-alignment API returns word and character timestamps plus an alignment
   loss value. [ElevenLabs: Forced Alignment](https://elevenlabs.io/docs/api-reference/forced-alignment/create)
4. Create readable phrase cues from consecutive words while retaining each
   word's own bounds for highlighting. The caption string must reconstruct the
   approved narration exactly.
5. Convert milliseconds to frames through one shared function, for example
   `startFrame = floor(startMs * fps / 1000)` and
   `endFrameExclusive = ceil(endMs * fps / 1000)`. A sequence duration is
   `max(1, endFrameExclusive - startFrame)`. Store the original milliseconds as
   evidence; use these quantised frame bounds everywhere in React.
6. Mount the one narration `<Audio>` at frame zero. Caption and visual beats
   independently refer to its absolute word/cue intervals. A frame at 30 fps
   is 33.33 ms, well inside the existing 150-ms p95 word-alignment gate, while
   the separate alignment QA detects larger errors.

Remotion also provides caption utilities for importing, displaying, and
exporting timed captions; its SRT parser represents captions with explicit
`startMs` and `endMs`. [Remotion captions documentation](https://www.remotion.dev/docs/captions)

## Headless React-to-MP4 workflow

```text
locked manifest + verified local/object-store assets
  -> cached composition bundle (only when code/dependencies change)
  -> selectComposition(bundle, inputProps: manifest)
  -> renderMedia(... codec: "h264", outputLocation: immutable MP4 path)
  -> ffprobe/render QA + immutable release record
```

The render worker should expose a job command/API, not Studio:

```ts
const serveUrl = await bundle({entryPoint: "src/index.ts"}); // cache by lockfile + commit
const composition = await selectComposition({serveUrl, id: "Lesson", inputProps: manifest});
await renderMedia({
  serveUrl,
  composition,
  codec: "h264",
  audioCodec: "aac",
  inputProps: manifest,
  outputLocation: finalMp4Path,
});
```

This uses headless Chromium and FFmpeg under the renderer; that compute is
necessary for an MP4, but Studio is not started and no human needs to drag an
overlay. Cache the bundle, constrain renderer concurrency/memory, and render a
small set of deterministic validation frames before the full preview. Never
fetch an unverified provider URL inside the composition—use validated asset
references resolved from the manifest.

## Required QA before adopting this design

These are proposed implementation checks that supplement, rather than change,
the existing governing release gates.

| Check | Deterministic evidence | Failure handling |
| --- | --- | --- |
| Manifest/asset integrity | Zod/JSON-schema validation; asset hash, MIME, dimensions, provenance, detector and model version present | Block scene assembly. |
| Anchor availability | Exactly one required face and both named eyes detected in source coordinates; source aspect/crop contract passes | Regenerate or replace only the illustration asset. |
| Anchor attachment | At start, middle, end, and every camera keyframe, the beam origin equals the transformed eye anchor within 1 output pixel | Block preview; fix the renderer/manifest transform. |
| Effect scale and direction | Beam width/length are derived from detected interpupillary distance and pass declared min/max bounds | Block preview or require review. |
| Caption correctness | Reconstructed words exactly equal the locked narration; monotonic non-overlapping cue bounds; safe-area and contrast checks | Rebuild caption derivation. |
| Audio/caption sync | Independent forced alignment; p95 word error remains within the governing 150-ms limit | Regenerate/re-align voice, then rerun dependent work. |
| Render integrity | Preview/final frame count, measured audio/video duration, no missing assets, and sampled anchor/caption screenshots | Block release. |

Add regression fixtures for: a frontal face with a 2× zoom/pan, portrait versus
landscape source images, a rejected profile face, Unicode/punctuation caption
alignment, a TTS-normalised number, a missing asset, and a recovered rendering
job. Record all output hashes, timing/QA results, model versions, prompt
template version, detector version, cost and latency in the run checkpoint.

## Practical implementation order

1. Replace the template's three-list timeline with a versioned manifest and a
   fixed 9:16 coordinate system; remove unseeded randomness.
2. Implement a single full-script narration/alignment artifact and a pure
   caption derivation module with tests.
3. Add `ImageLayer`, `CutoutLayer`, `ConstraintLayout`, and `AnchorEffectLayer`
   React components. They must consume `resolved-layout/v1` and share one
   source-to-canvas transform function; implement one procedural effect (such
   as `EyeBeam`) only as a regression example, not as the architecture's focus.
4. Add the off-render asset validation worker and persist landmark results with
   selected asset provenance.
5. Build headless preview/final render jobs plus the QA checks above. Only then
   trial controlled image-generation inputs (guide/reference images) to improve
   asset acceptance rate.

This order attacks the actual cause of manual `x`/`y` adjustment: coordinates
and attachments become data verified from the approved image, not an LLM's
best-effort prose instruction.
