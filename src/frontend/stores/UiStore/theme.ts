export const ThumbnailSizes = ['small', 'medium', 'large'] as const;
export type ThumbnailSize = (typeof ThumbnailSizes)[number] | number;

export const ThumbnailShapes = ['square', 'letterbox'] as const;
export type ThumbnailShape = (typeof ThumbnailShapes)[number];

export const ThumbnailTagOverlayModes = ['all', 'selected', 'disabled'] as const;
export type ThumbnailTagOverlayModeType = (typeof ThumbnailTagOverlayModes)[number];

export const InheritedTagsVisibilityModes = ['all', 'visible-when-inherited', 'disabled'] as const;
export type InheritedTagsVisibilityModeType = (typeof InheritedTagsVisibilityModes)[number];

export const UpscaleModes = ['smooth', 'pixelated'] as const;
export type UpscaleMode = (typeof UpscaleModes)[number];

export const GalleryVideoPlaybackModes = ['auto', 'hover', 'disabled'] as const;
export type GalleryVideoPlaybackMode = (typeof GalleryVideoPlaybackModes)[number];

export const Themes = ['light', 'dark'] as const;
export type Theme = (typeof Themes)[number];

export const ScrollbarsStyles = ['classic', 'hover'] as const;
export type ScrollbarsStyle = (typeof ScrollbarsStyles)[number];
