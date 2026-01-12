#!/usr/bin/env node

/**
 * Bugsink MCP Server
 *
 * A Model Context Protocol server for interacting with Bugsink error tracking.
 * Allows LLM tools like Claude and Cursor to query issues, events, and projects.
 *
 * @see https://www.bugsink.com/
 * @see https://modelcontextprotocol.io/
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { BugsinkClient, type Issue, type Event, type Release } from "./bugsink-client.js";

// Environment configuration
const BUGSINK_URL = process.env.BUGSINK_URL;
const BUGSINK_TOKEN = process.env.BUGSINK_TOKEN;

if (!BUGSINK_URL || !BUGSINK_TOKEN) {
  console.error("Error: BUGSINK_URL and BUGSINK_TOKEN environment variables are required");
  console.error("");
  console.error("Set them in your MCP configuration:");
  console.error('  "env": {');
  console.error('    "BUGSINK_URL": "https://your-bugsink-instance.com",');
  console.error('    "BUGSINK_TOKEN": "your-api-token"');
  console.error('  }');
  process.exit(1);
}

// Initialize client
const client = new BugsinkClient({
  baseUrl: BUGSINK_URL,
  apiToken: BUGSINK_TOKEN,
});

// Initialize MCP server
const server = new McpServer({
  name: "bugsink-mcp",
  version: "0.2.0",
});

// Helper to derive status from issue flags
function getIssueStatus(issue: Issue): string {
  if (issue.is_resolved) return 'resolved';
  if (issue.is_muted) return 'muted';
  return 'unresolved';
}

// Helper to format issue for display
function formatIssue(issue: Issue): string {
  return [
    `[${issue.calculated_type}] ${issue.calculated_value}`,
    `  ID: ${issue.id}`,
    `  Status: ${getIssueStatus(issue)}`,
    `  Occurrences: ${issue.digested_event_count}`,
    `  First seen: ${issue.first_seen}`,
    `  Last seen: ${issue.last_seen}`,
    issue.transaction ? `  Transaction: ${issue.transaction}` : null,
  ].filter(Boolean).join('\n');
}

// Helper to format event for display
function formatEvent(event: Event, includeStacktrace = false): string {
  const lines = [
    `Event ${event.id}`,
    `  Event ID: ${event.event_id}`,
    `  Timestamp: ${event.timestamp}`,
    `  Ingested: ${event.ingested_at}`,
  ];

  // If we have detailed event data
  if (event.data) {
    const data = event.data;

    if (data.level) {
      lines.push(`  Level: ${data.level}`);
    }
    if (data.platform) {
      lines.push(`  Platform: ${data.platform}`);
    }
    if (data.message) {
      lines.push(`  Message: ${data.message}`);
    }

    if (data.exception?.values) {
      lines.push('  Exception:');
      for (const exc of data.exception.values) {
        lines.push(`    ${exc.type}: ${exc.value}`);
        if (includeStacktrace && exc.stacktrace?.frames) {
          lines.push('    Stacktrace (most recent first):');
          // Show most recent frames first (reverse order)
          const frames = [...exc.stacktrace.frames].reverse().slice(0, 15);
          for (const frame of frames) {
            const loc = frame.lineno ? `:${frame.lineno}` : '';
            const col = frame.colno ? `:${frame.colno}` : '';
            lines.push(`      ${frame.filename}${loc}${col} in ${frame.function}`);
            if (frame.context_line) {
              lines.push(`        > ${frame.context_line.trim()}`);
            }
          }
        }
      }
    }

    if (data.request?.url) {
      lines.push(`  Request: ${data.request.method || 'GET'} ${data.request.url}`);
    }

    if (data.browser?.name) {
      lines.push(`  Browser: ${data.browser.name} ${data.browser.version || ''}`);
    }

    if (data.os?.name) {
      lines.push(`  OS: ${data.os.name} ${data.os.version || ''}`);
    }
  }

  return lines.join('\n');
}

// ============================================================================
// Tool Definitions
// ============================================================================

// List Projects
server.tool(
  "list_projects",
  "List all projects in the Bugsink instance",
  {},
  async () => {
    const response = await client.listProjects();

    if (response.results.length === 0) {
      return {
        content: [{ type: "text", text: "No projects found." }],
      };
    }

    const text = response.results.map(p =>
      `- ${p.name} (ID: ${p.id}, slug: ${p.slug})\n  Events: ${p.stored_event_count} stored, ${p.digested_event_count} digested`
    ).join('\n');

    return {
      content: [{ type: "text", text: `Found ${response.results.length} project(s):\n\n${text}` }],
    };
  }
);

// List Teams
server.tool(
  "list_teams",
  "List all teams in the Bugsink instance",
  {},
  async () => {
    const response = await client.listTeams();

    if (response.results.length === 0) {
      return {
        content: [{ type: "text", text: "No teams found." }],
      };
    }

    const text = response.results.map(t =>
      `- ${t.name} (ID: ${t.id}, visibility: ${t.visibility})`
    ).join('\n');

    return {
      content: [{ type: "text", text: `Found ${response.results.length} team(s):\n\n${text}` }],
    };
  }
);

// List Issues
server.tool(
  "list_issues",
  "List issues for a specific project. Issues represent grouped error occurrences.",
  {
    project_id: z.number().describe("The project ID to list issues for"),
    status: z.string().optional().describe("Filter by status (e.g., 'unresolved', 'resolved', 'muted')"),
    limit: z.number().optional().default(25).describe("Maximum number of issues to return (default: 25)"),
    sort: z.enum(['digest_order', 'last_seen']).optional().describe("Sort mode: 'digest_order' or 'last_seen' (default: digest_order)"),
    order: z.enum(['asc', 'desc']).optional().describe("Sort order: 'asc' or 'desc' (default: desc)"),
  },
  async ({ project_id, status, limit, sort, order }) => {
    const response = await client.listIssues(project_id, { status, limit, sort, order });

    if (response.results.length === 0) {
      return {
        content: [{ type: "text", text: `No issues found for project ${project_id}.` }],
      };
    }

    const text = response.results.map(formatIssue).join('\n\n');

    return {
      content: [{ type: "text", text: `Found ${response.results.length} issue(s):\n\n${text}` }],
    };
  }
);

// Get Issue Details
server.tool(
  "get_issue",
  "Get detailed information about a specific issue",
  {
    issue_id: z.string().describe("The issue ID (UUID) to retrieve"),
  },
  async ({ issue_id }) => {
    const issue = await client.getIssue(issue_id);

    const text = formatIssue(issue);

    return {
      content: [{ type: "text", text }],
    };
  }
);

// List Events
server.tool(
  "list_events",
  "List events (individual error occurrences) for a specific issue. Returns basic event info.",
  {
    issue_id: z.string().describe("The issue ID (UUID) to list events for"),
    limit: z.number().optional().default(10).describe("Maximum number of events to return (default: 10)"),
  },
  async ({ issue_id, limit }) => {
    const response = await client.listEvents(issue_id, { limit });

    if (response.results.length === 0) {
      return {
        content: [{ type: "text", text: `No events found for issue ${issue_id}.` }],
      };
    }

    const text = response.results.map(e => formatEvent(e, false)).join('\n\n---\n\n');

    return {
      content: [{ type: "text", text: `Found ${response.results.length} event(s):\n\n${text}` }],
    };
  }
);

// Get Event Details
server.tool(
  "get_event",
  "Get detailed information about a specific event, including full stacktrace and context",
  {
    event_id: z.string().describe("The event ID (UUID) to retrieve"),
  },
  async ({ event_id }) => {
    const event = await client.getEvent(event_id);

    const lines = [formatEvent(event, true)];

    if (event.data?.tags && Object.keys(event.data.tags).length > 0) {
      lines.push('');
      lines.push('Tags:');
      lines.push(JSON.stringify(event.data.tags, null, 2));
    }

    if (event.data?.contexts && Object.keys(event.data.contexts).length > 0) {
      lines.push('');
      lines.push('Contexts:');
      lines.push(JSON.stringify(event.data.contexts, null, 2));
    }

    return {
      content: [{ type: "text", text: lines.join('\n') }],
    };
  }
);

// Test Connection
server.tool(
  "test_connection",
  "Test the connection to the Bugsink instance",
  {},
  async () => {
    const result = await client.testConnection();

    return {
      content: [{
        type: "text",
        text: result.success
          ? `Connection successful: ${result.message}`
          : `Connection failed: ${result.message}`
      }],
    };
  }
);

// Get Project Details
server.tool(
  "get_project",
  "Get detailed information about a specific project including DSN",
  {
    project_id: z.number().describe("The project ID to retrieve"),
  },
  async ({ project_id }) => {
    const project = await client.getProject(project_id);

    const text = [
      `Project: ${project.name}`,
      `  ID: ${project.id}`,
      `  Slug: ${project.slug}`,
      `  Team: ${project.team}`,
      `  DSN: ${project.dsn}`,
      `  Visibility: ${project.visibility}`,
      `  Events: ${project.stored_event_count} stored, ${project.digested_event_count} digested`,
      `  Retention: ${project.retention_max_event_count} max events`,
      `  Alerts:`,
      `    New issue: ${project.alert_on_new_issue}`,
      `    Regression: ${project.alert_on_regression}`,
      `    Unmute: ${project.alert_on_unmute}`,
    ].join('\n');

    return {
      content: [{ type: "text", text }],
    };
  }
);

// ============================================================================
// Mutation Tools
// ============================================================================

// Create Project
server.tool(
  "create_project",
  "Create a new project in a team",
  {
    team_id: z.string().describe("The team UUID to create the project in"),
    name: z.string().describe("The project name"),
    visibility: z.enum(['joinable', 'discoverable', 'team_members']).optional().default('team_members').describe("Project visibility"),
    alert_on_new_issue: z.boolean().optional().default(true).describe("Send alerts for new issues"),
    alert_on_regression: z.boolean().optional().default(true).describe("Send alerts for regressions"),
    alert_on_unmute: z.boolean().optional().default(true).describe("Send alerts when issues are unmuted"),
  },
  async ({ team_id, name, visibility, alert_on_new_issue, alert_on_regression, alert_on_unmute }) => {
    const project = await client.createProject({
      team: team_id,
      name,
      visibility,
      alert_on_new_issue,
      alert_on_regression,
      alert_on_unmute,
    });

    return {
      content: [{
        type: "text",
        text: `Project created successfully:\n  Name: ${project.name}\n  ID: ${project.id}\n  DSN: ${project.dsn}`
      }],
    };
  }
);

// Update Project
server.tool(
  "update_project",
  "Update an existing project's settings",
  {
    project_id: z.number().describe("The project ID to update"),
    name: z.string().optional().describe("New project name"),
    visibility: z.enum(['joinable', 'discoverable', 'team_members']).optional().describe("Project visibility"),
    alert_on_new_issue: z.boolean().optional().describe("Send alerts for new issues"),
    alert_on_regression: z.boolean().optional().describe("Send alerts for regressions"),
    alert_on_unmute: z.boolean().optional().describe("Send alerts when issues are unmuted"),
    retention_max_event_count: z.number().optional().describe("Maximum events to retain"),
  },
  async ({ project_id, ...updates }) => {
    // Filter out undefined values
    const input = Object.fromEntries(
      Object.entries(updates).filter(([_, v]) => v !== undefined)
    );

    const project = await client.updateProject(project_id, input);

    return {
      content: [{
        type: "text",
        text: `Project updated successfully:\n  Name: ${project.name}\n  ID: ${project.id}\n  Visibility: ${project.visibility}`
      }],
    };
  }
);

// Create Team
server.tool(
  "create_team",
  "Create a new team",
  {
    name: z.string().describe("The team name"),
    visibility: z.enum(['joinable', 'discoverable', 'hidden']).optional().default('discoverable').describe("Team visibility"),
  },
  async ({ name, visibility }) => {
    const team = await client.createTeam({ name, visibility });

    return {
      content: [{
        type: "text",
        text: `Team created successfully:\n  Name: ${team.name}\n  ID: ${team.id}\n  Visibility: ${team.visibility}`
      }],
    };
  }
);

// Update Team
server.tool(
  "update_team",
  "Update an existing team",
  {
    team_id: z.string().describe("The team UUID to update"),
    name: z.string().optional().describe("New team name"),
    visibility: z.enum(['joinable', 'discoverable', 'hidden']).optional().describe("Team visibility"),
  },
  async ({ team_id, name, visibility }) => {
    const input = Object.fromEntries(
      Object.entries({ name, visibility }).filter(([_, v]) => v !== undefined)
    );

    const team = await client.updateTeam(team_id, input);

    return {
      content: [{
        type: "text",
        text: `Team updated successfully:\n  Name: ${team.name}\n  ID: ${team.id}\n  Visibility: ${team.visibility}`
      }],
    };
  }
);

// ============================================================================
// Stacktrace Tools
// ============================================================================

// Get Event Stacktrace (Markdown)
server.tool(
  "get_stacktrace",
  "Get an event's stacktrace as pre-rendered Markdown. More readable than raw frame data.",
  {
    event_id: z.string().describe("The event ID (UUID) to get stacktrace for"),
  },
  async ({ event_id }) => {
    const markdown = await client.getEventStacktrace(event_id);

    return {
      content: [{ type: "text", text: markdown }],
    };
  }
);

// ============================================================================
// Release Tools
// ============================================================================

// List Releases
server.tool(
  "list_releases",
  "List releases for a project. Releases help track which version introduced or fixed issues.",
  {
    project_id: z.number().describe("The project ID to list releases for"),
  },
  async ({ project_id }) => {
    const response = await client.listReleases(project_id);

    if (response.results.length === 0) {
      return {
        content: [{ type: "text", text: `No releases found for project ${project_id}.` }],
      };
    }

    const text = response.results.map(r =>
      `- ${r.version || '(empty)'} (ID: ${r.id})\n  Released: ${r.date_released}`
    ).join('\n');

    return {
      content: [{ type: "text", text: `Found ${response.results.length} release(s):\n\n${text}` }],
    };
  }
);

// Get Release Details
server.tool(
  "get_release",
  "Get detailed information about a specific release",
  {
    release_id: z.string().describe("The release ID (UUID) to retrieve"),
  },
  async ({ release_id }) => {
    const release = await client.getRelease(release_id);

    const text = [
      `Release: ${release.version || '(empty)'}`,
      `  ID: ${release.id}`,
      `  Project: ${release.project}`,
      `  Released: ${release.date_released}`,
      release.semver ? `  Semver: ${release.semver}` : null,
      release.is_semver !== undefined ? `  Is Semver: ${release.is_semver}` : null,
    ].filter(Boolean).join('\n');

    return {
      content: [{ type: "text", text }],
    };
  }
);

// Create Release
server.tool(
  "create_release",
  "Create a new release for a project",
  {
    project_id: z.number().describe("The project ID to create the release for"),
    version: z.string().describe("The release version string (e.g., '1.0.0', 'v2.3.1')"),
    timestamp: z.string().optional().describe("Release timestamp (ISO 8601 format). Defaults to now."),
  },
  async ({ project_id, version, timestamp }) => {
    const release = await client.createRelease({
      project: project_id,
      version,
      timestamp,
    });

    return {
      content: [{
        type: "text",
        text: `Release created successfully:\n  Version: ${release.version}\n  ID: ${release.id}\n  Released: ${release.date_released}`
      }],
    };
  }
);

// ============================================================================
// Server Startup
// ============================================================================

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Log to stderr to avoid interfering with MCP protocol on stdout
  console.error("Bugsink MCP server started");
  console.error(`Connected to: ${BUGSINK_URL}`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
