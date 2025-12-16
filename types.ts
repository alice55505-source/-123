
export type MediaType = 'image' | 'video';

export interface CanvasItem {
  id: string; // 'title' or media ID
  type: 'image' | 'text' | 'effect'; 
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
  rotation?: number; // New: Rotation in radians
  zIndex: number;
  
  // Image specifics
  sourceUrl?: string; // Persist the blob URL
  imgOffset?: { x: number, y: number };
  imgZoom?: number;
  imgBaseScale?: number; // New: Keeps image size independent of frame size for cropping
  isSticker?: boolean; 
  
  // Text specifics
  text?: string;
  fontFamily?: string;
  fontSize?: number;
  color?: string;
  strokeColor?: string; 
  strokeWidth?: number; 
  // Text Background Box
  backgroundColor?: string; 
  backgroundOpacity?: number; 
  backgroundPadding?: number;
  backgroundRadius?: number;
  
  // Animation / Effect Type
  // UPDATED: Aesthetic Linear Stickers + Red Circle + Pin
  animationType?: 'NONE' | 'REC_FRAME' | 'RED_CIRCLE' | 'LOCATION_PIN' | 'TAPE' | 'BULB_LINE' | 'HEART_LINE';
}

export interface CollageData {
  items: CanvasItem[];
  bgGradientId: string;
  title: string;
}

export interface UploadedMedia {
  id: string;
  file?: File; // Optional now, as it might be missing on load
  type: MediaType;
  previewUrl: string;
  fileName?: string; // Store filename for reconciliation
  missing?: boolean; // Flag for missing files after project load
  duration?: number; // Only relevant for video files (their natural duration)
  enableOriginalAudio?: boolean; // If true, keep video sound and duck bg music
  collageData?: CollageData; // If this media is a generated collage, store its editable state
  overlayText?: CanvasItem; // Legacy: Single text overlay
  overlayEffects?: CanvasItem[]; // New: Multiple stickers/effects
  transition?: TransitionType; // New: Per-slide transition settings
}

export interface AudioTrack {
  file?: File; // Optional
  url: string;
  name: string;
  duration: number;
  missing?: boolean; // Flag for missing audio
}

export enum TransitionType {
  FADE = 'FADE',
  SLIDE_UP = 'SLIDE_UP',
  SLIDE_DOWN = 'SLIDE_DOWN',
  SLIDE_LEFT = 'SLIDE_LEFT',
  SLIDE_RIGHT = 'SLIDE_RIGHT',
  ZOOM_IN = 'ZOOM_IN',   
  ZOOM_OUT = 'ZOOM_OUT', 
  // RANDOM removed from here as a property type, but used in UI logic
}

export interface VideoSettings {
  photoDuration: number; // Duration for images
  transitionDuration: number; 
  // transitionType removed from global settings, moved to individual media
  resolution: { width: number; height: number };
  collageTitle: string; // Title for the collage intro
}

export enum AppState {
  IDLE = 'IDLE',
  COLLAGE = 'COLLAGE', // New step
  EDITING = 'EDITING',
  RENDERING = 'RENDERING',
  FINISHED = 'FINISHED'
}

// Serialization Types
export interface SavedMediaItem extends Omit<UploadedMedia, 'file' | 'previewUrl'> {
  fileData?: string; // Base64 for collages
}

export interface SavedProject {
  version: number;
  timestamp: number;
  settings: VideoSettings;
  media: SavedMediaItem[];
  rawMedia: SavedMediaItem[]; // Store library references
  audioTracks: Omit<AudioTrack, 'file' | 'url'>[];
}