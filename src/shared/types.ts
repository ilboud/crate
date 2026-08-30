/** Domain types shared between sync, server and (structurally) the web app. */

export interface DiscogsArtist {
  id: number;
  name: string;
  join?: string;
}

export interface DiscogsLabel {
  id: number;
  name: string;
  catno?: string;
}

export interface DiscogsFormat {
  name: string;
  qty: string;
  descriptions?: string[];
  text?: string;
}

export interface DiscogsTrack {
  position: string;
  title: string;
  duration?: string;
  type_?: string;
}

/** The `basic_information` block returned by the collection endpoint. */
export interface BasicInformation {
  id: number;
  master_id?: number;
  title: string;
  year?: number;
  artists?: DiscogsArtist[];
  labels?: DiscogsLabel[];
  formats?: DiscogsFormat[];
  genres?: string[];
  styles?: string[];
  cover_image?: string;
  thumb?: string;
}

export interface CollectionItem {
  id: number;
  instance_id: number;
  folder_id: number;
  date_added: string;
  basic_information: BasicInformation;
}

/** A full release fetched from /releases/:id — adds the tracklist. */
export interface ReleaseDetail extends BasicInformation {
  tracklist?: DiscogsTrack[];
  country?: string;
  released?: string;
  notes?: string;
}

export type AssignMethod =
  | 'override'
  | 'style-majority'
  | 'genre-tiebreak'
  | 'precedence'
  | 'genre-only'
  | 'unsorted';

export interface Assignment {
  group: string;
  how: AssignMethod;
}

export interface Taxonomy {
  /** style name -> group name */
  styleToGroup: Map<string, string>;
  /** coarse Discogs genre -> group name */
  genreToGroup: Map<string, string>;
  /** group names, most specific first; breaks ties rules cannot */
  precedence: string[];
  /** release id -> group name */
  overrides: Map<number, string>;
}

export interface ParsedPosition {
  disc: number;
  side: string | null;
  indexOnSide: number | null;
}

export interface TrackRow {
  id: number;
  release_id: number;
  seq: number;
  position_raw: string | null;
  disc: number;
  side: string | null;
  index_on_side: number | null;
  title: string;
  duration_sec: number | null;
}

export interface AlbumCard {
  id: number;
  title: string;
  artist: string;
  year: number | null;
  primary_group: string | null;
  thumb_path: string | null;
  cover_path: string | null;
}

export interface SimilarRow {
  release_id: number;
  other_id: number;
  score: number;
  reason: string;
  same_artist: number;
}

export interface CollectionItemRow {
  instance_id: number;
  release_id: number;
  folder_id: number | null;
  date_added: string | null;
}

export interface SyncResult {
  /** distinct releases newly fetched */
  added: number;
  /** distinct releases no longer owned */
  removed: number;
  unchanged: number;
  /** collection items (physical copies) seen; may exceed distinct releases */
  items: number;
  failed: number[];
  durationMs: number;
}
