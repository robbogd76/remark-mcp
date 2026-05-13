# rm-mcp

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server that connects AI assistants to a **reMarkable tablet** over its local USB/Wi-Fi HTTP interface.

Once configured, you can ask Claude (or any MCP-capable client) to browse your tablet's documents and read them — the server fetches the PDF from the tablet and renders each page as an image that the AI can see.

## Prerequisites

- **Node.js** 18 or later
- A **reMarkable tablet** connected via USB cable (or the same Wi-Fi network) with the USB web interface enabled
  - On the tablet: *Settings → Storage → USB web interface* — make sure it is turned on
  - The tablet must be reachable at `http://10.11.99.1` (the default USB address)

## Installation

```bash
git clone <repo-url>
cd remark-mcp
npm install
```

## Connecting to Claude Code

Add the server to your Claude Code MCP configuration. In your project's `.claude/settings.json` (or the global `~/.claude/settings.json`):

```json
{
  "mcpServers": {
    "remarkable": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/remark-mcp/index.js"],
      "env": {
        "RM_MCP_LOG": "info",
        "RM_MCP_LOG_FILE": "/absolute/path/to/remark-mcp/rm-mcp.log"
      }
    }
  }
}
```

> **Important:** The `command` field must be the **full path to the `node` executable** — Claude Code does not inherit your shell's `PATH`, so a bare `node` will fail. Find the path with `which node` (macOS/Linux) or `where node` (Windows).

Restart Claude Code after saving. You should see `remarkable` listed as an available MCP server.

## Available Tools

| Tool | Description |
|------|-------------|
| `list_root` | List all files and folders in the root of the tablet |
| `list_folder` | List the contents of a folder by its ID |
| `download_pdf` | Download a document as a PDF and return each page as an image |

### Example prompts

```
List everything on my reMarkable tablet.
Open the folder called "Work" and show me what's inside.
Show me the document "Meeting Notes" from my tablet.
```

The `download_pdf` tool renders every page of the document as a PNG image at 2× viewport scale, so Claude can read handwritten notes and printed text.

## Environment Variables

| Variable | Values | Default | Description |
|----------|--------|---------|-------------|
| `RM_MCP_LOG` | `debug`, `info`, `error`, `silent` | `silent` | Log verbosity |
| `RM_MCP_LOG_FILE` | file path | *(stderr)* | Write logs to a file instead of stderr |

> **Note:** stdout is reserved for the MCP protocol wire format. All logging goes to stderr or to `RM_MCP_LOG_FILE`. Never redirect stdout to a file when running the server.

## Running

The server uses the MCP stdio transport. It is normally launched automatically by the MCP client (Claude Code), but you can start it manually to test:

```bash
npm start
# or
node index.js
```

## Utility Script

`fetch-pdf.js` is a standalone script for downloading a single PDF directly to disk — useful for debugging connectivity before using the MCP server:

```bash
node fetch-pdf.js <document-id>
# saves <document-id>.pdf in the current directory
```

## Tests

```bash
npm test
```

Tests use Node's built-in test runner (`node:test`) and stub out all external dependencies (network, PDF renderer, MCP SDK) so they run without a tablet attached.

## Windows Notes

The server patches the `pdf-to-png-converter` path normalisation at runtime so that `pdfjs-dist` asset URLs use forward slashes on Windows. No manual changes to `node_modules` are required.
