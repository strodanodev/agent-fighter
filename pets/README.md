# Pets

One folder per pet, exactly like `characters/` and `stages/`: the FOLDER NAME
is the id, and `pet.json` is a `PetDef` (`@af/core/pets.ts`). The match server
reads this directory at boot and the adoption roll draws from it, so a new pet
ships by adding a folder — no code change anywhere.

Author them in the **Studio** (`npm run studio` → Pets tab): generate or upload
an image, and it is background-removed, trimmed and written here as
`pet.json` + `frame0.png`.

A pet with no `sprites` is still playable — the client draws a procedural
companion in its `tint`. That is what the three starter pets do until art is
generated for them.

`disabled: true` keeps a pet owned by whoever adopted it but stops it dropping
from new adoptions.

**Auras are NOT authored here.** Every line is rolled per-adoption by the
server (ADR 0011); two players owning the same pet own different auras.

## motion: how a pet carries itself

`"motion": "float"` (default) hovers at shoulder height behind the fighter and
rises with them on a jump — a drone, a moth, a wisp.

`"motion": "ground"` walks the stage floor behind them and STAYS down when
they jump, with a trot bounce that scales with their speed and its own contact
shadow — a pup, a crab, anything with feet.

Cosmetic either way: the sim never reads it. Set it in the Studio's Pets tab
("moves").

## a note on background keying

Art that ALREADY has a transparent background is stored exactly as uploaded.
Keying an image that is already cut out samples transparent border pixels for
its key colour and then eats holes straight through the sprite's dark pixels.
Only art with an opaque background is keyed. Override per-session with the
Pets tab's "background" selector.
