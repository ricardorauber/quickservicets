# 0015 - MP4 is recognized by the major brand of its `ftyp` box

- Date: 2026-10-19
- Spec: 0097-upload-type-detection-containers-media
- Status: accepted

## Context
The spec asks to recognize MP4 by its `ftyp` box as `video/mp4`, and puts other media containers out of scope. Many formats that are not MP4 video also start with an `ftyp` box: HEIC and AVIF images, QuickTime movies, 3GP files and `.m4a`/`.m4b` audio. Treating every `ftyp` box as `video/mp4` would reject those uploads with 415 whenever they are declared with their own type (`image/heic`, `video/quicktime`, `audio/x-m4a`), which the spec does not intend.

## Options considered
- A: Recognize MP4 only when the major brand of the `ftyp` box is an MP4 video brand (`isom`, `iso2`-`iso9`, `mp41`, `mp42`, `mp71`, `avc1`, `dash`, `M4V `, `f4v ` and similar); other brands are not recognized and keep their declared type — keeps HEIC, AVIF, QuickTime, 3GP and M4A uploads working, at the cost of a brand list to maintain.
- B: Treat every `ftyp` box as `video/mp4` — the literal reading, but it rejects common image and audio uploads.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
The detector checks the major brand against a list of MP4 video brands. Files with other brands are treated as unrecognized formats and keep their declared type. The spec could name the brand rule in R3.
