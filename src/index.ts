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
import { BugsinkClient, type Issue, type Event } from "./bugsink-client.js";

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
  version: "0.1.0",
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
  },
  async ({ project_id, status, limit }) => {
    const response = await client.listIssues(project_id, { status, limit });

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
