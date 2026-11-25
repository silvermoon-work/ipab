import type { ComponentType } from "react";

export type BundleViewer = ComponentType<{ data: unknown }>;
export const viewerMarker = "<!--ipab:viewer-->";
export const stateMarker = "<!--ipab:state-->";
export const identifierPrefix = "ipab-viewer-";
