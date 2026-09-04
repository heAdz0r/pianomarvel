# Piano Marvel — UI and contextual fingering
Date: 2026-09-04. Implementation requested by user; no additional approval gate.
## Design audit: all 12 modules
| Module | Current / problem | Target |
|---|---|---|
| M1 Grouping | Duplicate source selectors; navigation to absent library | One persistent source selector; library link only when available |
| M2 Hierarchy | 640px promotional hero obscures tool | Compact editorial introduction, 320px maximum desktop, direct import/library actions |
| M3 Grid | Heavy framed planes, 96px section separation | 24/32px rhythm; desktop two-column introduction, single-column at 760px |
| M4 Typography | Oversized Unbounded wordmark, many uppercase captions | Manrope interface and headings; 48px introduction, 22px workspace headings, body 15px |
| M5 Color | Saturated blue plus page grid | Warm paper #f6f5f1, ink #202a35, focused blue #2454c6; semantic colors retained |
| M6 Dark | Existing semantic palette, literal white panels | Use semantic surfaces in new components, test contrast of both token palettes |
| M7 Depth | Large shadows and floating panels | 0 4px 20px / 4% shadows; fine separators |
| M8 Icons | Existing shared UiIcon | Retain component; 18px actions, accessible labels |
| M9 Buttons | Multiple equivalent hero CTAs | Single filled next action, secondary library link; 44px hit targets |
| M10 Feedback | Decorative READY and catalog-found claim without data | Label demo score as an excerpt; async state remains actual API state |
| M11 Motion | Marquee, magnetic buttons, parallax, 800ms reveals | Remove continuous decor and magnetic movement; 160–220ms feedback; reduced-motion support |
| M12 Overlays | No photographic backgrounds | Not applicable; score stays on opaque paper with separate caption |

## Algorithm
- Remove strong isolated-arpeggio priors on fragments embedded in continuous phrases.
- Retain recent released-note position separately from currently held-note constraints.
- Carry context over ordinary barlines; release it on real phrase breaks and thumb crossings.
- Rank beam survivors using a backward estimate of the remaining score; never count this estimate in the reported objective.
- Keep author constraints, hand span, pedal, ties and cross-staff routing.
- Examples from teacher screenshots are evaluation material, never runtime song identifiers.
- Test arbitrary transpositions, both hands, phrase boundaries, nonlocal future influence and complete local corpus.
- This remains a bounded ergonomic search, not a proof of globally optimal or universally teacher-approved fingering.
