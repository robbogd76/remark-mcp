#!/usr/bin/env node
"use strict";

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { z } = require("zod");
const fs = require("node:fs");
const http = require("node:http");
const axios = require("axios");
const { pdfToPng } = require("pdf-to-png-converter");

// pdf-to-png-converter uses path.sep to build pdfjs-dist asset URLs, which
// produces backslashes on Windows. pdfjs-dist validates that these URLs end
// with a forward slash and rejects them if they don't. Patch the normalizePath
// export in the module cache before the first pdfToPng call so the fix applies
// without modifying node_modules source files.
{
  const npMod = require("./node_modules/pdf-to-png-converter/out/normalizePath.js");
  const orig = npMod.normalizePath;
  npMod.normalizePath = (p) => orig(p).replace(/\\/g, "/");
}

// Passes insecureHTTPParser to Node's http.request, allowing non-compliant
// HTTP responses from the reMarkable tablet.
const insecureTransport = {
  request: (options, callback) => {
    options.insecureHTTPParser = true;
    return http.request(options, callback);
  },
};

const BASE_URL = "http://10.11.99.1";

// ---------------------------------------------------------------------------
// Logger — writes to a file when RM_MCP_LOG_FILE is set, otherwise stderr.
// stdout is reserved for the MCP protocol and must never be used for logging.
// Set RM_MCP_LOG=debug for verbose output, RM_MCP_LOG=info for request/tool
// summaries only.  Logging is silent by default.
// ---------------------------------------------------------------------------
const LOG_LEVELS = { debug: 0, info: 1, error: 2, silent: 3 };
const logLevel = LOG_LEVELS[process.env.RM_MCP_LOG] ?? LOG_LEVELS.silent;
const logFile = process.env.RM_MCP_LOG_FILE ?? null;

function log(level, ...args) {
  if (LOG_LEVELS[level] < logLevel) return;
  const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${args.join(" ")}\n`;
  if (logFile) {
    fs.appendFileSync(logFile, line);
  } else {
    process.stderr.write(line);
  }
}

// Fetch JSON from the reMarkable web interface
async function fetchDocuments(path) {
  const url = `${BASE_URL}${path}`;
  log("debug", `GET ${url}`);
  const t0 = Date.now();
  const res = await axios.get(url, { timeout: 10000 });
  log("debug", `GET ${url} -> ${res.status} (${Date.now() - t0}ms)`);
  return res.data;
}

// Fetch a PDF as a Buffer from the reMarkable web interface
async function fetchPdf(id) {
  const url = `${BASE_URL}/download/${id}/pdf`;
  log("debug", `GET ${url}`);
  const t0 = Date.now();
  const res = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: 30000,
    transport: insecureTransport,
  });
  log("debug", `GET ${url} -> ${res.status} (${Date.now() - t0}ms)`);
  const buf = Buffer.from(res.data);
  log("debug", `PDF download complete: ${buf.length} bytes`);
  return buf;
}

// Format a list of reMarkable document entries as readable text
function formatEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return "No items found.";
  }
  return entries
    .map((entry) => {
      const type = entry.Type === "CollectionType" ? "[folder]" : "[file]";
      const name = entry.VissibleName ?? entry.VisibleName ?? entry.ID;
      const modified = entry.ModifiedClient ? `  modified: ${entry.ModifiedClient}` : "";
      return `${type} ${name}  (id: ${entry.ID})${modified}`;
    })
    .join("\n");
}

const server = new McpServer({
  name: "remarkable-mcp",
  version: "1.0.0",
});

// Tool: list root documents/folders
server.tool(
  "list_root",
  "List all files and folders in the root of the reMarkable tablet.",
  {},
  async () => {
    log("info", "tool list_root called");
    try {
      const entries = await fetchDocuments("/documents/");
      log("info", `tool list_root -> ${entries.length} entries`);
      return { content: [{ type: "text", text: formatEntries(entries) }] };
    } catch (err) {
      log("error", `tool list_root failed: ${err.message}`);
      throw err;
    }
  }
);

// Tool: list contents of a folder by ID
server.tool(
  "list_folder",
  "List the contents of a folder on the reMarkable tablet by its ID.",
  { id: z.string().describe("The ID of the folder to list.") },
  async ({ id }) => {
    log("info", `tool list_folder called id=${id}`);
    try {
      const entries = await fetchDocuments(`/documents/${id}`);
      log("info", `tool list_folder id=${id} -> ${entries.length} entries`);
      return { content: [{ type: "text", text: formatEntries(entries) }] };
    } catch (err) {
      log("error", `tool list_folder id=${id} failed: ${err.message}`);
      throw err;
    }
  }
);

// Tool: download a document as PDF
server.tool(
  "download_pdf",
  "Download a document from the reMarkable tablet as a PDF, returned as base64-encoded data.",
  {
    id: z.string().describe("The ID of the document to download as PDF."),
    name: z.string().optional().describe("Optional display name for the document."),
  },
  async ({ id, name }) => {
    log("info", `tool download_pdf called id=${id} name=${name ?? "(none)"}`);
    try {
      const pdfBuffer = await fetchPdf(id);
      const label = name ? `${name}.pdf` : `${id}.pdf`;
      log("info", `tool download_pdf id=${id} -> ${pdfBuffer.length} bytes, rendering pages`);
      const pages = await pdfToPng(pdfBuffer, { viewportScale: 2.0 });
      log("info", `tool download_pdf id=${id} -> ${pages.length} pages rendered`);
      return {
        content: [
          {
            type: "text",
            text: `Document: ${label} (${pages.length} pages)`,
          },
          ...pages.map((page) => ({
            type: "image",
            data: page.content.toString("base64"),
            mimeType: "image/png",
          })),
        ],
      };
    } catch (err) {
      log("error", `tool download_pdf id=${id} failed: ${err.message}`);
      throw err;
    }
  }
);

async function main() {
  log("info", `remarkable-mcp starting (RM_MCP_LOG=${process.env.RM_MCP_LOG ?? "silent"})`);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("info", "remarkable-mcp connected and ready");
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err.message}\n`);
  process.exit(1);
});
