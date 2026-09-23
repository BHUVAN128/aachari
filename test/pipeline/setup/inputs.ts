import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { CreateRunInput, Domain, SourceInput } from "@upcraft/contracts";

/**
 * Named mock inputs for the step harness. Each entry is a frozen, local source
 * that a step can be run against without touching the network or production data.
 * A `url` variant is retained so the URL-extraction path can be exercised when an
 * https fixture server is provided; it is not part of the default step run.
 */
export type HarnessInputName =
  | "photosynthesis"
  | "photosynthesis-sourceless"
  | "adversarial-segmentation"
  | "medical-adjacent";

const mockDir = (name: string) => fileURLToPath(new URL(`./mock-inputs/${name}`, import.meta.url));

export const readMockSource = async (name: string): Promise<string> => readFile(mockDir(name), "utf8");

export type HarnessInput = {
  name: HarnessInputName;
  topic: string;
  learningLevel: string;
  audienceCategory: "school" | "college" | "other";
  /** Only the approved domain set; medical topics are standard, not a domain. */
  domain: Domain;
  durationSeconds: number;
  visualProfile: string;
  sourceFile: string;
};

export const HARNESS_INPUTS: Record<HarnessInputName, HarnessInput> = {
  photosynthesis: {
    name: "photosynthesis",
    topic: "How photosynthesis works",
    learningLevel: "Primary school, ages 9-11",
    audienceCategory: "school",
    domain: "standard",
    durationSeconds: 120,
    visualProfile: "clean whiteboard science explainer",
    sourceFile: "photosynthesis.txt",
  },
  // Source-less run: the Brave web-research path only runs when the user supplied
  // no source, so this input carries no source file.
  "photosynthesis-sourceless": {
    name: "photosynthesis-sourceless",
    topic: "How photosynthesis works",
    learningLevel: "Primary school, ages 9-11",
    audienceCategory: "school",
    domain: "standard",
    durationSeconds: 120,
    visualProfile: "clean whiteboard science explainer",
    sourceFile: "",
  },
  "adversarial-segmentation": {
    name: "adversarial-segmentation",
    topic: "Photosynthesis definitions and stages",
    learningLevel: "Secondary school, ages 12-15",
    audienceCategory: "school",
    domain: "standard",
    durationSeconds: 150,
    visualProfile: "clean whiteboard science explainer",
    sourceFile: "adversarial-segmentation.txt",
  },
  "medical-adjacent": {
    name: "medical-adjacent",
    topic: "Beta-adrenergic blockers (educational overview)",
    learningLevel: "Medical school, years 1-2",
    audienceCategory: "college",
    domain: "standard",
    durationSeconds: 180,
    visualProfile: "clean clinical teaching whiteboard",
    sourceFile: "medical-adjacent.txt",
  },
};

export const buildRunInput = async (name: HarnessInputName): Promise<CreateRunInput> => {
  const input = HARNESS_INPUTS[name];
  const sources: SourceInput[] = input.sourceFile ? [{ kind: "text", name: input.sourceFile, value: await readMockSource(input.sourceFile) }] : [];
  return {
    topic: input.topic,
    learningLevel: input.learningLevel,
    audienceCategory: input.audienceCategory,
    language: "en",
    durationSeconds: input.durationSeconds,
    aspectRatio: "16:9",
    domain: input.domain,
    visualProfile: input.visualProfile,
    requestedDestination: "local",
    sources,
  };
};