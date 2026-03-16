// @ts-nocheck
import { app } from "electron"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import * as z from "zod"
import os from "node:os"
import path from "node:path"

import { createAgentBridgeService, AgentBridgeBusyError, AgentBridgeInputError } from "./bridge"

function buildBridgeCommand() {
  if (app.isPackaged) {
    return {
      command: process.execPath,
      args: ["--agent-bridge-mcp"]
    }
  }

  return {
    command: process.execPath,
    args: [app.getAppPath(), "--agent-bridge-mcp"]
  }
}

function successResult(payload: unknown, text: string) {
  return {
    content: [
      {
        type: "text" as const,
        text
      }
    ],
    structuredContent: payload as Record<string, unknown>
  }
}

function errorResult(payload: Record<string, unknown>, text: string) {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text
      }
    ],
    structuredContent: payload
  }
}

export async function runAgentBridgeMcpServer() {
  await app.whenReady()
  app.dock?.hide()

  const bridge = createAgentBridgeService({
    dataDir: app.getPath("userData"),
    codexHome: path.join(os.homedir(), ".codex"),
    claudeHome: path.join(os.homedir(), ".claude"),
    bridgeCommand: buildBridgeCommand()
  })

  const server = new McpServer({
    name: "handoff-agent-bridge",
    version: "0.1.0"
  })

  server.registerTool(
    "health",
    {
      description: "Return Handoff agent bridge status and entrypoint details."
    },
    async () => {
      const status = await bridge.getStatus()
      return successResult(status, "Bridge is ready.")
    }
  )

  server.registerTool(
    "list_agents",
    {
      description: "List saved Handoff agents available through the bridge."
    },
    async () => {
      const agents = await bridge.listAgents()
      return successResult(
        { agents },
        agents.length > 0 ? `Found ${agents.length} agents.` : "No saved agents."
      )
    }
  )

  server.registerTool(
    "get_agent",
    {
      description: "Get one saved Handoff agent by id or exact name.",
      inputSchema: z.object({
        agentId: z.string().optional(),
        agentName: z.string().optional()
      })
    },
    async ({ agentId, agentName }) => {
      const agent = await bridge.getAgent({ agentId, agentName })

      if (!agent) {
        return errorResult(
          {
            code: "invalid_agent",
            agentId: agentId ?? null,
            agentName: agentName ?? null
          },
          "Agent not found."
        )
      }

      return successResult({ agent }, `Resolved agent ${agent.name}.`)
    }
  )

  server.registerTool(
    "ask_agent",
    {
      description:
        "Send one message to a saved Handoff agent and return one final answer.",
      inputSchema: z.object({
        agentId: z.string().optional(),
        agentName: z.string().optional(),
        message: z.string(),
        projectPath: z.string(),
        context: z.string().optional(),
        timeoutSec: z.number().int().positive().max(1800).nullable().optional(),
        caller: z.union([z.string(), z.record(z.unknown())]).optional()
      })
    },
    async args => {
      try {
        const result = await bridge.askAgent(args)
        return successResult(
          result,
          result.answer ?? "Agent finished without returning an answer."
        )
      } catch (error) {
        if (error instanceof AgentBridgeBusyError) {
          return errorResult(
            {
              code: error.code,
              runId: error.info.runId,
              startedAt: error.info.startedAt
            },
            error.message
          )
        }

        if (error instanceof AgentBridgeInputError) {
          return errorResult(
            {
              code: error.code
            },
            error.message
          )
        }

        return errorResult(
          {
            code: "execution_failed"
          },
          error instanceof Error ? error.message : "Agent execution failed."
        )
      }
    }
  )

  server.registerTool(
    "list_agent_runs",
    {
      description: "List persisted Handoff agent bridge runs.",
      inputSchema: z.object({
        agentId: z.string().optional(),
        limit: z.number().int().positive().max(200).optional()
      })
    },
    async ({ agentId, limit }) => {
      const runs = await bridge.listRuns(agentId, limit)
      return successResult(
        { runs },
        runs.length > 0 ? `Found ${runs.length} runs.` : "No runs found."
      )
    }
  )

  server.registerTool(
    "get_agent_run",
    {
      description: "Get one persisted Handoff agent bridge run by id.",
      inputSchema: z.object({
        runId: z.string()
      })
    },
    async ({ runId }) => {
      const run = await bridge.getRun(runId)
      if (!run) {
        return errorResult(
          {
            code: "run_not_found",
            runId
          },
          "Run not found."
        )
      }

      return successResult({ run }, `Loaded run ${runId}.`)
    }
  )

  const transport = new StdioServerTransport()
  transport.onclose = () => {
    void server.close().finally(() => {
      app.exit(0)
    })
  }
  await server.connect(transport)
}
