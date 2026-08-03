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
