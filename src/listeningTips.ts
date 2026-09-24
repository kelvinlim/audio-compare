import raw from "../assets/tracks/listening-tips.json";

export interface Cue {
  range: string;
  note: string;
}

export interface TrackTip {
  title: string;
  stresses: string;
  lossyDoes: string;
  listenWhere: Cue[];
  howToUse: string;
}

export interface ListeningGuide {
  general: {
    title: string;
    paragraphs: string[];
  };
  generic: TrackTip;
  tracks: Record<string, TrackTip>;
}

export const listeningGuide = raw as ListeningGuide;

export const bundledTipOrder = Object.keys(listeningGuide.tracks);

export function bundledTrackId(trackId: string): string {
  return trackId.startsWith("bundled:") ? trackId.slice("bundled:".length) : trackId;
}

export function tipForTrack(trackId: string | null | undefined): TrackTip | null {
  if (!trackId) {
    return null;
  }
  if (trackId.startsWith("user:")) {
    return listeningGuide.generic;
  }
  const id = bundledTrackId(trackId);
  return listeningGuide.tracks[id] ?? null;
}
