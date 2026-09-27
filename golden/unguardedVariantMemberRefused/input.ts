interface AsepriteFrame {
  x: number;
  y: number;
}

interface TexturePackerFrame {
  filename: string;
}

interface AsepriteAtlas {
  frames: AsepriteFrame[];
  meta: { app: string };
}

interface TexturePackerAtlas {
  frames: TexturePackerFrame[];
  meta: { size: number };
}

type Atlas = AsepriteAtlas | TexturePackerAtlas;

// Both alternatives hold `frames`, so the source language accepts the read -- the member belongs to each
// alternative the value could be. What the target cannot do is read it without knowing which alternative is
// active, because the two store it at different C++ types. That is a guard the source has to state, so the
// refusal is attributed to the source and names the shapes that state it.
export function frameCount(atlas: Atlas): number {
  return atlas.frames.length;
}
