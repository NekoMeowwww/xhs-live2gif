export type JobStatus = "queued" | "processing" | "done" | "failed";

export interface JobPayload {
  jobId: string;
  url: string;
  clientIp: string;
  submittedAt: string;
}

export interface GifResult {
  name: string;
  url: string;
}

export interface JobResult {
  status: JobStatus;
  noteId?: string;
  gifs?: GifResult[];
  zipUrl?: string;
  message?: string;
  error?: string;
}

export interface HealthStatus {
  sessionOk: boolean;
  lastChecked: string;
  detail?: string;
}

// One entry per account+chrome+worker instance (see AGENTS.md "横向扩容").
// Overall sessionOk is true only when every known instance is healthy —
// any one account being down still means a slice of incoming jobs will fail.
export interface AggregateHealthStatus {
  sessionOk: boolean;
  instances: Record<string, HealthStatus>;
}

export type JobStage = "extracting" | "downloading" | "converting" | "uploading";

export interface JobProgress {
  percent: number;
  stage: JobStage;
  current?: number;
  total?: number;
}
