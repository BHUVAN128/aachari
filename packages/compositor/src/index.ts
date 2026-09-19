import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import type { ProjectManifest } from "@upcraft/contracts";

export * from "./diagrams.ts";
export * from "./probe.ts";

export type RenderInput = { title: string; manifest: ProjectManifest; audioUrl: string; outputPath: string };

const entryPoint = fileURLToPath(new URL("./entry.tsx", import.meta.url));
let cachedBundle: Promise<string> | undefined;

const getBundle = () => {
  cachedBundle ??= bundle({ entryPoint, webpackOverride: (config) => config });
  return cachedBundle;
};

export const renderLesson = async ({ title, manifest, audioUrl, outputPath }: RenderInput) => {
  await mkdir(dirname(outputPath), { recursive: true });
  const serveUrl = await getBundle();
  const inputProps = { title, manifest, audioUrl };
  const composition = await selectComposition({ serveUrl, id: "Lesson", inputProps });
  await renderMedia({
    serveUrl,
    composition,
    inputProps,
    codec: "h264",
    audioCodec: "aac",
    outputLocation: resolve(outputPath),
    imageFormat: "jpeg",
    concurrency: "50%",
    logLevel: "warn",
  });
};
