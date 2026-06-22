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
