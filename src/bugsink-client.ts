/**
 * Bugsink API Client
 *
 * Client for interacting with Bugsink's REST API.
 * API docs: https://www.bugsink.com/blog/bugsink-2.0-api/
 */

export interface BugsinkConfig {
  baseUrl: string;
  apiToken: string;
}

export interface PaginatedResponse<T> {
  next: string | null;
  previous: string | null;
  results: T[];
}

export interface Project {
  id: number;
  team: string;
  name: string;
  slug: string;
  dsn: string;
  digested_event_count: number;
  stored_event_count: number;
  alert_on_new_issue: boolean;
  alert_on_regression: boolean;
  alert_on_unmute: boolean;
  visibility: string;
  retention_max_event_count: number;
}

export interface Team {
  id: string;
  name: string;
  visibility: string;
}

export interface Issue {
  id: string;
  project: number;
  digest_order: number;
  first_seen: string;
  last_seen: string;
  digested_event_count: number;
  stored_event_count: number;
  calculated_type: string;
  calculated_value: string;
  transaction: string;
  is_resolved: boolean;
  is_resolved_by_next_release: boolean;
  is_muted: boolean;
}

export interface StackFrame {
  filename: string;
  function: string;
  lineno?: number;
  colno?: number;
  in_app?: boolean;
  context_line?: string;
  pre_context?: string[];
  post_context?: string[];
}

export interface ExceptionValue {
  type: string;
  value: string;
  stacktrace?: {
    frames: StackFrame[];
  };
}

export interface EventData {
  exception?: {
    values?: ExceptionValue[];
  };
  message?: string;
  level?: string;
  platform?: string;
  tags?: Record<string, string>;
  contexts?: Record<string, unknown>;
  request?: {
    url?: string;
    method?: string;
    headers?: Record<string, string>;
  };
  browser?: {
    name?: string;
    version?: string;
  };
  os?: {
    name?: string;
    version?: string;
  };
}

export interface Event {
  id: string;
  event_id: string;
  issue: string;
  project: number;
  timestamp: string;
  ingested_at: string;
  digested_at: string;
  digest_order: number;
  grouping: number;
  data?: EventData;
}

export class BugsinkClient {
  private baseUrl: string;
  private apiToken: string;

  constructor(config: BugsinkConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.apiToken = config.apiToken;
  }

  private async fetch<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}/api/canonical/0${endpoint}`;

    const response = await fetch(url, {
      ...options,
      headers: {
        'Authorization': `Bearer ${this.apiToken}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Bugsink API error (${response.status}): ${errorText}`);
    }

    return response.json() as Promise<T>;
  }

  /**
   * List all projects
   */
  async listProjects(): Promise<PaginatedResponse<Project>> {
    return this.fetch<PaginatedResponse<Project>>('/projects/');
  }

  /**
   * Get a specific project by ID
   */
  async getProject(projectId: number): Promise<Project> {
    return this.fetch<Project>(`/projects/${projectId}/`);
  }

  /**
   * List all teams
   */
  async listTeams(): Promise<PaginatedResponse<Team>> {
    return this.fetch<PaginatedResponse<Team>>('/teams/');
  }

  /**
   * List issues for a project
   */
  async listIssues(projectId: number, options?: {
    status?: string;
    limit?: number;
  }): Promise<PaginatedResponse<Issue>> {
    const params = new URLSearchParams();
    params.set('project', projectId.toString());

    if (options?.status) {
      params.set('status', options.status);
    }
    if (options?.limit) {
      params.set('limit', options.limit.toString());
    }

    return this.fetch<PaginatedResponse<Issue>>(`/issues/?${params.toString()}`);
  }

  /**
   * Get a specific issue by ID
   */
  async getIssue(issueId: string): Promise<Issue> {
    return this.fetch<Issue>(`/issues/${issueId}/`);
  }

  /**
   * List events for an issue
   */
  async listEvents(issueId: string, options?: {
    limit?: number;
  }): Promise<PaginatedResponse<Event>> {
    const params = new URLSearchParams();
    params.set('issue', issueId);

    if (options?.limit) {
      params.set('limit', options.limit.toString());
    }

    return this.fetch<PaginatedResponse<Event>>(`/events/?${params.toString()}`);
  }

  /**
   * Get a specific event by ID
   */
  async getEvent(eventId: string): Promise<Event> {
    return this.fetch<Event>(`/events/${eventId}/`);
  }

  /**
   * Test connection to Bugsink instance
   */
  async testConnection(): Promise<{ success: boolean; message: string }> {
    try {
      const projects = await this.listProjects();
      return {
        success: true,
        message: `Connected successfully. Found ${projects.results.length} project(s).`,
      };
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }
}
