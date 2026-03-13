export interface ClaudeSession {
  sessionId: string;
  summary: string;
  lastModified: number;
  fileSize: number;
  cwd?: string;
  gitBranch?: string;
  customTitle?: string;
  firstPrompt?: string;
}

export interface ProjectGroup {
  dirName: string;
  sessions: ClaudeSession[];
}
