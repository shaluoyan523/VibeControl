import { WorkspaceEntityKind, WorkspaceReferenceKind, WorkspaceRelatedEntity } from "./workspaceEntities";

const META_PREFIX = "<!-- vibe-control-meta";
const META_SUFFIX = "-->";

export interface WorkspaceNoteMeta {
  kind: "note";
  title?: string;
  related?: WorkspaceRelatedEntity[];
  template?: "blank" | "capture";
  source?: string;
}

export interface WorkspaceTaskDraftMeta {
  kind: "task-draft";
  title?: string;
  related?: WorkspaceRelatedEntity[];
  draftStatus?: "todo" | "doing" | "done";
  sourceNotePath?: string;
}

export type WorkspaceArtifactMeta = WorkspaceNoteMeta | WorkspaceTaskDraftMeta;

export interface ParsedWorkspaceArtifact<TMeta extends WorkspaceArtifactMeta> {
  meta: TMeta | null;
  body: string;
}

export function parseWorkspaceArtifact<TMeta extends WorkspaceArtifactMeta>(content: string): ParsedWorkspaceArtifact<TMeta> {
  const match = content.match(new RegExp("^<!--\\s*vibe-control-meta\\s*\\n([\\s\\S]*?)\\n-->\\s*\\n?"));
  if (!match) {
    return {
      meta: null,
      body: content,
    };
  }

  const rawMeta = match[1];
  let meta: TMeta | null = null;
  try {
    meta = JSON.parse(rawMeta) as TMeta;
  } catch {
    meta = null;
  }

  return {
    meta,
    body: content.slice(match[0].length),
  };
}

export function buildWorkspaceArtifact<TMeta extends WorkspaceArtifactMeta>(meta: TMeta, body: string): string {
  return `${META_PREFIX}\n${JSON.stringify(meta, null, 2)}\n${META_SUFFIX}\n\n${body.trim()}\n`;
}

export function relationSummary(related: WorkspaceRelatedEntity[]): string {
  return related.map(item => `${item.kind}:${item.title}`).join(" · ");
}

export function createRelatedEntity(input: {
  kind: WorkspaceReferenceKind;
  id: string;
  title: string;
  description?: string;
  provider?: "claude" | "codex";
  absolutePath?: string;
}): WorkspaceRelatedEntity {
  return {
    kind: input.kind,
    id: input.id,
    title: input.title,
    description: input.description,
    provider: input.provider,
    absolutePath: input.absolutePath,
  };
}
