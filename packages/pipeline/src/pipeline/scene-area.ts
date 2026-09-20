/** Maps a canvas to the deterministic diagram area. Shared by asset production and spatial layout. */
export const sceneDiagramArea = (canvas: { width: number; height: number }) => ({
  x: Math.round(canvas.width * 0.12),
  y: Math.round(canvas.height * 0.28),
  width: Math.round(canvas.width * 0.76),
  height: Math.round(canvas.height * 0.48),
});