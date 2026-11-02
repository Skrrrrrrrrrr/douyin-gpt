# Character asset prompts

Generated with the built-in imagegen tool, transparent_background=true. Input reference: reference.png.

## GPT

Use case: illustration-story. Asset type: transparent chibi character for a daily vertical video host. Image 1 is the character identity and style reference. Recreate ONLY the LEFT white-haired character as a standalone full-body cute anime chibi host on a genuinely transparent background. Preserve her long snowy-white/lavender hair, curved cream horns, vivid purple eyes, purple-and-white ornate floral dress, soft feathered dragon-like details, refined linework, pastel shading and warm cheerful personality. Both eyes open, gentle open smile, one hand gesturing as if explaining today's diary, the other relaxed. Full character and feet entirely inside the canvas with generous transparent margins, centered and facing slightly right toward a cohost. No second character, no text, no logos, no scenery, no shadow rectangle. Consistent proportions matching the supplied avatar, polished clean game-character illustration. A friendly fictional presenter, modest non-sexual outfit.

## DeepSeek

Use case: illustration-story. Asset type: transparent chibi character for a daily vertical video host. Image 1 is the character identity and style reference. Recreate ONLY the RIGHT navy-blue-haired character as a standalone full-body cute anime chibi host on a genuinely transparent background. Preserve her flowing deep navy hair with sky-blue tips, very large clear blue eyes, white frilly headband, blue bow with gold heart hair clip, navy-and-white frilly modest dress, blue oval brooch and small friendly blue whale motif on apron, same refined linework and pastel shading. Both eyes open, gentle open smile, holding a little blank diary close to her chest with one hand and making a small greeting gesture with the other. Full character and feet entirely inside the canvas with generous transparent margins, centered and facing slightly left toward a cohost. No second character, no text, no logos, no scenery, no shadow rectangle. Consistent proportions matching the supplied avatar, polished clean game-character illustration. A friendly fictional presenter, modest non-sexual outfit.

## 0.8.0 expression atlases

Generated using the built-in imagegen editor with `transparent_background=true`, referencing the corresponding standalone character above. Files: `gpt-expressions.png` and `deepseek-expressions.png`, each 1536×1024 pixels, six 512×512 cells in a 3×2 grid.

Production specification: preserve the reference character's identity, exact head scale and position, outfit, eye colours, hair, camera and lighting across every cell; transparent background, no lettering or grid lines. Row-major states: neutral closed smile, small open A mouth, wider A mouth, horizontal E mouth, rounded O mouth, closed-eye blink with closed mouth. Keep all features registered so only the eyes and mouth need compositing. A modest, friendly fictional presenter, consistent with the original avatar.

The renderer registers mouth and eye patches to a neutral base, rather than swapping complete generated heads. Chinese pinyin and TTS word timing choose approximate visemes, while short pauses close the mouth. These are animation aids, not a claim of phoneme-accurate lip synchronisation.
