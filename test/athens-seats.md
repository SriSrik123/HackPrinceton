# Athens clip seating reference

Ticket locations supplied by Neven:

| Clip | Gate / section | Row | Seat |
| --- | --- | --- | --- |
| can_yellow_athens_20s_1080p.mp4 | 26B (26Β) | 10 | 14 |
| krhtikos_yellow_athens_20s_1080p.mp4 | Pitch / General Admission | — | — |

Krhtikos replaces Kostas in the active views. The supplied location is pitch standing, about 6 m from the B-stage perimeter at a 45-degree front-right angle. Gate 5B / Row 1 / Seat 18 is a bowl reference only. Exact chart-to-world registration remains unverified.

Height correction: all positions are anchored to ray hits on the transformed collider and checked visually. Valia support Y=2.07560865475, camera Y=2.19560865475; Can support Y=0.9257214292, camera Y=1.0457214292. Krhtikos moved into the central floor at X=1.5, Z=-6; support Y=-1.2854678753, camera Y=-1.0854678753. Eye offsets are 0.12 for seated views and 0.2 for standing in this miniature generated scene. These offsets are preview scene units, not physical meters. The exported surfaceAnchor records the evidence; prepare-athens rejects inconsistent camera heights.

Official OAKA section chart: [Panathinaikos 2024–25 season-ticket brochure, page 3](https://www.pao.gr/wp-content/uploads/2024/07/19/SEASON-TICKETS-24-25_fnl.pdf#page=3).
The chart labels all three sections. This is a football layout, not the concert stage plan, and does not provide individual row/seat coordinates.

The editable layout is `test/athens-seat-layout.json`. Its `pos` values are manual visual estimates in Marble metric preview coordinates, not surveyed row/seat coordinates. The target is an estimated stage direction. The generated world differs from the real venue, so gate/row/seat alone cannot establish exact world coordinates. Exact correspondence between the concert plan and generated geometry remains unverified.

Run `node scripts/prepare-athens.mjs` after editing the layout. It writes the ignored local asset `public/athens-marble/cameras.json`. Open `/concert.html?data=athens-marble&reveal=0&panelDist=3`. This uses the shared concert viewer, its seat transitions, master clock and per-seat flat panels; no stage collider is used for this test dataset. Marble scale, ground offset and the axis flip are applied to the venue to match the exported preview-space cameras. `venueFlip=1` performs a further consistent flip of both seats and venue.

Clips remain unsynchronized (`offsetSeconds: null`, `testOnly: true`). Never interpret preserving the current clip time on switching as verified audio synchronization. Add measured offsets to the layout and re-export when available. Keep `testOnly` until the production requirements are met.

The fetched `origin/main` at 8dee570 contains the concert seat transition and video handling changes. It consumes positions through `cameras.json` / `src/seats.js`; these ticket details do not automatically convert into those positions.

Video coverage: vertical projection FOV is 60 degrees for Valia/Can and 68 degrees for Krhtikos. The pitch target is [0,-0.25,-12], raising coverage over the generated stage. These are visual framing adjustments, not measured source-camera intrinsics.
